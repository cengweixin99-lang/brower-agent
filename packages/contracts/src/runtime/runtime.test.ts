import assert from "node:assert/strict";
import { test } from "node:test";
import {
  type ActionRequest,
  type AgentRun,
  ContractError,
  canAdmitAction,
  defaultRunBudget,
  matchesObservation,
  type Observation,
  parseActionRequest,
  parseActionResult,
  parseAgentRun,
  parseAgentStep,
  parseAgentTask,
  parseBrowserAction,
  parseDecision,
  parseObservation,
  type RunControl,
  type RunEvent,
  recoveryFor,
  runStatuses,
  TransitionError,
  transitionRun,
} from "./index.ts";

const target = {
  observationId: "observation-1",
  documentId: "document-1",
  frameId: "main",
  elementId: "search",
};
const request: ActionRequest = {
  protocolVersion: 1,
  workspaceId: "local",
  runId: "run-1",
  stepId: "step-1",
  actionId: "action-1",
  sessionId: "session-1",
  tabId: "tab-1",
  executionEpoch: 1,
  deadlineAt: 2_000_000_000_000,
  action: { type: "click", target },
};
const observation: Observation = {
  protocolVersion: 1,
  workspaceId: "local",
  runId: "run-1",
  sessionId: "session-1",
  tabId: "tab-1",
  observationId: "observation-1",
  documentId: "document-1",
  executionEpoch: 1,
  capturedAt: 1_000,
  url: "https://example.com/",
  title: "Search",
  text: "Search the catalogue",
  screenshotArtifactId: null,
  elements: [{ elementId: "search", frameId: "main", role: "button", name: "Search" }],
};
const queued: RunControl = { status: "queued", version: 1, executionEpoch: 1, waitingReason: null };
function error(code: TransitionError["code"]): (value: unknown) => boolean {
  return (value) => value instanceof TransitionError && value.code === code;
}

test("runtime task, run and step boundaries remain independent of legacy capture DTOs", () => {
  const task = parseAgentTask({
    protocolVersion: 1,
    taskId: "task-1",
    workspaceId: "local",
    goal: "Find an available item",
    startUrl: "https://example.com/items",
    allowedOrigins: ["https://example.com"],
    acceptance: ["Open its detail page"],
    budget: defaultRunBudget,
  });
  assert.equal(task.goal, "Find an available item");
  assert.deepEqual(task.allowedOrigins, ["https://example.com"]);
  const run: AgentRun = {
    protocolVersion: 1,
    executionVersion: 3,
    runId: "run-1",
    taskId: "task-1",
    workspaceId: "local",
    sessionId: null,
    checkpointStepId: null,
    ...queued,
  };
  assert.deepEqual(parseAgentRun(run), run);
  assert.equal(
    parseAgentStep({
      protocolVersion: 1,
      workspaceId: "local",
      runId: "run-1",
      stepId: "step-1",
      sequence: 1,
      observationId: "observation-1",
      decisionArtifactId: null,
      actionId: null,
      phase: "deciding",
    }).phase,
    "deciding",
  );
  for (const invalid of [
    { ...task, startUrl: "https://other.example/" },
    { ...task, allowedOrigins: [] },
    { ...task, allowedOrigins: ["https://example.com/path"] },
    { ...task, allowedOrigins: ["https://example.com", "https://example.com/"] },
    { ...task, budget: { ...task.budget, maxSteps: Infinity } },
    { ...task, budget: { ...task.budget, maxModelCalls: 0 } },
    { ...task, acceptance: [] },
  ])
    assert.throws(() => parseAgentTask(invalid), ContractError);
  assert.throws(() => parseAgentRun({ ...run, status: "waiting" }), ContractError);
  assert.throws(() => parseAgentRun({ ...run, waitingReason: "approval" }), ContractError);
  assert.throws(() => parseAgentRun({ ...run, executionVersion: 2 }), ContractError);
});

