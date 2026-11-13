import { id, integer, object, version } from "./validation.ts";

export interface SessionRequest {
  protocolVersion: 1;
  workspaceId: string;
  runId: string;
  executionEpoch: number;
}
export interface SessionLease extends SessionRequest {
  sessionId: string;
  ownerId: string;
  state: "opening" | "active" | "quarantined" | "closed";
}
export interface SessionView {
  session: SessionLease;
  tabId: string;
  url: string;
  title: string;
}
export interface StopRunRequest {
  protocolVersion: 1;
  workspaceId: string;
  runId: string;
  commandId: string;
  expectedVersion: number;
}
export function parseStopRunRequest(value: unknown): StopRunRequest {
  const row = object(
    value,
    ["protocolVersion", "workspaceId", "runId", "commandId", "expectedVersion"],
    "stopRequest",
  );
  return {
    protocolVersion: version(row.protocolVersion),
    workspaceId: id(row.workspaceId, "workspaceId"),
    runId: id(row.runId, "runId"),
    commandId: id(row.commandId, "commandId"),
    expectedVersion: integer(row.expectedVersion, "expectedVersion", 1),
  };
}
export function parseSessionRequest(value: unknown): SessionRequest {
  const row = object(value, ["protocolVersion", "workspaceId", "runId", "executionEpoch"], "sessionRequest");
  return {
    protocolVersion: version(row.protocolVersion),
    workspaceId: id(row.workspaceId, "workspaceId"),
    runId: id(row.runId, "runId"),
    executionEpoch: integer(row.executionEpoch, "executionEpoch", 1),
  };
}
