import { type ElementTarget, type Observation, parseObservation, parseTarget } from "./browser.ts";
import { parseSessionRequest, type SessionRequest } from "./session.ts";
import {
  ContractError,
  httpUrl,
  id,
  integer,
  list,
  nullableId,
  object,
  string,
  version,
} from "./validation.ts";

export interface ObservedFrame {
  frameId: string;
  parentFrameId: string | null;
  documentId: string;
  url: string;
}
export interface ObservationSnapshot {
  observation: Observation;
  sequence: number;
  frames: ObservedFrame[];
  truncated: boolean;
}
export interface ScreenshotArtifact {
  artifactId: string;
  mimeType: "image/png";
  sha256: string;
  byteLength: number;
}
export interface TargetValidationRequest extends SessionRequest {
  target: ElementTarget;
}
export interface ArtifactRequest {
  protocolVersion: 1;
  workspaceId: string;
  runId: string;
  artifactId: string;
}
export function parseObservationSnapshot(value: unknown): ObservationSnapshot {
  const row = object(value, ["observation", "sequence", "frames", "truncated"], "snapshot");
  const observation = parseObservation(row.observation);
  const frames = list(
    row.frames,
    (item): ObservedFrame => {
      const frame = object(item, ["frameId", "parentFrameId", "documentId", "url"], "frame");
      const url =
        frame.url === "about:blank" || frame.url === "about:srcdoc"
          ? frame.url
          : httpUrl(frame.url, "frame.url");
      return {
        frameId: id(frame.frameId, "frameId"),
        parentFrameId: nullableId(frame.parentFrameId, "parentFrameId"),
        documentId: id(frame.documentId, "frame.documentId"),
        url,
      };
    },
    "frames",
    20,
    1,
  );
  const frameIds = new Set(frames.map((frame) => frame.frameId));
  if (frameIds.size !== frames.length || frames.filter((frame) => frame.parentFrameId === null).length !== 1)
    throw new ContractError("frames.tree");
  const seen = new Set<string>();
  for (const frame of frames) {
    if (frame.parentFrameId !== null && !seen.has(frame.parentFrameId))
      throw new ContractError("frames.parent");
    seen.add(frame.frameId);
  }
  if (
    frames[0]?.documentId !== observation.documentId ||
    frames[0]?.url !== observation.url ||
    observation.elements.some((element) => !frameIds.has(element.frameId))
  )
    throw new ContractError("frames.references");
  if (typeof row.truncated !== "boolean") throw new ContractError("truncated");
  return { observation, frames, sequence: integer(row.sequence, "sequence", 1), truncated: row.truncated };
}
export function parseScreenshotArtifact(value: unknown): ScreenshotArtifact {
  const row = object(value, ["artifactId", "mimeType", "sha256", "byteLength"], "artifact");
  if (row.mimeType !== "image/png") throw new ContractError("mimeType");
  const sha256 = string(row.sha256, "sha256", 64, 64);
  if (!/^[a-f0-9]{64}$/.test(sha256)) throw new ContractError("sha256");
  return {
    artifactId: id(row.artifactId, "artifactId"),
    mimeType: "image/png",
    sha256,
    byteLength: integer(row.byteLength, "byteLength", 1, 5_000_000),
  };
}
export function parseTargetValidationRequest(value: unknown): TargetValidationRequest {
  const row = object(
    value,
    ["protocolVersion", "workspaceId", "runId", "executionEpoch", "target"],
    "targetRequest",
  );
  return {
    ...parseSessionRequest({
      protocolVersion: row.protocolVersion,
      workspaceId: row.workspaceId,
      runId: row.runId,
      executionEpoch: row.executionEpoch,
    }),
    target: parseTarget(row.target),
  };
}
export function parseArtifactRequest(value: unknown): ArtifactRequest {
  const row = object(value, ["protocolVersion", "workspaceId", "runId", "artifactId"], "artifactRequest");
  return {
    protocolVersion: version(row.protocolVersion),
    workspaceId: id(row.workspaceId, "workspaceId"),
    runId: id(row.runId, "runId"),
    artifactId: id(row.artifactId, "artifactId"),
  };
}