test("eight typed browser actions accept bounded parameters and reject executable extensions", () => {
  const actions = [
    { type: "navigate", url: "https://example.com/" },
    { type: "click", target },
    { type: "fill", target, text: "" },
    { type: "select", target, value: "books" },
    { type: "scroll", direction: "down", pixels: 600 },
    { type: "pressKey", target, key: "Enter" },
    { type: "wait", milliseconds: 100 },
    { type: "extract", target },
  ];
  for (const action of actions) assert.deepEqual(parseBrowserAction(action), action);
  for (const invalid of [
    { type: "evaluate", script: "alert(1)" },
    { type: "navigate", url: "javascript:alert(1)" },
    { type: "navigate", url: "file:///etc/passwd" },
    { type: "click", target, approved: true },
    { type: "wait", milliseconds: "100" },
    { type: "wait", milliseconds: 10_001 },
    { type: "scroll", direction: "down", pixels: -1 },
    { type: "pressKey", target, key: "Control+L" },
    { type: "fill", target, text: "x".repeat(10_001) },
    { type: "click", target: { ...target, frameId: "" } },
  ])
    assert.throws(() => parseBrowserAction(invalid), ContractError);
});

test("gateway envelopes reject unsupported versions, unsafe numbers and unknown authority fields", () => {
  assert.deepEqual(parseActionRequest(request), request);
  for (const invalid of [
    null,
    [],
    { ...request, protocolVersion: 2 },
    { ...request, executionEpoch: 0 },
    { ...request, deadlineAt: Number.NaN },
    { ...request, deadlineAt: 1.5 },
    { ...request, admin: true },
    { ...request, runId: "../other" },
  ])
    assert.throws(() => parseActionRequest(invalid), ContractError);
  assert.throws(
    () => parseBrowserAction({ type: "navigate", url: "https://user:private-password@example.com/" }),
    (value) => value instanceof ContractError && !value.message.includes("private-password"),
  );
});

test("observation checks reject stale pages, cross-run/session references and duplicate elements", () => {
  assert.deepEqual(parseObservation(observation), observation);
  assert.equal(matchesObservation(request, observation), true);
  for (const changed of [
    { ...observation, workspaceId: "other" },
    { ...observation, runId: "other" },
    { ...observation, sessionId: "other" },
    { ...observation, tabId: "other" },
    { ...observation, documentId: "new-document" },
    { ...observation, observationId: "new-observation" },
    { ...observation, executionEpoch: 2 },
    { ...observation, elements: [] },
    {
      ...observation,
      elements: [
        { ...observation.elements[0], elementId: "search", frameId: "other", role: "button", name: "Search" },
      ],
    },
  ])
    assert.equal(matchesObservation(request, changed), false);
  assert.throws(
    () => parseObservation({ ...observation, elements: [...observation.elements, ...observation.elements] }),
    ContractError,
  );
  assert.throws(() => parseObservation({ ...observation, text: "x".repeat(30_001) }), ContractError);
});

test("model decisions cannot supply execution identities or approve their own actions", () => {
  assert.equal(parseDecision({ protocolVersion: 1, type: "act", action: request.action }).type, "act");
  assert.equal(
    parseDecision({ protocolVersion: 1, type: "ask_user", question: "Which category?" }).type,
    "ask_user",
  );
  assert.equal(
    parseDecision({
      protocolVersion: 1,
      type: "finish",
      summary: "Found the item",
      evidenceIds: ["observation-1"],
    }).type,
    "finish",
  );
  assert.throws(
    () => parseDecision({ protocolVersion: 1, type: "act", action: request.action, executionEpoch: 99 }),
    ContractError,
  );
  assert.throws(
    () => parseDecision({ protocolVersion: 1, type: "finish", summary: "Done", evidenceIds: [] }),
    ContractError,
  );
});

test("uncertain or confirmed side effects are verified, never blindly repeated", () => {
  const result = {
    protocolVersion: 1,
    actionId: "action-1",
    runId: "run-1",
    executionEpoch: 1,
    outcome: { status: "unknown", code: "outcome_unknown" },
  };
  assert.equal(recoveryFor(parseActionResult(result).outcome, "safe_repeat"), "verify");
  assert.equal(
    recoveryFor({ status: "succeeded", observationId: "o1" }, "verify_before_repeat"),
    "use_result",
  );
  assert.equal(
    recoveryFor({ status: "failed", code: "browser_error", effect: "confirmed" }, "safe_repeat"),
    "verify",
  );
  assert.equal(
    recoveryFor({ status: "failed", code: "target_missing", effect: "none" }, "safe_repeat"),
    "reobserve",
  );
  assert.equal(
    recoveryFor({ status: "failed", code: "browser_error", effect: "none" }, "verify_before_repeat"),
    "verify",
  );
  assert.equal(
    recoveryFor({ status: "cancelled", code: "execution_revoked", effect: "none" }, "safe_repeat"),
    "end",
  );
  assert.throws(
    () =>
      parseActionResult({
        ...result,
        outcome: { status: "failed", code: "outcome_unknown", effect: "none" },
      }),
    ContractError,
  );
  assert.throws(
    () => parseActionResult({ ...result, outcome: { status: "unknown", code: "browser_error" } }),
    ContractError,
  );
});

