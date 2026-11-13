import {
  ContractError,
  choice,
  httpUrl,
  id,
  integer,
  list,
  nullableId,
  object,
  string,
  version,
} from "./validation.ts";

export interface ElementTarget {
  observationId: string;
  documentId: string;
  frameId: string;
  elementId: string;
}

export type BrowserAction =
  | { type: "navigate"; url: string }
  | { type: "click"; target: ElementTarget }
  | { type: "fill"; target: ElementTarget; text: string }
  | { type: "select"; target: ElementTarget; value: string }
  | { type: "scroll"; direction: "up" | "down"; pixels: number }
  | { type: "pressKey"; target: ElementTarget; key: "Enter" | "Tab" | "Escape" | "ArrowDown" | "ArrowUp" }
  | { type: "wait"; milliseconds: number }
  | { type: "extract"; target: ElementTarget };

export interface ActionRequest {
  protocolVersion: 1;
  workspaceId: string;
  runId: string;
  stepId: string;
  actionId: string;
  sessionId: string;
  tabId: string;
  executionEpoch: number;
  deadlineAt: number;
  action: BrowserAction;
}

export interface ObservedElement {
  elementId: string;
  frameId: string;
  role: string;
  name: string;
}

export interface Observation {
  protocolVersion: 1;
  workspaceId: string;
  runId: string;
  sessionId: string;
  tabId: string;
  observationId: string;
  documentId: string;
  executionEpoch: number;
  capturedAt: number;
  url: string;
  title: string;
  text: string;
  screenshotArtifactId: string | null;
  elements: ObservedElement[];
}

export const actionErrorCodes = [
  "stale_observation",
  "target_missing",
  "policy_denied",
  "session_lost",
  "outcome_unknown",
  "deadline_exceeded",
  "execution_revoked",
  "browser_error",
] as const;
export type ActionErrorCode = (typeof actionErrorCodes)[number];
export type ActionOutcome =
  | { status: "succeeded"; observationId: string }
  | { status: "failed" | "cancelled"; code: ActionErrorCode; effect: "none" | "confirmed" }
  | { status: "unknown"; code: "outcome_unknown" };

export interface ActionResult {
  protocolVersion: 1;
  actionId: string;
  runId: string;
  executionEpoch: number;
  outcome: ActionOutcome;
}

export type Decision =
  | { protocolVersion: 1; type: "act"; action: BrowserAction }
  | { protocolVersion: 1; type: "ask_user"; question: string }
  | { protocolVersion: 1; type: "finish"; summary: string; evidenceIds: string[] };

export function parseTarget(value: unknown): ElementTarget {
  const row = object(value, ["observationId", "documentId", "frameId", "elementId"], "target");
  return {
    observationId: id(row.observationId, "target.observationId"),
    documentId: id(row.documentId, "target.documentId"),
    frameId: id(row.frameId, "target.frameId"),
    elementId: id(row.elementId, "target.elementId"),
  };
}

export function parseBrowserAction(value: unknown): BrowserAction {
  const row = object(
    value,
    ["type", "target", "url", "text", "value", "direction", "pixels", "key", "milliseconds"],
    "action",
  );
  switch (row.type) {
    case "navigate":
      object(row, ["type", "url"], "action.navigate");
      return { type: "navigate", url: httpUrl(row.url, "action.url") };
    case "click":
    case "extract":
      object(row, ["type", "target"], "action.target");
      return { type: row.type, target: parseTarget(row.target) };
    case "fill":
      object(row, ["type", "target", "text"], "action.fill");
      return {
        type: "fill",
        target: parseTarget(row.target),
        text: string(row.text, "action.text", 10_000, 0),
      };
    case "select":
      object(row, ["type", "target", "value"], "action.select");
      return {
        type: "select",
        target: parseTarget(row.target),
        value: string(row.value, "action.value", 1000),
      };
    case "scroll":
      object(row, ["type", "direction", "pixels"], "action.scroll");
      return {
        type: "scroll",
        direction: choice(row.direction, ["up", "down"], "action.direction"),
        pixels: integer(row.pixels, "action.pixels", 1, 4000),
      };
    case "pressKey":
      object(row, ["type", "target", "key"], "action.pressKey");
      return {
        type: "pressKey",
        target: parseTarget(row.target),
        key: choice(row.key, ["Enter", "Tab", "Escape", "ArrowDown", "ArrowUp"], "action.key"),
      };
    case "wait":
      object(row, ["type", "milliseconds"], "action.wait");
      return { type: "wait", milliseconds: integer(row.milliseconds, "action.milliseconds", 1, 10_000) };
    default:
      throw new ContractError("action.type");
  }
}

export function parseActionRequest(value: unknown): ActionRequest {
  const row = object(
    value,
    [
      "protocolVersion",
      "workspaceId",
      "runId",
      "stepId",
      "actionId",
      "sessionId",
      "tabId",
      "executionEpoch",
      "deadlineAt",
      "action",
    ],
    "request",
  );
  return {
    protocolVersion: version(row.protocolVersion),
    workspaceId: id(row.workspaceId, "workspaceId"),
    runId: id(row.runId, "runId"),
    stepId: id(row.stepId, "stepId"),
    actionId: id(row.actionId, "actionId"),
    sessionId: id(row.sessionId, "sessionId"),
    tabId: id(row.tabId, "tabId"),
    executionEpoch: integer(row.executionEpoch, "executionEpoch", 1),
    deadlineAt: integer(row.deadlineAt, "deadlineAt", 1),
    action: parseBrowserAction(row.action),
  };
}

