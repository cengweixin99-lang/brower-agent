import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import {
  type ActionRequest,
  type AgentTask,
  defaultRunBudget,
  type ObservationSnapshot,
  parseSessionRequest,
  parseStopRunRequest,
} from "@pba/contracts/runtime";
import { createDatabasePool, StoreError, TaskStore } from "./index.ts";
import { ActionLedger, RuntimeStore, unknownReceipt } from "./runtime.ts";

test("runtime store: migrations, durable commands, ownership, quarantine and legacy exclusion", async (t) => {
  assert.ok(process.env.DATABASE_URL);
  const admin = createDatabasePool(process.env.DATABASE_URL);
  const schema = `test_runtime_${randomUUID().replaceAll("-", "")}`;
  await admin.query(`CREATE SCHEMA ${schema}`);
  const url = new URL(process.env.DATABASE_URL);
  url.searchParams.set("options", `-csearch_path=${schema}`);
  const pool = createDatabasePool(url.href);
  const store = new RuntimeStore(pool);
  const legacy = new TaskStore(pool);
  const definition = (taskId: string): AgentTask => ({
    protocolVersion: 1,
    taskId,
    workspaceId: "local",
    goal: "Read a fixture",
    startUrl: "https://example.com/",
    allowedOrigins: ["https://example.com"],
    acceptance: ["Read its title"],
    budget: defaultRunBudget,
  });
  const request = (runId: string) => ({
    protocolVersion: 1 as const,
    workspaceId: "local",
    runId,
    executionEpoch: 1,
  });
  try {
    await t.test("concurrent migrations apply once; checksum drift is rejected", async () => {
      await Promise.all([store.initialize(), new RuntimeStore(pool).initialize(), legacy.initialize()]);
      const rows = await pool.query<{ checksum: string }>(
        "SELECT checksum FROM agent_schema_migrations WHERE version=1",
      );
      assert.equal((await pool.query("SELECT version FROM agent_schema_migrations")).rowCount, 3);
      await pool.query("UPDATE agent_schema_migrations SET checksum='tampered' WHERE version=1");
      await assert.rejects(store.initialize(), /checksum mismatch/);
      await pool.query("UPDATE agent_schema_migrations SET checksum=$1 WHERE version=1", [
        rows.rows[0]?.checksum,
      ]);
      await store.initialize();
    });
    await t.test("create retries are atomic and parameter conflicts do not leave partial rows", async () => {
      const task = definition("task-a");
      const runs = await Promise.all(Array.from({ length: 8 }, () => store.create(task, "run-a")));
      assert.ok(runs.every((run) => run.version === 1 && run.status === "queued"));
      await assert.rejects(store.create({ ...task, goal: "changed" }, "run-a"), StoreError);
      await assert.rejects(store.create(definition("other-task"), "run-a"), StoreError);
      assert.equal((await pool.query("SELECT 1 FROM agent_tasks WHERE task_id='other-task'")).rowCount, 0);
      assert.equal((await pool.query("SELECT 1 FROM agent_events WHERE run_id='run-a'")).rowCount, 1);
      assert.equal((await pool.query("SELECT 1 FROM agent_outbox WHERE run_id='run-a'")).rowCount, 1);
      assert.equal(await store.get("other-workspace", "run-a"), null);
      await assert.rejects(
        store.reserve({ ...request("run-a"), workspaceId: "other-workspace" }, "owner-a"),
        StoreError,
      );
    });
    await t.test("run state and session survive reconnect; stop receipt remains idempotent", async () => {
      const lease = await store.reserve(request("run-a"), "owner-a");
      assert.deepEqual(await store.reserve(request("run-a"), "owner-a"), lease);
      await store.activate(lease);
      const running = await store.get("local", "run-a");
      assert.ok(running);
      assert.equal(running.status, "running");
      assert.equal(running.version, 3);
      await assert.rejects(store.reserve(request("run-a"), "owner-b"), StoreError);
      await assert.rejects(store.reserve({ ...request("run-a"), executionEpoch: 2 }, "owner-a"), StoreError);
      const restored = new RuntimeStore(pool);
      assert.deepEqual(await restored.get("local", "run-a"), running);
      const stopped = await store.requestStop("local", "run-a", "command-a", running.version);
      assert.equal(stopped.status, "stopping");
      assert.equal(stopped.executionEpoch, 2);
      assert.equal(await store.heartbeat(lease), false);
      await assert.rejects(store.activate(lease), StoreError);
      await store.closed({ ...lease, ownerId: "impostor" }, "session_closed");
      assert.equal((await store.getSession("local", "run-a"))?.state, "active");
      await store.closed(lease, "session_closed");
      assert.equal((await store.get("local", "run-a"))?.status, "stopped");
      assert.deepEqual(await store.requestStop("local", "run-a", "command-a", running.version), stopped);
      await assert.rejects(store.requestStop("local", "run-a", "command-a", running.version + 1), StoreError);
      const final = await store.get("local", "run-a");
      await store.closed(lease, "session_closed");
      assert.deepEqual(await store.get("local", "run-a"), final);
      const count = await pool.query("SELECT * FROM agent_events WHERE run_id='run-a' ORDER BY sequence");
      assert.equal(count.rowCount, 5);
      assert.equal((await pool.query("SELECT * FROM agent_outbox WHERE run_id='run-a'")).rowCount, 5);
    });
    await t.test("queued stop never creates a context; stale commands cannot change state", async () => {
      const run = await store.create(definition("task-q"), "run-q");
      await assert.rejects(store.requestStop("local", "run-q", "stale", 99), StoreError);
      const stopped = await store.requestStop("local", "run-q", "stop-q", run.version);
      assert.equal(stopped.status, "stopped");
      assert.equal(await store.getSession("local", "run-q"), null);
      await assert.rejects(store.reserve(request("run-q"), "owner-a"), StoreError);
    });
    await t.test("legacy capture and new sessions share one serialized execution slot", async () => {
      const legacyId = randomUUID();
      await legacy.create(legacyId, "Legacy", ["https://example.com/"]);
      await legacy.acquire(legacyId, 0);
      await store.create(definition("task-b"), "run-b");
      await assert.rejects(store.reserve(request("run-b"), "owner-a"), StoreError);
      await legacy.stop(legacyId);
      await legacy.release(legacyId, 0, null, null);
      const lease = await store.reserve(request("run-b"), "owner-a");
      const second = randomUUID();
      await legacy.create(second, "Second legacy", ["https://example.com/"]);
      await assert.rejects(legacy.acquire(second, 0), StoreError);
      await store.closed(lease, "session_closed");
      await legacy.acquire(second, 0);
      await legacy.stop(second);
      await legacy.release(second, 0, null, null);
    });
    await t.test(
      "simultaneous runs cannot acquire two contexts; expiry does not permit takeover",
      async () => {
        await store.create(definition("task-c"), "run-c");
        await store.create(definition("task-d"), "run-d");
        const results = await Promise.allSettled([
          store.reserve(request("run-c"), "owner-old"),
          store.reserve(request("run-d"), "owner-old"),
        ]);
        assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
        const winner = results.find((result) => result.status === "fulfilled");
        assert.ok(winner?.status === "fulfilled");
        const lease = winner.value;
        await store.activate(lease);
        await pool.query(
          "UPDATE agent_sessions SET lease_until=now()-interval '1 second' WHERE session_id=$1",
          [lease.sessionId],
        );
        assert.equal(await store.heartbeat(lease), false);
        await assert.rejects(store.reserve(request(lease.runId), "owner-old"), StoreError);
        await store.quarantineAbandoned("owner-new");
        assert.equal((await store.getSession("local", lease.runId))?.state, "quarantined");
        await assert.rejects(store.reserve(request(lease.runId), "owner-new"), StoreError);
        const other = lease.runId === "run-c" ? "run-d" : "run-c";
        await assert.rejects(store.reserve(request(other), "owner-new"), StoreError);
        // Test harness is the trusted isolation authority; no browser exists in this store-only test.
        await store.closed(lease, "session_lost");
        assert.equal((await store.get("local", lease.runId))?.status, "failed");
        const next = await store.reserve(request(other), "owner-new");
        await store.closed(next, "session_closed");
      },
    );
    await t.test("database rejects cross-workspace references and inconsistent terminal rows", async () => {
      await assert.rejects(
        pool.query(
          "INSERT INTO agent_runs(workspace_id,run_id,task_id,status,version,execution_epoch) VALUES('other','cross','task-a','queued',1,1)",
        ),
      );
      await assert.rejects(pool.query("UPDATE agent_runs SET ended_at=NULL WHERE run_id='run-a'"));
    });
    await t.test(
      "observation and artifact commit together; stale or revoked captures leave no records",
      async () => {
        await store.create(definition("task-observation"), "run-observation");
        const lease = await store.reserve(request("run-observation"), "owner-observation");
        await store.activate(lease);
        const make = (sequence: number): ObservationSnapshot => ({
          sequence,
          truncated: false,
          frames: [{ frameId: "main", parentFrameId: null, documentId: "doc", url: "https://example.com/" }],
          observation: {
            protocolVersion: 1,
            workspaceId: "local",
            runId: lease.runId,
            sessionId: lease.sessionId,
            tabId: "tab",
            executionEpoch: 1,
            observationId: randomUUID(),
            documentId: "doc",
            capturedAt: Date.now(),
            url: "https://example.com/",
            title: "Example",
            text: "Example",
            elements: [],
            screenshotArtifactId: randomUUID(),
          },
        });
        const save = (snapshot: ObservationSnapshot) =>
          store.saveObservation(lease, snapshot, {
            artifactId: snapshot.observation.screenshotArtifactId ?? "invalid",
            mimeType: "image/png",
            sha256: "a".repeat(64),
            byteLength: 100,
          });
        const first = make(1);
        await save(first);
        assert.deepEqual(await new RuntimeStore(pool).latestObservation("local", lease.runId), first);
        assert.equal(await store.latestObservation("other", lease.runId), null);
        assert.equal(
          await store.getArtifact("other", lease.runId, first.observation.screenshotArtifactId ?? ""),
          null,
        );
        await save(make(3));
        const stale = make(2);
        await assert.rejects(save(stale), StoreError);
        assert.equal(
          await store.getArtifact("local", lease.runId, stale.observation.screenshotArtifactId ?? ""),
          null,
        );
        const current = await store.get("local", lease.runId);
        assert.ok(current);
        await store.requestStop("local", lease.runId, "stop-observation", current.version);
        const late = make(4);
        await assert.rejects(save(late), StoreError);
        assert.equal(
          await store.getArtifact("local", lease.runId, late.observation.screenshotArtifactId ?? ""),
          null,
        );
        assert.equal(
          (await pool.query("SELECT 1 FROM agent_observations WHERE run_id=$1", [lease.runId])).rowCount,
          2,
        );
        await store.closed(lease, "session_closed");
      },
    );
    await t.test("action reservations survive lost receipts and serialize with stop", async () => {
      await store.create(definition("task-actions"), "run-actions");
      const lease = await store.reserve(request("run-actions"), "action-owner");
      await store.activate(lease);
      const action: ActionRequest = {
        protocolVersion: 1,
        workspaceId: "local",
        runId: lease.runId,
        sessionId: lease.sessionId,
        executionEpoch: 1,
        tabId: "tab",
        actionId: "action",
        stepId: "step",
        deadlineAt: Date.now() + 10_000,
        action: { type: "wait", milliseconds: 1 },
      };
      const ledger = new ActionLedger(pool);
      const admissions = await Promise.all(Array.from({ length: 8 }, () => ledger.admit(action, lease)));
      assert.equal(admissions.filter((result) => result === null).length, 1);
      assert.deepEqual(await new ActionLedger(pool).lookup(action), unknownReceipt(action));
      assert.deepEqual(await ledger.finish(action, unknownReceipt(action)), unknownReceipt(action));
      await assert.rejects(ledger.admit({ ...action, actionId: "other" }, lease), /unresolved/);
      await assert.rejects(
        ledger.lookup({ ...action, action: { type: "wait", milliseconds: 2 } }),
        /different parameters/,
      );
      assert.equal(await ledger.lookup({ ...action, workspaceId: "other" }), null);
      const current = await store.get("local", lease.runId);
      assert.ok(current);
      await store.requestStop("local", lease.runId, "stop-action", current.version);
      await assert.rejects(ledger.admit({ ...action, actionId: "late" }, lease), /execution_revoked/);
      assert.deepEqual(await ledger.admit(action, lease), unknownReceipt(action));
      const receipt = {
        ...unknownReceipt(action),
        result: {
          ...unknownReceipt(action).result,
          outcome: {
            status: "cancelled" as const,
            code: "execution_revoked" as const,
            effect: "none" as const,
          },
        },
      };
      assert.deepEqual(await ledger.finish(action, receipt), unknownReceipt(action));
      assert.deepEqual(
        await ledger.finish(action, unknownReceipt(action)),
        unknownReceipt(action),
        "Late completion cannot overwrite receipt",
      );
      await store.closed(lease, "session_closed");
      assert.deepEqual(await new ActionLedger(pool).lookup(action), unknownReceipt(action));
    });
  } finally {
    await pool.end();
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.end();
  }
});

test("session boundaries reject authority injection and malformed stop commands", () => {
  const request = { protocolVersion: 1, workspaceId: "local", runId: "run-1", executionEpoch: 1 };
  assert.deepEqual(parseSessionRequest(request), request);
  assert.throws(() => parseSessionRequest({ ...request, ownerId: "forged" }));
  assert.throws(() => parseSessionRequest({ ...request, executionEpoch: "1" }));
  assert.throws(() =>
    parseStopRunRequest({
      protocolVersion: 1,
      workspaceId: "local",
      runId: "run-1",
      commandId: "stop",
      expectedVersion: 0,
    }),
  );
});
