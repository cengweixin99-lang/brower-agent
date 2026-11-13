import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import {
  defaultRunBudget,
  type ObservationSnapshot,
  parseObservationSnapshot,
  type SessionView,
} from "../packages/contracts/src/runtime/index.ts";
import { createDatabasePool } from "../packages/persistence/src/index.ts";
import { RuntimeStore } from "../packages/persistence/src/runtime.ts";
import { actionFixture, actionTests } from "./runtime-actions.ts";

test("real gateway sessions: context reuse, cancellation, restart isolation and bounded network", {
  timeout: 100_000,
}, async (t) => {
  assert.ok(process.env.DATABASE_URL);
  const schema = `test_sessions_${randomUUID().replaceAll("-", "")}`;
  const admin = createDatabasePool(process.env.DATABASE_URL);
  await admin.query(`CREATE SCHEMA ${schema}`);
  const database = new URL(process.env.DATABASE_URL);
  database.searchParams.set("options", `-csearch_path=${schema}`);
  database.searchParams.set("application_name", schema);
  const pool = createDatabasePool(database.href);
  const store = new RuntimeStore(pool);
  await store.initialize();
  const hits = new Map<string, number>();
  let slowConnected = false;
  const fixture = createServer((request, response) => {
    const path = request.url ?? "/";
    hits.set(path, (hits.get(path) ?? 0) + 1);
    if (path === "/slow") {
      slowConnected = true;
      response.on("close", () => {
        slowConnected = false;
      });
      return;
    }
    if (path === "/redirect") {
      response.writeHead(302, { location: "http://127.0.0.1:1/private" });
      response.end();
      return;
    }
    response.writeHead(200, { "content-type": "text/html" });
    const actionPage = actionFixture(path);
    if (actionPage) {
      response.end(actionPage);
      return;
    }
    if (path === "/observed") {
      response.end(
        `<html><head><title>Observed fixture</title></head><body><h1>Visible heading</h1><p hidden>Hidden marker</p><p aria-hidden="true">Aria hidden marker</p><label>Search<input name="query" placeholder="Query"></label><button>Find</button><button disabled>Disabled button</button><input type="password" value="synthetic-secret"><iframe src="/child" title="Child frame"></iframe></body></html>`,
      );
      return;
    }
    if (path === "/child" || path === "/child-next") {
      response.end(
        `<html><body><p>${path === "/child" ? "Child content" : "Changed child"}</p><button>Child action</button></body></html>`,
      );
      return;
    }
    if (path === "/changing" || path === "/child-changing") {
      response.end(
        `<html><head><meta http-equiv="refresh" content="3;url=${path === "/changing" ? "/changed" : "/child-next"}"></head><body><button>Before navigation</button></body></html>`,
      );
      return;
    }
    if (path === "/frame-changing") {
      response.end(
        '<html><body><button>Parent action</button><iframe src="/child-changing"></iframe></body></html>',
      );
      return;
    }
    if (path === "/changed") {
      response.end("<html><body><button>After navigation</button></body></html>");
      return;
    }
    if (path === "/large") {
      response.end(
        `<html><body><p>${"visible ".repeat(5000)}</p>${Array.from({ length: 1050 }, (_, index) => `<button>Choice ${index}</button>`).join("")}</body></html>`,
      );
      return;
    }
    if (path === "/visibility-changing") {
      response.end(
        "<html><head><style>@keyframes hide { to { visibility: hidden; } } button { animation: hide 1ms 2s forwards; }</style></head><body><button>Temporary action</button></body></html>",
      );
      return;
    }
    response.end(
      `<html><head><title>Session ${hits.get(path)}</title></head><body>Persistent browser page<script>fetch('/side-effect',{method:'POST'})</script></body></html>`,
    );
  });
  await new Promise<void>((resolve) => fixture.listen(0, "127.0.0.1", resolve));
  const address = fixture.address();
  assert.ok(address && typeof address === "object");
  const origin = `http://127.0.0.1:${address.port}`;
  const portProbe = createServer();
  await new Promise<void>((resolve) => portProbe.listen(0, "127.0.0.1", resolve));
  const gatewayAddress = portProbe.address();
  assert.ok(gatewayAddress && typeof gatewayAddress === "object");
  const gatewayPort = gatewayAddress.port;
  await new Promise<void>((resolve) => portProbe.close(() => resolve()));
  const gatewayOrigin = `http://127.0.0.1:${gatewayPort}`;
  const token = randomUUID();
  const root = fileURLToPath(new URL("../", import.meta.url));
  await mkdir(`${root}.data/test-logs`, { recursive: true });
  const artifactRoot = await mkdtemp(`${root}.data/p04-artifacts-`);
  const processes: ChildProcess[] = [];
  function launch(): ChildProcess {
    const child = spawn(process.execPath, ["apps/browser-worker/src/main.ts"], {
      cwd: root,
      env: {
        ...process.env,
        DATABASE_URL: database.href,
        BROWSER_HOST: "127.0.0.1",
        BROWSER_PORT: String(gatewayPort),
        BROWSER_GATEWAY_TOKEN: token,
        BROWSER_ALLOWED_ORIGINS: origin,
        RUNTIME_ARTIFACT_ROOT: artifactRoot,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const log = createWriteStream(`${root}.data/test-logs/runtime-session-${processes.length}.log`);
    child.stdout?.pipe(log);
    child.stderr?.pipe(log);
    processes.push(child);
    return child;
  }
  async function until(read: () => Promise<boolean>, description: string): Promise<void> {
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      try {
        if (await read()) return;
      } catch {
        /* Startup and disconnects are expected. */
      }
      await delay(50);
    }
    throw new Error(`Timed out: ${description}; see .data/test-logs/runtime-session-*.log`);
  }
  async function healthy(): Promise<void> {
    await until(
      async () => (await fetch(`${gatewayOrigin}/healthz`, { signal: AbortSignal.timeout(1000) })).ok,
      "gateway healthy",
    );
  }
  async function terminate(child: ChildProcess): Promise<void> {
    if (child.exitCode !== null || child.signalCode !== null) return;
    child.kill("SIGTERM");
    await until(async () => child.exitCode !== null || child.signalCode !== null, "graceful gateway exit");
  }
  function post(path: string, body: unknown, authenticated = true): Promise<Response> {
    return fetch(`${gatewayOrigin}/runtime/sessions/${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(authenticated ? { authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });
  }
  function input(runId: string) {
    return { protocolVersion: 1, workspaceId: "local", runId, executionEpoch: 1 };
  }
  async function observe(runId: string): Promise<ObservationSnapshot> {
    const response = await post("observe", input(runId));
    assert.equal(response.status, 200, await response.clone().text());
    return parseObservationSnapshot(await response.json());
  }
  function target(snapshot: ObservationSnapshot) {
    const element = snapshot.observation.elements[0];
    assert.ok(element);
    return {
      observationId: snapshot.observation.observationId,
      documentId: snapshot.observation.documentId,
      frameId: element.frameId,
      elementId: element.elementId,
    };
  }
  function artifact(runId: string, artifactId: string, workspaceId = "local"): Promise<Response> {
    return fetch(`${gatewayOrigin}/runtime/artifacts/read`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ protocolVersion: 1, workspaceId, runId, artifactId }),
    });
  }
  async function seed(runId: string, path = "/page"): Promise<void> {
    await store.create(
      {
        protocolVersion: 1,
        workspaceId: "local",
        taskId: `task-${runId}`,
        goal: "Read fixture page",
        startUrl: `${origin}${path}`,
        allowedOrigins: [origin],
        acceptance: ["Read title"],
        budget: defaultRunBudget,
      },
      runId,
    );
  }
  async function stop(runId: string): Promise<Response> {
    const current = await store.get("local", runId);
    assert.ok(current);
    return post("stop", {
      protocolVersion: 1,
      workspaceId: "local",
      runId,
      commandId: randomUUID(),
      expectedVersion: current.version,
    });
  }
  let gateway = launch();
  try {
    await healthy();
    await t.test("authenticated requests keep the same tab without another navigation", async () => {
      await seed("first");
      assert.equal((await post("open", input("first"), false)).status, 401);
      assert.equal((await post("open", { ...input("first"), ownerId: "forged" })).status, 400);
      const responses = await Promise.all([post("open", input("first")), post("open", input("first"))]);
      assert.ok(responses.every((response) => response.ok));
      const first = (await responses[0]?.json()) as SessionView;
      const second = (await responses[1]?.json()) as SessionView;
      assert.equal(first.session.sessionId, second.session.sessionId);
      assert.equal(first.tabId, second.tabId);
      assert.equal(first.title, "Session 1");
      for (let index = 0; index < 3; index++) {
        const response = await post("status", input("first"));
        assert.equal(response.status, 200);
        const view = (await response.json()) as SessionView;
        assert.equal(view.tabId, first.tabId);
        assert.equal(view.title, first.title);
      }
      assert.equal(hits.get("/page"), 1);
      assert.equal(hits.get("/side-effect"), undefined);
      assert.equal((await post("status", { ...input("first"), workspaceId: "other" })).status, 409);
      assert.equal((await post("status", { ...input("first"), executionEpoch: 2 })).status, 409);
      await seed("competitor");
      assert.equal((await post("open", input("competitor"))).status, 409);
      assert.equal((await stop("first")).status, 200);
      assert.equal((await store.get("local", "first"))?.status, "stopped");
      assert.equal((await post("status", input("first"))).status, 409);
      assert.equal((await post("open", input("first"))).status, 409);
      assert.equal((await post("open", input("competitor"))).status, 200);
      await stop("competitor");
    });
    await t.test(
      "stop during initial navigation aborts the request before acknowledging release",
      async () => {
        await seed("slow", "/slow");
        const opening = post("open", input("slow"));
        await until(async () => slowConnected, "initial page loading");
        assert.equal((await stop("slow")).status, 200);
        assert.equal((await opening).status, 409);
        await until(async () => !slowConnected, "fixture socket closed");
        assert.equal((await store.getSession("local", "slow"))?.state, "closed");
        assert.equal((await store.get("local", "slow"))?.status, "stopped");
      },
    );
    await t.test("out-of-policy redirects fail and release the slot", async () => {
      await seed("redirect", "/redirect");
      assert.equal((await post("open", input("redirect"))).status, 409);
      assert.equal((await store.get("local", "redirect"))?.status, "failed");
      assert.equal((await store.getSession("local", "redirect"))?.state, "closed");
    });
    await t.test(
      "observations capture visible text, frame elements and committed PNGs; old references expire",
      async () => {
        await seed("observed", "/observed");
        assert.equal((await post("open", input("observed"))).status, 200);
        const first = await observe("observed");
        assert.equal(first.frames.length, 2);
        assert.ok(first.observation.text.includes("Visible heading"));
        assert.ok(first.observation.text.includes("Child content"));
        assert.equal(/Hidden marker|Aria hidden marker|synthetic-secret/.test(JSON.stringify(first)), false);
        assert.ok(
          first.observation.elements.some(
            (element) => element.name === "Search" && element.role === "textbox",
          ),
        );
        assert.ok(first.observation.elements.some((element) => element.name === "Find"));
        assert.ok(
          first.observation.elements.some(
            (element) => element.name === "Child action" && element.frameId !== first.frames[0]?.frameId,
          ),
        );
        assert.equal(
          first.observation.elements.some((element) => element.name === "Disabled button"),
          false,
        );
        assert.deepEqual(await new RuntimeStore(pool).latestObservation("local", "observed"), first);
        const artifactId = first.observation.screenshotArtifactId;
        assert.ok(artifactId);
        const image = await artifact("observed", artifactId);
        assert.equal(image.status, 200);
        assert.equal(image.headers.get("content-type"), "image/png");
        const png = Buffer.from(await image.arrayBuffer());
        assert.equal(png.subarray(1, 4).toString(), "PNG");
        assert.equal(png.readUInt32BE(16), 1280);
        assert.equal(png.readUInt32BE(20), 800);
        await mkdir(`${root}.data/screenshots`, { recursive: true });
        await writeFile(`${root}.data/screenshots/p04-observation.png`, png);
        assert.equal((await artifact("observed", artifactId, "other")).status, 404);
        assert.equal((await artifact("first", artifactId)).status, 404);
        assert.equal(
          (await post("validate-target", { ...input("observed"), target: target(first) })).status,
          200,
        );
        assert.equal(
          (
            await post("validate-target", {
              ...input("observed"),
              target: { ...target(first), elementId: "element-9999" },
            })
          ).status,
          409,
        );
        const second = await observe("observed");
        assert.equal(second.sequence, first.sequence + 1);
        assert.equal(second.observation.documentId, first.observation.documentId);
        assert.notEqual(second.observation.observationId, first.observation.observationId);
        assert.equal(
          (await post("validate-target", { ...input("observed"), target: target(first) })).status,
          409,
        );
        assert.equal(
          (await post("validate-target", { ...input("observed"), target: target(second) })).status,
          200,
        );
        const disk = `${artifactRoot}/${artifactId}.png`;
        const original = await readFile(disk);
        await writeFile(disk, "tampered");
        assert.equal((await artifact("observed", artifactId)).status, 404);
        await writeFile(disk, original);
        await stop("observed");
        assert.equal((await post("observe", input("observed"))).status, 409);
        assert.equal(
          (await post("validate-target", { ...input("observed"), target: target(second) })).status,
          409,
        );
        assert.equal(
          (await artifact("observed", artifactId)).status,
          200,
          "Historical evidence remains readable after stop",
        );
      },
    );
    await t.test("main document navigation invalidates references without a new observation", async () => {
      await seed("changing", "/changing");
      assert.equal((await post("open", input("changing"))).status, 200);
      const first = await observe("changing");
      await until(async () => Boolean(hits.get("/changed")), "native meta refresh");
      await until(
        async () =>
          (await post("validate-target", { ...input("changing"), target: target(first) })).status === 409,
        "old document reference rejected",
      );
      const next = await observe("changing");
      assert.notEqual(next.observation.documentId, first.observation.documentId);
      assert.ok(next.observation.elements.some((element) => element.name === "After navigation"));
      await stop("changing");
    });
    await t.test("child frame navigation invalidates the entire page snapshot", async () => {
      await seed("frame-changing", "/frame-changing");
      assert.equal((await post("open", input("frame-changing"))).status, 200);
      const first = await observe("frame-changing");
      await until(async () => Boolean(hits.get("/child-next")), "child frame refresh");
      await until(
        async () =>
          (await post("validate-target", { ...input("frame-changing"), target: target(first) })).status ===
          409,
        "parent reference rejected after child refresh",
      );
      const next = await observe("frame-changing");
      assert.equal(next.observation.documentId, first.observation.documentId);
      assert.ok(next.observation.text.includes("Changed child"));
      await stop("frame-changing");
    });
    await t.test(
      "large observations enforce text and element limits with an explicit truncation flag",
      async () => {
        await seed("large", "/large");
        assert.equal((await post("open", input("large"))).status, 200);
        const snapshot = await observe("large");
        assert.equal(snapshot.truncated, true);
        assert.equal(snapshot.observation.text.length, 30_000);
        assert.equal(snapshot.observation.elements.length, 1000);
        await stop("large");
      },
    );
    await t.test("CSS visibility changes invalidate a target without a DOM mutation", async () => {
      await seed("visibility-changing", "/visibility-changing");
      assert.equal((await post("open", input("visibility-changing"))).status, 200);
      const first = await observe("visibility-changing");
      assert.equal(
        (await post("validate-target", { ...input("visibility-changing"), target: target(first) })).status,
        200,
      );
      await until(
        async () =>
          (await post("validate-target", { ...input("visibility-changing"), target: target(first) }))
            .status === 409,
        "CSS-hidden target rejected",
      );
      const next = await observe("visibility-changing");
      assert.equal(next.observation.documentId, first.observation.documentId);
      assert.equal(next.observation.elements.length, 0);
      await stop("visibility-changing");
    });
    const checkActionReplay = await actionTests(t, {
      store,
      origin,
      hits,
      post,
      seed,
      observe,
      stop,
      until,
      slowConnected: () => slowConnected,
    });
    await t.test(
      "graceful restart closes the context and persists failure instead of silently rerunning",
      async () => {
        await seed("shutdown");
        assert.equal((await post("open", input("shutdown"))).status, 200);
        await terminate(gateway);
        assert.equal((await store.get("local", "shutdown"))?.status, "failed");
        assert.equal((await store.getSession("local", "shutdown"))?.state, "closed");
        gateway = launch();
        await healthy();
        assert.equal((await post("open", input("shutdown"))).status, 409);
        await checkActionReplay();
      },
    );
    await t.test(
      "owner connection loss closes Chromium; restart quarantines durable ownership until isolation is confirmed",
      async () => {
        await seed("owner-loss");
        assert.equal((await post("open", input("owner-loss"))).status, 200);
        const lease = await store.getSession("local", "owner-loss");
        assert.ok(lease);
        const owner = await admin.query<{ pid: number }>(
          "SELECT l.pid FROM pg_locks l JOIN pg_stat_activity a ON a.pid=l.pid WHERE l.locktype='advisory' AND l.objid=724921 AND a.application_name=$1",
          [schema],
        );
        assert.equal(owner.rowCount, 1);
        await admin.query("SELECT pg_terminate_backend($1)", [owner.rows[0]?.pid]);
        // The gateway's ownership-loss handler awaits browser.close() before exiting.
        await until(
          async () => gateway.exitCode !== null || gateway.signalCode !== null,
          "owner loss shuts down gateway/browser",
        );
        gateway = launch();
        await healthy();
        assert.equal((await store.getSession("local", "owner-loss"))?.state, "quarantined");
        assert.equal((await post("open", input("owner-loss"))).status, 409);
        await seed("after-loss");
        assert.equal((await post("open", input("after-loss"))).status, 409);
        await stop("owner-loss");
        assert.equal((await store.get("local", "owner-loss"))?.status, "stopping");
        // Trusted harness has confirmed old browser shutdown; production needs an isolation authority.
        await store.closed(lease, "session_lost");
        assert.equal((await store.get("local", "owner-loss"))?.status, "stopped");
        assert.equal((await post("open", input("after-loss"))).status, 200);
        await stop("after-loss");
      },
    );
  } finally {
    for (const child of processes.reverse()) {
      try {
        await terminate(child);
      } catch {
        child.kill("SIGKILL");
      }
    }
    fixture.closeAllConnections();
    await new Promise<void>((resolve) => fixture.close(() => resolve()));
    await pool.end();
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.end();
    await rm(artifactRoot, { recursive: true, force: true });
  }
});
