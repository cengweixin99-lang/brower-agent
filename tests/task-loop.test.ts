import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import { createServer } from "node:http";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { chromium } from "../packages/browser/src/index.ts";
import type { Task, TaskSummary } from "../packages/contracts/src/index.ts";
import { createDatabasePool } from "../packages/persistence/src/index.ts";

// Uses an isolated Postgres schema, Temporal queue and local fixture; never calls a model/provider.
test("real task loop: capture, idempotency, stop, refresh, API/worker/gateway recovery", {
  timeout: 180_000,
}, async () => {
  assert.ok(process.env.DATABASE_URL, "Run with --env-file=.env after pnpm infra:up");
  const schema = `test_${randomUUID().replaceAll("-", "")}`;
  const admin = createDatabasePool(process.env.DATABASE_URL);
  await admin.query(`CREATE SCHEMA ${schema}`);
  const db = new URL(process.env.DATABASE_URL);
  db.searchParams.set("options", `-csearch_path=${schema}`);
  const root = fileURLToPath(new URL("../", import.meta.url));
  await mkdir(new URL("../.data/test-logs/", import.meta.url), { recursive: true });
  process.env.PLAYWRIGHT_BROWSERS_PATH = `${root}.data/browsers`;
  const hits = new Map<string, number>();
  const pending = new Map<string, () => void>();
  const fixture = createServer((request, response) => {
    const path = request.url ?? "/";
    hits.set(path, (hits.get(path) ?? 0) + 1);
    if (path === "/redirect-private") {
      response.writeHead(302, { location: "http://127.0.0.1:33100/healthz" });
      response.end();
      return;
    }
    if (path === "/error") {
      response.writeHead(500);
      response.end("Unavailable");
      return;
    }
    const send = () => {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(
        `<!doctype html><html><head><title>Fixture ${path}</title><style>body{font:20px system-ui;padding:60px;background:#f8fafc}article{background:white;padding:40px;border:1px solid #ddd;border-radius:12px}h1{font-size:40px}</style></head><body><article><h1>Research source ${path}</h1><h2>Verified page content</h2><p>Actual browser capture marker ${path}. This text comes from the HTTP server, not a UI timer.</p><script>fetch('/side-effect',{method:'POST'})</script></article></body></html>`,
      );
    };
    if (path.startsWith("/slow")) {
      pending.set(path, send);
      response.on("close", () => pending.delete(path));
    } else send();
  });
  await new Promise<void>((resolve) => fixture.listen(0, "127.0.0.1", resolve));
  const address = fixture.address();
  assert.ok(address && typeof address === "object");
  const origin = `http://127.0.0.1:${address.port}`;
  const env = {
    ...process.env,
    DATABASE_URL: db.href,
    API_PORT: "33100",
    BROWSER_PORT: "33101",
    BROWSER_ALLOWED_ORIGINS: origin,
    TEMPORAL_TASK_QUEUE: schema,
    WEB_ORIGINS: "http://127.0.0.1:5174",
  };
  const processes: ChildProcess[] = [];
  function launch(name: string, args: string[], cwd = root) {
    const child = spawn(process.execPath, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    const log = createWriteStream(`${root}.data/test-logs/${name}.log`);
    child.stdout?.pipe(log);
    child.stderr?.pipe(log);
    processes.push(child);
    return child;
  }
  async function terminate(child: ChildProcess, signal: NodeJS.Signals = "SIGTERM") {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
    child.kill(signal);
    await Promise.race([
      exited,
      delay(6000).then(() => {
        child.kill("SIGKILL");
      }),
    ]);
    await exited;
  }
  const base = "http://127.0.0.1:33100";
  async function json<T>(path: string, body?: unknown): Promise<T> {
    const response = await fetch(`${base}${path}`, {
      ...(body === undefined
        ? {}
        : { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } }),
      signal: AbortSignal.timeout(5000),
    });
    assert.ok(response.ok, `${response.status} ${await response.clone().text()}`);
    return response.json() as Promise<T>;
  }
  async function until<T>(
    read: () => Promise<T>,
    matches: (value: T) => boolean,
    description: string,
  ): Promise<T> {
    const deadline = Date.now() + 35_000;
    while (Date.now() < deadline) {
      try {
        const result = await read();
        if (matches(result)) return result;
      } catch {
        /* Server startup/restart is expected. */
      }
      await delay(150);
    }
    throw new Error(`Timed out: ${description}; inspect .data/test-logs`);
  }
  const get = (id: string) => json<Task>(`/tasks/${id}`);
  const create = (paths: string[], title: string) =>
    json<Task>("/tasks", {
      id: randomUUID(),
      prompt: `${title}\n${paths.map((path) => `${origin}${path}`).join("\n")}`,
    });
  let apiProcess = launch("api", ["apps/api/src/main.ts"]);
  let gateway = launch("gateway", ["apps/browser-worker/src/main.ts"]);
  let worker: ChildProcess | undefined;
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  try {
    await until(
      () => json<{ status: string }>("/healthz"),
      (value) => value.status === "ok",
      "API startup",
    );
    await until(
      () => fetch("http://127.0.0.1:33101/healthz"),
      (response) => response.ok,
      "gateway startup",
    );
    assert.equal(
      (
        await fetch("http://127.0.0.1:33101/read", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{}",
        })
      ).status,
      401,
    );
    assert.equal(
      (await fetch(`${base}/tasks`, { headers: { origin: "https://untrusted.example" } })).status,
      403,
    );
    const queued = await create(["/never-start"], "Stop before worker starts");
    assert.equal((await json<Task>(`/tasks/${queued.id}/stop`, {})).status, "stopped");
    worker = launch("worker", ["apps/worker/src/main.ts"]);
    const completed = await create(["/first", "/second"], "Real page collection");
    const duplicate = await json<Task>("/tasks", { id: completed.id, prompt: completed.prompt });
    assert.equal(duplicate.id, completed.id);
    const result = await until(
      () => get(completed.id),
      (task) => task.status === "completed",
      "real capture completes",
    );
    assert.equal(result.sources.length, 2);
    assert.match(result.sources[0]?.text ?? "", /Actual browser capture marker \/first/);
    assert.equal(hits.get("/first"), 1);
    assert.equal(hits.get("/second"), 1);
    assert.equal(hits.get("/never-start"), undefined);
    assert.equal(hits.get("/side-effect"), undefined);
    const report = await fetch(`${base}/tasks/${result.id}/report`);
    assert.match(await report.text(), /Actual browser capture marker/);
    const screenshot = Buffer.from(
      await (await fetch(`${base}/tasks/${result.id}/sources/source-1/screenshot`)).arrayBuffer(),
    );
    assert.equal(screenshot.subarray(1, 4).toString(), "PNG");
    const stable = await json<Task>(`/tasks/${result.id}/stop`, {});
    assert.deepEqual(stable, result);
    console.log(
      "PASS: real browser text + PNG + report; idempotent submission; queued stop; script side effects blocked",
    );

    launch(
      "web",
      ["node_modules/vite/bin/vite.js", "--host", "127.0.0.1", "--port", "5174", "--strictPort"],
      `${root}apps/web`,
    );
    await until(
      () => fetch("http://127.0.0.1:5174"),
      (response) => response.ok,
      "web startup",
    );
    browser = await chromium.launch({ channel: "chromium", headless: true });
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(`http://127.0.0.1:5174/#task/${result.id}`);
    await page.getByRole("heading", { name: "Your source report is ready." }).waitFor();
    await page.reload();
    await page.getByRole("heading", { name: "Your source report is ready." }).waitFor();
    assert.equal((await json<{ tasks: TaskSummary[] }>("/tasks")).tasks.length, 2);
    await mkdir(`${root}.data/screenshots/task-loop`, { recursive: true });
    await page.screenshot({ path: `${root}.data/screenshots/task-loop/completed.png`, fullPage: true });

    await page.goto("http://127.0.0.1:5174/#new");
    await page
      .getByRole("textbox", { name: "Describe a task" })
      .fill(
        `Stop while reading a later page\n${origin}/before-stop\n${origin}/slow-stop\n${origin}/after-stop`,
      );
    await page.getByRole("button", { name: "Run Task", exact: true }).click();
    await page.waitForURL(/#task\//);
    const slow = await get(page.url().split("#task/")[1] ?? "");
    await until(async () => pending.has("/slow-stop"), Boolean, "second page is actively loading");
    await page.goto(`http://127.0.0.1:5174/#task/${slow.id}`);
    await page.getByRole("button", { name: "Stop", exact: true }).click();
    await page.getByRole("button", { name: "Keep running", exact: true }).click();
    assert.equal((await get(slow.id)).status, "running");
    await page.reload();
    await page.getByRole("button", { name: "Stop", exact: true }).click();
    await page.getByRole("button", { name: "Stop task", exact: true }).click();
    const stopped = await until(
      () => get(slow.id),
      (task) => task.status === "stopped",
      "active browser acknowledges stop",
    );
    assert.equal(stopped.sourceCount, 1);
    assert.equal(pending.has("/slow-stop"), false);
    assert.equal(hits.get("/after-stop"), undefined);
    await page.reload();
    await page.getByText("Task stopped. Browser released.", { exact: false }).waitFor();
    await page.screenshot({ path: `${root}.data/screenshots/task-loop/stopped.png`, fullPage: true });
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForFunction(
      () => (document.querySelector(".sidebar")?.getBoundingClientRect().right ?? 1) <= 0,
    );
    await page.getByRole("button", { name: "Open navigation" }).click();
    await page.getByRole("button", { name: "Close navigation" }).click();
    await page.waitForFunction(
      () => (document.querySelector(".sidebar")?.getBoundingClientRect().right ?? 1) <= 0,
    );
    await page.screenshot({
      path: `${root}.data/screenshots/task-loop/mobile-stopped.png`,
      fullPage: true,
      animations: "disabled",
    });
    assert.ok(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
      "Mobile page should not overflow horizontally",
    );
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page
      .getByRole("navigation", { name: "Main navigation" })
      .getByRole("button", { name: "All Tasks", exact: true })
      .click();
    await page.getByRole("button", { name: "Stopped", exact: false }).click();
    await page.getByRole("button", { name: "Open Stop while reading a later page", exact: true }).click();
    await page.getByText("Task stopped. Browser released.", { exact: false }).waitFor();
    assert.deepEqual(await get(slow.id), stopped);
    console.log(
      "PASS: cancel Stop, stop during later collection, socket closed, partial results retained, refresh/history stable",
    );

    await terminate(apiProcess);
    apiProcess = launch("api-restarted", ["apps/api/src/main.ts"]);
    await until(
      () => get(slow.id),
      (task) => task.status === "stopped",
      "API restart preserves stop",
    );
    assert.deepEqual(await get(result.id), result);
    await page.reload();
    await page.getByText("Task stopped. Browser released.", { exact: false }).waitFor();
    const recovery = await create(["/checkpoint", "/slow-recovery"], "Recover worker checkpoint");
    await until(async () => pending.has("/slow-recovery"), Boolean, "recovery task running");
    await terminate(worker, "SIGKILL");
    pending.get("/slow-recovery")?.();
    worker = launch("worker-restarted", ["apps/worker/src/main.ts"]);
    await until(
      () => get(recovery.id),
      (task) => task.status === "completed",
      "worker restart reconciles captured page",
    );
    assert.equal(hits.get("/checkpoint"), 1);
    assert.equal(hits.get("/slow-recovery"), 1);
    console.log(
      "PASS: API restart restores records; worker restart preserves checkpoints without re-reading completed pages",
    );

    const pauseTask = await create(["/slow-pause", "/after-pause"], "Pause and resume real execution");
    await until(async () => pending.has("/slow-pause"), Boolean, "pause target is reading");
    await page.goto(`http://127.0.0.1:5174/#task/${pauseTask.id}`);
    await page.getByRole("button", { name: "Pause", exact: true }).click();
    await until(
      () => get(pauseTask.id),
      (task) => task.status === "pausing",
      "pause intent persisted",
    );
    assert.ok(pending.has("/slow-pause"), "Pausing lets the current page finish");
    pending.get("/slow-pause")?.();
    const pauseSnapshot = await until(
      () => get(pauseTask.id),
      (task) => task.status === "paused",
      "page checkpoint acknowledges pause",
    );
    assert.equal(pauseSnapshot.sourceCount, 1);
    const competitor = await create(["/competing-task"], "Wait for reserved session");
    await page.reload();
    await page.getByRole("button", { name: "Resume", exact: true }).waitFor();
    await delay(2500);
    assert.deepEqual(
      await get(pauseTask.id),
      pauseSnapshot,
      "Paused snapshot remains stable across polling and reload",
    );
    assert.equal(hits.get("/after-pause"), undefined);
    assert.equal(hits.get("/competing-task"), undefined, "Paused task reserves its session");
    assert.equal((await json<{ busyTaskId: string | null }>("/runtime")).busyTaskId, pauseTask.id);
    await terminate(worker);
    await terminate(gateway);
    gateway = launch("gateway-pause-restart", ["apps/browser-worker/src/main.ts"]);
    worker = launch("worker-pause-restart", ["apps/worker/src/main.ts"]);
    await until(
      () => fetch("http://127.0.0.1:33101/healthz"),
      (response) => response.ok,
      "paused gateway recovery",
    );
    assert.deepEqual(await get(pauseTask.id), pauseSnapshot);
    assert.equal((await json<{ busyTaskId: string | null }>("/runtime")).busyTaskId, pauseTask.id);
    await page.reload();
    await page.getByRole("button", { name: "Resume", exact: true }).click();
    await until(
      () => get(pauseTask.id),
      (task) => task.status === "completed",
      "resume finishes remaining pages",
    );
    await until(
      () => get(competitor.id),
      (task) => task.status === "completed",
      "session released to queued task",
    );
    assert.equal(hits.get("/slow-pause"), 1);
    assert.equal(hits.get("/after-pause"), 1);
    const pauseThenStop = await create(["/slow-pause-stop", "/must-not-read"], "Stop a paused task");
    await until(async () => pending.has("/slow-pause-stop"), Boolean, "stop-pause target active");
    await json<Task>(`/tasks/${pauseThenStop.id}/pause`, {});
    pending.get("/slow-pause-stop")?.();
    await until(
      () => get(pauseThenStop.id),
      (task) => task.status === "paused",
      "second task paused",
    );
    assert.equal((await json<Task>(`/tasks/${pauseThenStop.id}/stop`, {})).status, "stopped");
    assert.equal((await json<Task>(`/tasks/${pauseThenStop.id}/resume`, {})).status, "stopped");
    assert.equal((await json<{ busyTaskId: string | null }>("/runtime")).busyTaskId, null);
    assert.equal(hits.get("/must-not-read"), undefined);
    console.log(
      "PASS: real Pause/Resume, stable refresh, restart while paused, session reservation, no repeated pages, Stop from paused",
    );

    const interrupted = await create(["/slow-gateway"], "Recover stop after gateway crash");
    await until(async () => pending.has("/slow-gateway"), Boolean, "gateway task active");
    await terminate(gateway, "SIGKILL");
    assert.equal((await json<Task>(`/tasks/${interrupted.id}/stop`, {})).status, "stopping");
    gateway = launch("gateway-restarted", ["apps/browser-worker/src/main.ts"]);
    await until(
      () => get(interrupted.id),
      (task) => task.status === "stopped",
      "gateway restart reconciles abandoned lease",
    );
    const failed = await create(["/error"], "HTTP error stays failed");
    await until(
      () => get(failed.id),
      (task) => task.status === "failed",
      "HTTP error persisted",
    );
    const blocked = await create(["/redirect-private"], "Block private redirect");
    await until(
      () => get(blocked.id),
      (task) => task.status === "failed",
      "private redirect blocked",
    );
    assert.deepEqual(errors, []);
    console.log("PASS: gateway crash/stop recovery, failed page state and private redirect protection");
  } finally {
    await browser?.close();
    for (const child of processes.reverse()) await terminate(child);
    fixture.closeAllConnections();
    await new Promise<void>((resolve) => fixture.close(() => resolve()));
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.end();
  }
});