export function parseObservation(value: unknown): Observation {
  const row = object(
    value,
    [
      "protocolVersion",
      "workspaceId",
      "runId",
      "sessionId",
      "tabId",
      "observationId",
      "documentId",
      "executionEpoch",
      "capturedAt",
      "url",
      "title",
      "text",
      "screenshotArtifactId",
      "elements",
    ],
    "observation",
  );
  const elements = list(
    row.elements,
    (value): ObservedElement => {
      const element = object(value, ["elementId", "frameId", "role", "name"], "element");
      return {
        elementId: id(element.elementId, "elementId"),
        frameId: id(element.frameId, "frameId"),
        role: string(element.role, "role", 100),
        name: string(element.name, "name", 1000, 0),
      };
    },
    "elements",
    1000,
  );
  if (new Set(elements.map((element) => `${element.frameId}/${element.elementId}`)).size !== elements.length)
    throw new ContractError("elements.duplicate");
  return {
    protocolVersion: version(row.protocolVersion),
    workspaceId: id(row.workspaceId, "workspaceId"),
    runId: id(row.runId, "runId"),
    sessionId: id(row.sessionId, "sessionId"),
    tabId: id(row.tabId, "tabId"),
    observationId: id(row.observationId, "observationId"),
    documentId: id(row.documentId, "documentId"),
    executionEpoch: integer(row.executionEpoch, "executionEpoch", 1),
    capturedAt: integer(row.capturedAt, "capturedAt", 1),
    url: httpUrl(row.url, "url"),
    title: string(row.title, "title", 2000, 0),
    text: string(row.text, "text", 30_000, 0),
    screenshotArtifactId: nullableId(row.screenshotArtifactId, "screenshotArtifactId"),
    elements,
  };
}

export function parseDecision(value: unknown): Decision {
  const row = object(
    value,
    ["protocolVersion", "type", "action", "question", "summary", "evidenceIds"],
    "decision",
  );
  const protocolVersion = version(row.protocolVersion);
  switch (row.type) {
    case "act":
      object(row, ["protocolVersion", "type", "action"], "decision.act");
      return { protocolVersion, type: "act", action: parseBrowserAction(row.action) };
    case "ask_user":
      object(row, ["protocolVersion", "type", "question"], "decision.ask_user");
      return { protocolVersion, type: "ask_user", question: string(row.question, "question") };
    case "finish":
      object(row, ["protocolVersion", "type", "summary", "evidenceIds"], "decision.finish");
      return {
        protocolVersion,
        type: "finish",
        summary: string(row.summary, "summary", 4000),
        evidenceIds: list(row.evidenceIds, (item) => id(item, "evidenceId"), "evidenceIds", 50, 1),
      };
    default:
      throw new ContractError("decision.type");
  }
}

export function parseActionResult(value: unknown): ActionResult {
  const row = object(value, ["protocolVersion", "actionId", "runId", "executionEpoch", "outcome"], "result");
  const raw = object(row.outcome, ["status", "observationId", "code", "effect"], "outcome");
  let outcome: ActionOutcome;
  if (raw.status === "succeeded") {
    object(raw, ["status", "observationId"], "outcome");
    outcome = { status: "succeeded", observationId: id(raw.observationId, "observationId") };
  } else if (raw.status === "unknown") {
    object(raw, ["status", "code"], "outcome");
    outcome = { status: "unknown", code: choice(raw.code, ["outcome_unknown"], "code") };
  } else {
    object(raw, ["status", "code", "effect"], "outcome");
    const code = choice(raw.code, actionErrorCodes, "code");
    if (code === "outcome_unknown") throw new ContractError("outcome.status");
    outcome = {
      status: choice(raw.status, ["failed", "cancelled"], "status"),
      code,
      effect: choice(raw.effect, ["none", "confirmed"], "effect"),
    };
  }
  return {
    protocolVersion: version(row.protocolVersion),
    actionId: id(row.actionId, "actionId"),
    runId: id(row.runId, "runId"),
    executionEpoch: integer(row.executionEpoch, "executionEpoch", 1),
    outcome,
  };
}

// Called with trusted current observation; schema validity alone grants no execution rights.
export function matchesObservation(request: ActionRequest, observation: Observation): boolean {
  if (
    request.workspaceId !== observation.workspaceId ||
    request.runId !== observation.runId ||
    request.sessionId !== observation.sessionId ||
    request.tabId !== observation.tabId ||
    request.executionEpoch !== observation.executionEpoch
  )
    return false;
  if (!("target" in request.action)) return true;
  const target = request.action.target;
  return (
    target.observationId === observation.observationId &&
    target.documentId === observation.documentId &&
    observation.elements.some(
      (element) => element.elementId === target.elementId && element.frameId === target.frameId,
    )
  );
}

// Retry policy is assigned by trusted policy code, never inferred from tool name or model output.
export function recoveryFor(
  outcome: ActionOutcome,
  policy: "safe_repeat" | "verify_before_repeat",
): "use_result" | "reobserve" | "verify" | "end" {
  if (outcome.status === "succeeded") return "use_result";
  if (outcome.status === "unknown") return "verify";
  if (outcome.effect === "confirmed") return "verify";
  if (
    outcome.status === "cancelled" ||
    outcome.code === "policy_denied" ||
    outcome.code === "execution_revoked"
  )
    return "end";
  return policy === "safe_repeat" ? "reobserve" : "verify";
}
