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

export interface RunBudget {
  maxSteps: number;
  maxModelCalls: number;
  maxTokens: number;
  maxDurationMs: number;
}
export const defaultRunBudget: Readonly<RunBudget> = Object.freeze({
  maxSteps: 40,
  maxModelCalls: 60,
  maxTokens: 100_000,
  maxDurationMs: 600_000,
});

export interface AgentTask {
  protocolVersion: 1;
  taskId: string;
  workspaceId: string;
  goal: string;
  startUrl: string | null;
  allowedOrigins: string[];
  acceptance: string[];
  budget: RunBudget;
}

export const runStatuses = [
  "queued",
  "running",
  "waiting",
  "pausing",
  "paused",
  "stopping",
  "stopped",
  "completed",
  "failed",
] as const;
export type RunStatus = (typeof runStatuses)[number];
export const waitingReasons = ["input", "approval", "login", "handoff", "verification"] as const;
export type WaitingReason = (typeof waitingReasons)[number];

export interface RunControl {
  status: RunStatus;
  version: number;
  executionEpoch: number;
  waitingReason: WaitingReason | null;
}
export interface AgentRun extends RunControl {
  protocolVersion: 1;
  executionVersion: 3;
  runId: string;
  taskId: string;
  workspaceId: string;
  sessionId: string | null;
  checkpointStepId: string | null;
}
export interface AgentStep {
  protocolVersion: 1;
  workspaceId: string;
  runId: string;
  stepId: string;
  sequence: number;
  observationId: string;
  decisionArtifactId: string | null;
  actionId: string | null;
  phase: "observing" | "deciding" | "authorizing" | "executing" | "verifying" | "recorded";
}

export function parseBudget(value: unknown): RunBudget {
  const row = object(value, ["maxSteps", "maxModelCalls", "maxTokens", "maxDurationMs"], "budget");
  return {
    maxSteps: integer(row.maxSteps, "maxSteps", 1, 1000),
    maxModelCalls: integer(row.maxModelCalls, "maxModelCalls", 1, 1000),
    maxTokens: integer(row.maxTokens, "maxTokens", 1, 1_000_000),
    maxDurationMs: integer(row.maxDurationMs, "maxDurationMs", 1000, 86_400_000),
  };
}

export function parseAgentTask(value: unknown): AgentTask {
  const row = object(
    value,
    [
      "protocolVersion",
      "taskId",
      "workspaceId",
      "goal",
      "startUrl",
      "allowedOrigins",
      "acceptance",
      "budget",
    ],
    "task",
  );
  const allowedOrigins = list(
    row.allowedOrigins,
    (item) => {
      const url = new URL(httpUrl(item, "allowedOrigins"));
      if (url.pathname !== "/" || url.search || url.hash) throw new ContractError("allowedOrigins");
      return url.origin;
    },
    "allowedOrigins",
    20,
    1,
  );
  if (new Set(allowedOrigins).size !== allowedOrigins.length)
    throw new ContractError("allowedOrigins.duplicate");
  const startUrl = row.startUrl === null ? null : httpUrl(row.startUrl, "startUrl");
  if (startUrl !== null && !allowedOrigins.includes(new URL(startUrl).origin))
    throw new ContractError("startUrl.origin");
  return {
    protocolVersion: version(row.protocolVersion),
    taskId: id(row.taskId, "taskId"),
    workspaceId: id(row.workspaceId, "workspaceId"),
    goal: string(row.goal, "goal", 10_000),
    startUrl,
    allowedOrigins,
    acceptance: list(row.acceptance, (item) => string(item, "acceptance", 1000), "acceptance", 20, 1),
    budget: parseBudget(row.budget),
  };
}

export function parseAgentRun(value: unknown): AgentRun {
  const row = object(
    value,
    [
      "protocolVersion",
      "executionVersion",
      "runId",
      "taskId",
      "workspaceId",
      "sessionId",
      "checkpointStepId",
      "status",
      "version",
      "executionEpoch",
      "waitingReason",
    ],
    "run",
  );
  if (row.executionVersion !== 3) throw new ContractError("executionVersion");
  const status = choice(row.status, runStatuses, "status");
  const waitingReason =
    row.waitingReason === null ? null : choice(row.waitingReason, waitingReasons, "waitingReason");
  if ((status === "waiting") !== (waitingReason !== null)) throw new ContractError("waitingReason");
  return {
    protocolVersion: version(row.protocolVersion),
    executionVersion: 3,
    runId: id(row.runId, "runId"),
    taskId: id(row.taskId, "taskId"),
    workspaceId: id(row.workspaceId, "workspaceId"),
    sessionId: nullableId(row.sessionId, "sessionId"),
    checkpointStepId: nullableId(row.checkpointStepId, "checkpointStepId"),
    status,
    waitingReason,
    version: integer(row.version, "version", 1),
    executionEpoch: integer(row.executionEpoch, "executionEpoch", 1),
  };
}

export function parseAgentStep(value: unknown): AgentStep {
  const row = object(
    value,
    [
      "protocolVersion",
      "workspaceId",
      "runId",
      "stepId",
      "sequence",
      "observationId",
      "decisionArtifactId",
      "actionId",
      "phase",
    ],
    "step",
  );
  return {
    protocolVersion: version(row.protocolVersion),
    workspaceId: id(row.workspaceId, "workspaceId"),
    runId: id(row.runId, "runId"),
    stepId: id(row.stepId, "stepId"),
    sequence: integer(row.sequence, "sequence", 1),
    observationId: id(row.observationId, "observationId"),
    decisionArtifactId: nullableId(row.decisionArtifactId, "decisionArtifactId"),
    actionId: nullableId(row.actionId, "actionId"),
    phase: choice(
      row.phase,
      ["observing", "deciding", "authorizing", "executing", "verifying", "recorded"],
      "phase",
    ),
  };
}
