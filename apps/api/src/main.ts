import { readFile } from "node:fs/promises";
import { planUrls } from "@pba/agent";
import { type CreateTaskInput, isTerminal, taskReport } from "@pba/contracts";
import { createDatabasePool, StoreError, TaskStore } from "@pba/persistence";
import { Client, Connection, WorkflowExecutionAlreadyStartedError } from "@temporalio/client";
import Fastify from "fastify";

const pool = createDatabasePool(process.env.DATABASE_URL ?? "");
const store = new TaskStore(pool);
await store.initialize();
const connection = await Connection.connect({ address: process.env.TEMPORAL_ADDRESS ?? "127.0.0.1:7233" });
const namespace = process.env.TEMPORAL_NAMESPACE ?? "default";
const taskQueue = process.env.TEMPORAL_TASK_QUEUE ?? "pba-local";
const client = new Client({ connection, namespace });
const server = Fastify({ logger: true, bodyLimit: 16_384 });
const idPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const port = Number(process.env.API_PORT ?? 3100);
const allowedOrigins = new Set([
  `http://127.0.0.1:${port}`,
  `http://localhost:${port}`,
  "http://localhost:5173",
  "http://127.0.0.1:5173",
  ...(process.env.WEB_ORIGINS ?? "").split(",").filter(Boolean),
]);
server.addHook("onRequest", async (request, reply) => {
  // Local workspace API: do not expose a signed-in user's tasks through another website.
  const host = request.headers.host?.split(":")[0];
  if (
    !host ||
    !["127.0.0.1", "localhost"].includes(host) ||
    (request.headers.origin && !allowedOrigins.has(request.headers.origin))
  )
    return reply.code(403).send({ error: "Origin is not allowed" });
  reply.header("cache-control", "no-store");
});
server.setErrorHandler((error, _request, reply) => {
  const status =
    error instanceof StoreError
      ? error.statusCode
      : error instanceof Error && "statusCode" in error && typeof error.statusCode === "number"
        ? error.statusCode
        : 500;
  void reply.code(status).send({
    error:
      status < 500 && error instanceof Error
        ? error.message
        : "Service unavailable. Your saved task is preserved; retry shortly.",
  });
});
async function getTask(id: string) {
  if (!idPattern.test(id)) throw new StoreError("Invalid task ID", 400);
  const task = await store.get(id);
  if (!task) throw new StoreError("Task not found", 404);
  return task;
}
// tasks is also the durable dispatch outbox: a crash between INSERT and start is repaired here.
let reconciling = false;
async function reconcile(): Promise<void> {
  if (reconciling) return;
  reconciling = true;
  try {
    for (const id of await store.pendingIds()) {
      const task = await store.finish(id);
      if (isTerminal(task.status)) continue;
      try {
        await client.workflow.start(task.executionVersion === 2 ? "executePausableTask" : "executeTask", {
          workflowId: `task-${id}`,
          taskQueue,
          args: [id, task.urls.length],
          workflowIdReusePolicy: "REJECT_DUPLICATE",
        });
      } catch (error) {
        if (!(error instanceof WorkflowExecutionAlreadyStartedError)) continue;
        const execution = await client.workflow.getHandle(`task-${id}`).describe();
        if (["FAILED", "CANCELLED", "TERMINATED", "TIMED_OUT", "COMPLETED"].includes(execution.status.name)) {
          await store.finish(
            id,
            "Execution ended before all pages were captured. Start a new task to retry.",
          );
        }
      }
    }
  } catch {
    server.log.warn("Task dispatch will retry when services reconnect");
  } finally {
    reconciling = false;
  }
}
server.get("/healthz", async () => ({ service: "api", status: "ok" }));
server.get("/runtime", async () => {
  const [browser, workflow] = await Promise.all([
    fetch(`http://127.0.0.1:${process.env.BROWSER_PORT ?? 3101}/healthz`, {
      signal: AbortSignal.timeout(1500),
    })
      .then(
        async (response) => response.ok && ((await response.json()) as { status: string }).status === "ok",
      )
      .catch(() => false),
    connection
      .withDeadline(Date.now() + 1500, () =>
        connection.workflowService.describeTaskQueue({
          namespace,
          taskQueue: { name: taskQueue },
          taskQueueType: 1,
        }),
      )
      .then((result) => (result.pollers?.length ?? 0) > 0)
      .catch(() => false),
  ]);
  return { browser, workflow, busyTaskId: await store.busyTaskId() };
});
server.get("/tasks", async () => ({ tasks: await store.list() }));
server.post<{ Body: CreateTaskInput }>(
  "/tasks",
  {
    schema: {
      body: {
        type: "object",
        additionalProperties: false,
        required: ["id", "prompt"],
        properties: {
          id: { type: "string", format: "uuid" },
          prompt: { type: "string", minLength: 1, maxLength: 6000 },
        },
      },
    },
  },
  async (request, reply) => {
    const prompt = request.body.prompt.trim();
    let urls: string[];
    try {
      urls = planUrls(prompt);
    } catch (error) {
      throw new StoreError(error instanceof Error ? error.message : "Invalid task", 400);
    }
    const task = await store.create(request.body.id.toLowerCase(), prompt, urls);
    void reconcile();
    return reply.code(202).send(task);
  },
);
server.get<{ Params: { id: string } }>("/tasks/:id", async (request) => getTask(request.params.id));
server.post<{ Params: { id: string } }>("/tasks/:id/stop", async (request) => {
  await getTask(request.params.id);
  await store.stop(request.params.id);
  return store.finish(request.params.id);
});
server.post<{ Params: { id: string } }>("/tasks/:id/pause", async (request) => {
  await getTask(request.params.id);
  return store.pause(request.params.id);
});
server.post<{ Params: { id: string } }>("/tasks/:id/resume", async (request) => {
  await getTask(request.params.id);
  const task = await store.resume(request.params.id);
  void reconcile();
  return task;
});
server.get<{ Params: { id: string } }>("/tasks/:id/report", async (request, reply) => {
  const task = await getTask(request.params.id);
  if (!task.sources.length) throw new StoreError("No captured pages yet", 404);
  return reply
    .header("content-disposition", `attachment; filename="${task.id}-report.txt"`)
    .type("text/plain; charset=utf-8")
    .send(taskReport(task));
});
server.get<{ Params: { id: string; source: string } }>(
  "/tasks/:id/sources/:source/screenshot",
  async (request, reply) => {
    const task = await getTask(request.params.id);
    if (!task.sources.some((source) => source.id === request.params.source))
      throw new StoreError("Screenshot not found", 404);
    try {
      const png = await readFile(
        new URL(`../../../.data/artifacts/${task.id}/${request.params.source}.png`, import.meta.url),
      );
      return reply.type("image/png").send(png);
    } catch {
      throw new StoreError("Screenshot unavailable", 404);
    }
  },
);
const timer = setInterval(() => {
  void reconcile();
}, 2000);
await server.listen({ host: process.env.API_HOST ?? "127.0.0.1", port });
void reconcile();
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.once(signal, () => {
    clearInterval(timer);
    void server
      .close()
      .then(() => connection.close())
      .then(() => pool.end());
  });
