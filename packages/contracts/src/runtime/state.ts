import type { RunControl, RunStatus, WaitingReason } from "./run.ts";

export type RunActor = "api" | "worker" | "gateway";
export type RunEvent =
  | { type: "start" }
  | { type: "pause" }
  | { type: "paused"; quiescent: boolean }
  | { type: "resume" }
  | { type: "wait"; reason: WaitingReason; quiescent: boolean }
  | { type: "continue"; resolvedReason: WaitingReason }
  | { type: "stop" }
  | { type: "stopped"; quiescent: boolean }
  | { type: "complete"; quiescent: boolean; evidenceVerified: boolean }
  | { type: "fail"; quiescent: boolean };

const actors: Record<RunEvent["type"], readonly RunActor[]> = {
  start: ["worker"],
  pause: ["api"],
  paused: ["worker", "gateway"],
  resume: ["api"],
  wait: ["worker"],
  continue: ["worker"],
  stop: ["api"],
  stopped: ["worker", "gateway"],
  complete: ["worker"],
  fail: ["worker"],
};

export class TransitionError extends Error {
  readonly code: "wrong_actor" | "version_conflict" | "invalid_transition" | "unsafe_transition";
  constructor(code: TransitionError["code"]) {
    super(code);
    this.code = code;
  }
}

export function isRunTerminal(status: RunStatus): boolean {
  return status === "stopped" || status === "completed" || status === "failed";
}

// Pure domain rule. P03 must call it under a DB lock with command deduplication.
// actor/quiescent/evidenceVerified come from trusted service facts, never HTTP/model claims.
export function transitionRun(
  current: RunControl,
  event: RunEvent,
  actor: RunActor,
  expectedVersion: number,
): RunControl {
  if (current.version !== expectedVersion) throw new TransitionError("version_conflict");
  if (!actors[event.type].includes(actor)) throw new TransitionError("wrong_actor");
  if (isRunTerminal(current.status)) throw new TransitionError("invalid_transition");
  if ("quiescent" in event && !event.quiescent) throw new TransitionError("unsafe_transition");
  let status: RunStatus;
  let waitingReason: WaitingReason | null = null;
  let executionEpoch = current.executionEpoch;
  switch (event.type) {
    case "start":
      requireStatus(current, ["queued"]);
      status = "running";
      break;
    case "pause":
      // Waiting has its own resolution path; resume must never bypass an approval.
      requireStatus(current, ["queued", "running"]);
      status = "pausing";
      break;
    case "paused":
      requireStatus(current, ["pausing"]);
      status = "paused";
      executionEpoch++;
      break;
    case "resume":
      requireStatus(current, ["paused"]);
      status = "queued";
      break;
    case "wait":
      requireStatus(current, ["running"]);
      status = "waiting";
      waitingReason = event.reason;
      executionEpoch++;
      break;
    case "continue":
      requireStatus(current, ["waiting"]);
      if (current.waitingReason !== event.resolvedReason) throw new TransitionError("unsafe_transition");
      status = "queued";
      break;
    case "stop":
      requireStatus(current, ["queued", "running", "waiting", "pausing", "paused"]);
      status = "stopping";
      executionEpoch++;
      break;
    case "stopped":
      requireStatus(current, ["stopping"]);
      status = "stopped";
      break;
    case "complete":
      requireStatus(current, ["running", "pausing"]);
      if (!event.evidenceVerified) throw new TransitionError("unsafe_transition");
      status = "completed";
      break;
    case "fail":
      requireStatus(current, ["queued", "running", "waiting", "pausing", "paused"]);
      status = "failed";
      break;
  }
  if (!Number.isSafeInteger(executionEpoch) || !Number.isSafeInteger(current.version + 1))
    throw new TransitionError("unsafe_transition");
  return { status, waitingReason, executionEpoch, version: current.version + 1 };
}

function requireStatus(current: RunControl, allowed: readonly RunStatus[]): void {
  if (!allowed.includes(current.status)) throw new TransitionError("invalid_transition");
}

export function canAdmitAction(current: RunControl, executionEpoch: number): boolean {
  return current.status === "running" && current.executionEpoch === executionEpoch;
}
