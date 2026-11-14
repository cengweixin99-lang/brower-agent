import { timingSafeEqual } from "node:crypto";
import { mkdir, rename, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { type BrowserContext, chromium } from "@pba/browser";
import { type BrowserReadInput, type PageSource, sourceId } from "@pba/contracts";
import { ContractError } from "@pba/contracts/runtime";
import { gatewayToken } from "@pba/credentials";
import { createDatabasePool, StoreError, TaskStore } from "@pba/persistence";
import { RuntimeStore } from "@pba/persistence/runtime";
import Fastify from "fastify";
import { readResource } from "./network.ts";
import { registerRuntimeSessions } from "./sessions.ts";

const artifactRoot = new URL("../../../.data/artifacts/", import.meta.url);
const pool = createDatabasePool(process.env.DATABASE_URL ?? "");
const store = new TaskStore(pool);
await store.initialize();
const owner = await pool.connect();
const ownership = await owner.query<{ acquired: boolean }>(
  "SELECT pg_try_advisory_lock(hashtext(current_schema()),724921) AS acquired",
);
if (!ownership.rows[0]?.acquired) throw new Error("A browser gateway is already running");
const browser = await chromium.launch({
  channel: "chromium",
  headless: true,
  handleSIGINT: false,
  handleSIGTERM: false,
  handleSIGHUP: false,
});
owner.on("error", () => {
  void browser.close().finally(() => process.exit(1));
});
await store.recoverGateway();
const token = await gatewayToken();
const allowedOrigins = (process.env.BROWSER_ALLOWED_ORIGINS ?? "").split(",").filter(Boolean);
const server = Fastify({ logger: true, bodyLimit: 4096 });
let shuttingDown = false;
server.setErrorHandler((error, _request, reply) => {
  const status =
    error instanceof ContractError
      ? 400
      : error instanceof StoreError
        ? error.statusCode
        : error instanceof Error && "statusCode" in error && typeof error.statusCode === "number"
          ? error.statusCode
          : 500;
  void reply
    .code(status)
    .send({ error: status < 500 && error instanceof Error ? error.message : "Browser capture failed" });
});
server.addHook("onRequest", async (request, reply) => {
  if (request.url === "/healthz") return;
  const supplied = Buffer.from(request.headers.authorization ?? "");
  const expected = Buffer.from(`Bearer ${token}`);
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected))
    return reply.code(401).send({ error: "Unauthorized" });
});
const runtimeSessions = await registerRuntimeSessions(
  server,
  browser,
  new RuntimeStore(pool),
  allowedOrigins,
);
server.get("/healthz", async () => ({
  service: "browser-worker",
  status: browser.isConnected() ? "ok" : "unavailable",
}));
server.post<{ Body: BrowserReadInput }>(
  "/read",
  {
    schema: {
      body: {
        type: "object",
        additionalProperties: false,
        required: ["taskId", "index"],
        properties: {
          taskId: { type: "string", format: "uuid" },
          index: { type: "integer", minimum: 0, maximum: 4 },
        },
      },
    },
  },
  async (request) => {
    if (shuttingDown || !browser.isConnected()) throw new StoreError("Gateway is restarting", 503);
    const { taskId, index } = request.body;
    const { task, cached } = await store.acquire(taskId, index);
    if (cached) return { status: "captured" };
    let context: BrowserContext | undefined;
    let source: PageSource | null = null;
    let failure: string | null = null;
    let stage = "open_browser";
    let stopping = false;
    const abort = new AbortController();
    let checking = false;
    const timer = setInterval(() => {
      if (checking) return;
      checking = true;
      void store
        .get(taskId)
        .then(async (current) => {
          if (current?.status !== "running" && current?.status !== "pausing") {
            stopping = true;
            abort.abort();
            await context?.close();
          }
        })
        .catch(async () => {
          abort.abort();
          await context?.close();
        })
        .finally(() => {
          checking = false;
        });
    }, 200);
    const deadline = setTimeout(() => {
      abort.abort();
      void context?.close();
    }, 60_000);
    const directory = new URL(`${taskId}/`, artifactRoot);
    const target = new URL(`${sourceId(index)}.png`, directory);
    const temporary = new URL(`${sourceId(index)}.tmp.png`, directory);
    try {
      context = await browser.newContext({
        viewport: { width: 1280, height: 800 },
        javaScriptEnabled: false,
        serviceWorkers: "block",
        acceptDownloads: false,
      });
      const captureContext = context;
      await captureContext.route("**/*", async (route) => {
        const resource = route.request();
        if (
          resource.method() !== "GET" ||
          !["document", "stylesheet", "image", "font"].includes(resource.resourceType())
        ) {
          await route.abort().catch(() => {});
          return;
        }
        try {
          const result = await readResource(resource.url(), allowedOrigins, abort.signal);
          await route.fulfill(result);
        } catch {
          await route.abort().catch(() => {});
        }
      });
      if (stopping) throw new Error("Stopped");
      const page = await captureContext.newPage();
      const url = task.urls[index];
      if (!url) throw new Error("Missing URL");
      stage = "navigate";
      const response = await page.goto(url, { waitUntil: "load", timeout: 45_000 });
      if (!response?.ok()) throw new Error("Page returned an error");
      const contentType = response.headers()["content-type"] ?? "";
      if (!/text\/(html|plain)|application\/xhtml\+xml/i.test(contentType))
        throw new Error("Unsupported page type");
      stage = "extract";
      // biome-ignore lint/performance/useDomNodeTextContent: Capture visible text, excluding hidden content and scripts.
      const text = (await page.locator("body").innerText({ timeout: 5000 })).slice(0, 30_000).trim();
      if (!text) throw new Error("Page has no readable text");
      const headings = (await page.locator("h1,h2,h3").allTextContents())
        .slice(0, 30)
        .map((heading) => heading.trim().slice(0, 200));
      const title = (await page.title()).slice(0, 200) || new URL(url).hostname;
      await mkdir(directory, { recursive: true });
      stage = "screenshot";
      await page.screenshot({ path: fileURLToPath(temporary), type: "png", timeout: 8000 });
      await rename(temporary, target);
      source = {
        id: sourceId(index),
        url: page.url(),
        title,
        text,
        headings,
        capturedAt: new Date().toISOString(),
      };
    } catch (error) {
      server.log.warn(
        {
          stage,
          errorType: error instanceof Error ? error.name : "unknown",
          code:
            error instanceof Error
              ? (error.message.match(/ERR_[A-Z_]+/)?.[0] ?? "capture_failed")
              : "capture_failed",
        },
        "Page capture failed",
      );
      // Never persist raw Playwright errors: they may contain response bodies or credentials.
      failure =
        "Could not capture this page. Check the URL, network access or whether the site requires JavaScript/sign-in.";
    } finally {
      clearInterval(timer);
      clearTimeout(deadline);
      abort.abort();
      await context?.close();
      await rm(temporary, { force: true });
      await store.release(taskId, index, source, failure);
      if (!source || stopping) await rm(target, { force: true });
    }
    return { status: stopping ? "stopped" : source ? "captured" : "failed" };
  },
);
await server.listen({
  host: process.env.BROWSER_HOST ?? "127.0.0.1",
  port: Number(process.env.BROWSER_PORT ?? 3101),
});
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.once(signal, () => {
    shuttingDown = true;
    void server
      .close()
      .then(() => runtimeSessions.close())
      .then(() => browser.close())
      .then(() => owner.release())
      .then(() => pool.end());
  });
