import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { TestContext } from "node:test";
import type {
  ActionRequest,
  BrowserAction,
  ObservationSnapshot,
} from "../packages/contracts/src/runtime/index.ts";
import { ActionLedger, type ActionReceipt, type RuntimeStore } from "../packages/persistence/src/runtime.ts";

export function actionFixture(path: string): string | null {
  if (path === "/actions")
    return `<html><body>
    <a href="/action-destination">Open destination</a><a href="http://127.0.0.1:1/private">Forbidden link</a>
    <label>Toggle<input type="checkbox"></label><form action="/submission" method="get">
    <label>Name<input name="name"></label><label for="choice">Choice</label><select id="choice" name="choice"><option value="a">A</option><option value="b">B</option></select>
    <button>Submit</button><input type="submit" value="Send" aria-label="Input submit"></form>
    <iframe src="/actions-child"></iframe><div style="height:2500px">Tall page</div></body></html>`;
  if (path === "/actions-child") return "<html><body><label>Child field<input></label></body></html>";
  if (path === "/action-destination")
    return '<html><body><h1>Destination reached</h1><a href="/actions">Back</a></body></html>';
  return null;
}
export async function actionTests(
  t: TestContext,
  context: {
    store: RuntimeStore;
    origin: string;
    hits: Map<string, number>;
    post(path: string, body: unknown, authenticated?: boolean): Promise<Response>;
    seed(runId: string, path?: string): Promise<void>;
    observe(runId: string): Promise<ObservationSnapshot>;
    stop(runId: string): Promise<Response>;
    until(read: () => Promise<boolean>, description: string): Promise<void>;
    slowConnected(): boolean;
  },
): Promise<() => Promise<void>> {
  const { store, origin, post, seed, observe, stop, until, hits } = context;
  const input = (runId: string) => ({ protocolVersion: 1, workspaceId: "local", runId, executionEpoch: 1 });
  async function open(runId: string): Promise<void> {
    await seed(runId, "/actions");
    assert.equal((await post("open", input(runId))).status, 200);
    await observe(runId);
  }
  async function latest(runId: string): Promise<ObservationSnapshot> {
    const snapshot = await store.latestObservation("local", runId);
    assert.ok(snapshot);
    return snapshot;
  }
  async function target(runId: string, name: string) {
    const snapshot = await latest(runId);
    const element = snapshot.observation.elements.find((element) => element.name === name);
    assert.ok(element, `Missing target ${name}`);
    return {
      observationId: snapshot.observation.observationId,
      documentId: snapshot.observation.documentId,
      frameId: element.frameId,
      elementId: element.elementId,
    };
  }
  async function request(runId: string, action: BrowserAction): Promise<ActionRequest> {
    const snapshot = await latest(runId);
    return {
      protocolVersion: 1,
      workspaceId: "local",
      runId,
      stepId: randomUUID(),
      actionId: randomUUID(),
      sessionId: snapshot.observation.sessionId,
      tabId: snapshot.observation.tabId,
      executionEpoch: 1,
      deadlineAt: Date.now() + 10_000,
      action,
    };
  }
  async function send(request: ActionRequest): Promise<ActionReceipt> {
    const response = await post("action", request);
    assert.equal(response.status, 200, await response.clone().text());
    return (await response.json()) as ActionReceipt;
  }
  async function success(runId: string, action: BrowserAction): Promise<ActionReceipt> {
    const receipt = await send(await request(runId, action));
    assert.equal(receipt.result.outcome.status, "succeeded", JSON.stringify(receipt));
    return receipt;
  }
  let saved: { request: ActionRequest; receipt: ActionReceipt } | undefined;
  await t.test(
    "native actions fill, select, extract, scroll, key and click through the gateway",
    async () => {
      const runId = "actions-native";
      await open(runId);
      const longText = "测试".repeat(2500);
      await success(runId, { type: "fill", target: await target(runId, "Name"), text: longText });
      assert.equal(
        (await success(runId, { type: "extract", target: await target(runId, "Name") })).extractedText,
        longText,
      );
      await success(runId, { type: "fill", target: await target(runId, "Name"), text: "Demo User" });
      assert.equal(
        (await success(runId, { type: "extract", target: await target(runId, "Name") })).extractedText,
        "Demo User",
      );
      await success(runId, { type: "select", target: await target(runId, "Choice"), value: "b" });
      assert.equal(
        (await success(runId, { type: "extract", target: await target(runId, "Choice") })).extractedText,
        "b",
      );
      await success(runId, {
        type: "fill",
        target: await target(runId, "Child field"),
        text: "Inside frame",
      });
      assert.equal(
        (await success(runId, { type: "extract", target: await target(runId, "Child field") })).extractedText,
        "Inside frame",
      );
      await success(runId, { type: "pressKey", target: await target(runId, "Name"), key: "Tab" });
      await success(runId, { type: "scroll", direction: "down", pixels: 1000 });
      await success(runId, { type: "wait", milliseconds: 20 });
      const link = await request(runId, { type: "click", target: await target(runId, "Open destination") });
      const receipt = await send(link);
      assert.equal(receipt.result.outcome.status, "succeeded");
      assert.equal((await latest(runId)).observation.url, `${origin}/action-destination`);
      assert.equal(hits.get("/action-destination"), 1);
      saved = { request: link, receipt };
      await success(runId, { type: "navigate", url: `${origin}/actions` });
      await stop(runId);
    },
  );
  await t.test(
    "concurrent and durable duplicate clicks toggle once; conflicting arguments are rejected",
    async () => {
      const runId = "actions-dedup";
      await open(runId);
      const click = await request(runId, { type: "click", target: await target(runId, "Toggle") });
      const responses = await Promise.all(Array.from({ length: 6 }, () => send(click)));
      assert.ok(responses.every((receipt) => receipt.result.outcome.status === "succeeded"));
      for (const receipt of responses) assert.deepEqual(receipt, responses[0]);
      assert.deepEqual(await send(click), responses[0]);
      assert.equal(
        (await success(runId, { type: "extract", target: await target(runId, "Toggle") })).extractedText,
        "true",
      );
      assert.equal(
        (await post("action", { ...click, action: { type: "wait", milliseconds: 10 } })).status,
        409,
      );
      assert.equal((await post("action", click, false)).status, 401);
      assert.equal((await post("action", { ...click, workspaceId: "other" })).status, 409);
      const rows = await store.pool.query("SELECT 1 FROM agent_actions WHERE run_id=$1 AND action_id=$2", [
        runId,
        click.actionId,
      ]);
      assert.equal(rows.rowCount, 1);
      await success(runId, { type: "click", target: await target(runId, "Toggle") });
      assert.equal(
        (await success(runId, { type: "extract", target: await target(runId, "Toggle") })).extractedText,
        "false",
      );
      await stop(runId);
      assert.deepEqual(await send(click), responses[0]);
    },
  );
  await t.test(
    "stale references, form submission, forbidden origins and invalid authority have no effect",
    async () => {
      const runId = "actions-policy";
      await open(runId);
      const stale = await request(runId, {
        type: "fill",
        target: await target(runId, "Name"),
        text: "Wrong",
      });
      await observe(runId);
      assert.deepEqual((await send(stale)).result.outcome, {
        status: "failed",
        code: "stale_observation",
        effect: "none",
      });
      for (const action of [
        { type: "click", target: await target(runId, "Submit") },
        { type: "click", target: await target(runId, "Input submit") },
        { type: "pressKey", target: await target(runId, "Name"), key: "Enter" },
        { type: "click", target: await target(runId, "Forbidden link") },
        { type: "navigate", url: "http://127.0.0.1:1/private" },
      ] satisfies BrowserAction[]) {
        assert.deepEqual((await send(await request(runId, action))).result.outcome, {
          status: "failed",
          code: "policy_denied",
          effect: "none",
        });
      }
      assert.equal(
        [...hits.keys()].some((path) => path.startsWith("/submission")),
        false,
      );
      const valid = await request(runId, { type: "wait", milliseconds: 1 });
      assert.equal((await post("action", { ...valid, executionEpoch: 2 })).status, 409);
      assert.equal((await post("action", { ...valid, tabId: "wrong" })).status, 409);
      assert.equal((await post("action", { ...valid, sessionId: "wrong" })).status, 409);
      assert.equal((await post("action", { ...valid, deadlineAt: Date.now() - 1 })).status, 400);
      assert.equal((await post("action", { ...valid, ownerId: "forged" })).status, 400);
      await stop(runId);
    },
  );
  await t.test("stop cancels an admitted wait and rejects all new actions", async () => {
    const runId = "actions-wait-stop";
    await open(runId);
    const wait = await request(runId, { type: "wait", milliseconds: 9000 });
    const running = send(wait);
    await until(async () => Boolean(await new ActionLedger(store.pool).lookup(wait)), "wait admitted");
    assert.equal((await post("observe", input(runId))).status, 409);
    assert.equal((await stop(runId)).status, 200);
    const cancelled = await running;
    assert.deepEqual(cancelled.result.outcome, {
      status: "cancelled",
      code: "execution_revoked",
      effect: "none",
    });
    assert.deepEqual(await send(wait), cancelled);
    assert.equal((await post("action", { ...wait, actionId: randomUUID() })).status, 409);
    assert.equal((await store.get("local", runId))?.status, "stopped");
  });
  await t.test("stop during navigation closes the request and preserves unknown without retry", async () => {
    const runId = "actions-navigation-stop";
    await open(runId);
    const navigation = await request(runId, { type: "navigate", url: `${origin}/slow` });
    const running = send(navigation);
    await until(async () => context.slowConnected(), "action navigation started");
    const count = hits.get("/slow");
    assert.equal((await stop(runId)).status, 200);
    const unknown = await running;
    assert.equal(unknown.result.outcome.status, "unknown");
    await until(async () => !context.slowConnected(), "navigation socket closed");
    assert.deepEqual(await send(navigation), unknown);
    assert.equal(hits.get("/slow"), count);
    assert.equal((await store.get("local", runId))?.status, "stopped");
  });
  await t.test("deadline expiry terminates browser ownership and cannot replay the operation", async () => {
    const runId = "actions-deadline";
    await open(runId);
    const waiting = {
      ...(await request(runId, { type: "wait", milliseconds: 5000 })),
      deadlineAt: Date.now() + 250,
    };
    const receipt = await send(waiting);
    assert.notEqual(receipt.result.outcome.status, "succeeded");
    await until(
      async () => (await store.getSession("local", runId))?.state === "closed",
      "expired action isolated",
    );
    assert.deepEqual(await send(waiting), receipt);
  });
  return async () => {
    assert.ok(saved);
    assert.deepEqual(await send(saved.request), saved.receipt);
    assert.equal(hits.get("/action-destination"), 1);
  };
}
