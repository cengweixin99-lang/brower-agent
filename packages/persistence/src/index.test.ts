import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import type { PageSource } from "@pba/contracts";
import { createDatabasePool, StoreError, TaskStore } from "./index.ts";

test("stop/completion races preserve terminal state and exclusive browser ownership", async () => {
  assert.ok(process.env.DATABASE_URL);
  const schema = `test_state_${randomUUID().replaceAll("-", "")}`;
  const admin = createDatabasePool(process.env.DATABASE_URL);
  await admin.query(`CREATE SCHEMA ${schema}`);
  const url = new URL(process.env.DATABASE_URL);
  url.searchParams.set("options", `-csearch_path=${schema}`);
  const pool = createDatabasePool(url.href);
  const store = new TaskStore(pool);
  const source: PageSource = {
    id: "source-1",
    url: "https://example.com/",
    title: "Source",
    text: "Captured source",
    headings: [],
    capturedAt: new Date().toISOString(),
  };
  try {
    await store.initialize();
    for (let i = 0; i < 10; i += 1) {
      const id = randomUUID();
      await store.create(id, "Capture page", [source.url]);
      await store.acquire(id, 0);
      await Promise.all([store.stop(id).then(() => store.finish(id)), store.release(id, 0, source, null)]);
      const ended = await store.get(id);
      assert.ok(ended);
      assert.ok(ended.status === "completed" || ended.status === "stopped");
      assert.equal(ended.sourceCount, ended.status === "completed" ? 1 : 0);
      assert.equal(await store.busyTaskId(), null);
      await store.stop(id);
      await store.finish(id, "late failure");
      await assert.rejects(
        store.acquire(id, 0),
        (error) => error instanceof StoreError && error.statusCode === 410,
      );
      assert.deepEqual(await store.get(id), ended);
    }
    const first = randomUUID();
    const second = randomUUID();
    await store.create(first, "First", [source.url]);
    await store.create(second, "Second", [source.url]);
    await store.acquire(first, 0);
    await assert.rejects(
      store.acquire(second, 0),
      (error) => error instanceof StoreError && error.statusCode === 409,
    );
    await store.stop(first);
    assert.equal(
      (await store.finish(first)).status,
      "stopping",
      "Must not acknowledge while browser owns a lease",
    );
    await store.release(first, 0, null, null);
    assert.equal((await store.get(first))?.status, "stopped");
    await store.acquire(second, 0);
    await store.release(second, 0, source, null);
    assert.equal((await store.get(second))?.status, "completed");

    const pausedId = randomUUID();
    await store.create(pausedId, "Pause at checkpoint", [source.url, `${source.url}next`]);
    const queuedPause = await store.pause(pausedId);
    assert.equal(queuedPause.status, "paused");
    assert.deepEqual(await store.pause(pausedId), queuedPause);
    await assert.rejects(
      store.acquire(pausedId, 0),
      (error) => error instanceof StoreError && error.statusCode === 423,
    );
    await store.resume(pausedId);
    await store.acquire(pausedId, 0);
    assert.equal((await store.pause(pausedId)).status, "pausing");
    assert.equal(
      (await store.resume(pausedId)).status,
      "pausing",
      "Resume cannot cancel an unacknowledged pause",
    );
    await store.release(pausedId, 0, source, null);
    const paused = await store.get(pausedId);
    assert.equal(paused?.status, "paused");
    assert.equal(paused?.sourceCount, 1);
    assert.equal(await store.busyTaskId(), pausedId);
    await store.recoverGateway();
    assert.deepEqual(await store.get(pausedId), paused);
    assert.equal(await store.busyTaskId(), pausedId);
    const resumed = await store.resume(pausedId);
    assert.deepEqual(await store.resume(pausedId), resumed);
    assert.equal((await store.acquire(pausedId, 0)).cached, true);
    await store.acquire(pausedId, 1);
    await store.pause(pausedId);
    await store.stop(pausedId);
    await store.release(pausedId, 1, { ...source, id: "source-2" }, null);
    const stoppedPause = await store.get(pausedId);
    assert.equal(stoppedPause?.status, "stopped");
    assert.equal(stoppedPause?.sourceCount, 1);
    assert.deepEqual(await store.resume(pausedId), stoppedPause);
    assert.equal(await store.busyTaskId(), null);

    const held = randomUUID();
    await store.create(held, "Stop while paused", [source.url, `${source.url}next`]);
    await store.acquire(held, 0);
    await store.pause(held);
    await store.release(held, 0, source, null);
    assert.equal(await store.busyTaskId(), held);
    await store.stop(held);
    assert.equal((await store.finish(held)).status, "stopped");
    assert.equal(await store.busyTaskId(), null);

    const interrupted = randomUUID();
    await store.create(interrupted, "Recover pausing", [source.url]);
    await store.acquire(interrupted, 0);
    await store.pause(interrupted);
    await store.recoverGateway();
    assert.equal((await store.get(interrupted))?.status, "paused");
    assert.equal(await store.busyTaskId(), interrupted);
    await store.resume(interrupted);
    await store.acquire(interrupted, 0);
    await store.pause(interrupted);
    await store.release(interrupted, 0, source, null);
    assert.equal(
      (await store.get(interrupted))?.status,
      "completed",
      "The final captured page completes the task",
    );
  } finally {
    await pool.end();
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.end();
  }
});