test("pause and resume require a safe boundary and revoke stale execution epochs", () => {
  const running = transitionRun(queued, { type: "start" }, "worker", 1);
  const pausing = transitionRun(running, { type: "pause" }, "api", 2);
  assert.equal(canAdmitAction(pausing, 1), false);
  assert.throws(() => transitionRun(pausing, { type: "resume" }, "api", 3), error("invalid_transition"));
  assert.throws(
    () => transitionRun(pausing, { type: "paused", quiescent: false }, "gateway", 3),
    error("unsafe_transition"),
  );
  const paused = transitionRun(pausing, { type: "paused", quiescent: true }, "gateway", 3);
  const resumed = transitionRun(paused, { type: "resume" }, "api", 4);
  const restarted = transitionRun(resumed, { type: "start" }, "worker", 5);
  assert.equal(canAdmitAction(restarted, 1), false);
  assert.equal(canAdmitAction(restarted, 2), true);
  assert.deepEqual(queued, { status: "queued", version: 1, executionEpoch: 1, waitingReason: null });
});

test("waiting for approval cannot be bypassed by pause/resume or unrelated input", () => {
  const running = transitionRun(queued, { type: "start" }, "worker", 1);
  const waiting = transitionRun(running, { type: "wait", reason: "approval", quiescent: true }, "worker", 2);
  assert.equal(canAdmitAction(waiting, waiting.executionEpoch), false);
  assert.throws(() => transitionRun(waiting, { type: "pause" }, "api", 3), error("invalid_transition"));
  assert.throws(() => transitionRun(waiting, { type: "resume" }, "api", 3), error("invalid_transition"));
  assert.throws(
    () => transitionRun(waiting, { type: "continue", resolvedReason: "input" }, "worker", 3),
    error("unsafe_transition"),
  );
  assert.equal(
    transitionRun(waiting, { type: "continue", resolvedReason: "approval" }, "worker", 3).status,
    "queued",
  );
});

test("stop wins after acceptance, requires cleanup, and rejects late completion", () => {
  const running = transitionRun(queued, { type: "start" }, "worker", 1);
  const stopping = transitionRun(running, { type: "stop" }, "api", 2);
  assert.equal(stopping.executionEpoch, 2);
  assert.equal(canAdmitAction(stopping, 1), false);
  assert.throws(
    () => transitionRun(stopping, { type: "complete", quiescent: true, evidenceVerified: true }, "worker", 2),
    error("version_conflict"),
  );
  assert.throws(
    () => transitionRun(stopping, { type: "complete", quiescent: true, evidenceVerified: true }, "worker", 3),
    error("invalid_transition"),
  );
  assert.throws(
    () => transitionRun(stopping, { type: "stopped", quiescent: false }, "gateway", 3),
    error("unsafe_transition"),
  );
  assert.equal(transitionRun(stopping, { type: "stopped", quiescent: true }, "gateway", 3).status, "stopped");
});

test("completion requires evidence, service ownership, and immutable terminal states", () => {
  const running = transitionRun(queued, { type: "start" }, "worker", 1);
  assert.throws(() => transitionRun(queued, { type: "start" }, "api", 1), error("wrong_actor"));
  assert.throws(
    () => transitionRun(running, { type: "complete", quiescent: true, evidenceVerified: false }, "worker", 2),
    error("unsafe_transition"),
  );
  const completed = transitionRun(
    running,
    { type: "complete", quiescent: true, evidenceVerified: true },
    "worker",
    2,
  );
  const events: RunEvent[] = [
    { type: "start" },
    { type: "resume" },
    { type: "stop" },
    { type: "fail", quiescent: true },
  ];
  for (const status of ["completed", "failed", "stopped"] as const) {
    for (const event of events)
      assert.throws(
        () =>
          transitionRun(
            { ...completed, status },
            event,
            event.type === "resume" || event.type === "stop" ? "api" : "worker",
            3,
          ),
        error("invalid_transition"),
      );
  }
  for (const status of runStatuses)
    assert.equal(canAdmitAction({ ...queued, status }, 1), status === "running");
});
