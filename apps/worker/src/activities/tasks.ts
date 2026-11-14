import { readPageThroughGateway } from "@pba/agent";
import { isTerminal, sourceId } from "@pba/contracts";
import { gatewayToken } from "@pba/credentials";
import { createDatabasePool, TaskStore } from "@pba/persistence";

const pool = createDatabasePool(process.env.DATABASE_URL ?? "");
const store = new TaskStore(pool);
export async function readTaskPage(id: string, index: number): Promise<boolean> {
  const task = await store.get(id);
  if (!task || isTerminal(task.status)) return false;
  if (task.status === "stopping") {
    await store.finish(id);
    return false;
  }
  const response = await readPageThroughGateway(
    { taskId: id, index },
    process.env.BROWSER_GATEWAY_URL ?? `http://127.0.0.1:${process.env.BROWSER_PORT ?? 3101}`,
    await gatewayToken(),
  );
  if (response.status === 410) {
    await store.finish(id);
    return false;
  }
  if (!response.ok) throw new Error(response.status === 409 ? "Browser busy" : "Browser gateway unavailable");
  const latest = await store.get(id);
  return latest !== null && !isTerminal(latest.status) && latest.status !== "stopping";
}
export async function readPausableTaskPage(id: string, index: number): Promise<"advance" | "wait" | "end"> {
  const task = await store.get(id);
  if (!task || isTerminal(task.status)) return "end";
  if (task.status === "stopping") {
    await store.finish(id);
    return "end";
  }
  if (task.status === "paused" || task.status === "pausing") {
    await store.finish(id);
    return "wait";
  }
  const response = await readPageThroughGateway(
    { taskId: id, index },
    process.env.BROWSER_GATEWAY_URL ?? `http://127.0.0.1:${process.env.BROWSER_PORT ?? 3101}`,
    await gatewayToken(),
  );
  if (response.status === 423 || response.status === 409) return "wait";
  if (response.status === 410) {
    await store.finish(id);
    return "end";
  }
  if (!response.ok) throw new Error("Browser gateway unavailable");
  const latest = await store.get(id);
  if (!latest || isTerminal(latest.status) || latest.status === "stopping") return "end";
  return latest.sources.some((source) => source.id === sourceId(index)) ? "advance" : "wait";
}
export async function finishTask(id: string, failed: boolean): Promise<void> {
  await store.finish(
    id,
    failed
      ? "Execution interrupted. The browser service could not finish the task; captured pages were preserved."
      : undefined,
  );
}
export async function closeTaskActivities(): Promise<void> {
  await pool.end();
}
