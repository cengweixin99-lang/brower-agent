import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ContractError,
  type ObservationSnapshot,
  parseActionReceipt,
  parseArtifactRequest,
  parseObservationSnapshot,
  parseScreenshotArtifact,
  parseTargetValidationRequest,
} from "./index.ts";

const snapshot: ObservationSnapshot = {
  sequence: 1,
  truncated: false,
  frames: [
    { frameId: "root", parentFrameId: null, documentId: "doc", url: "https://example.com/" },
    { frameId: "child", parentFrameId: "root", documentId: "child-doc", url: "about:srcdoc" },
  ],
  observation: {
    protocolVersion: 1,
    workspaceId: "local",
    runId: "run",
    sessionId: "session",
    executionEpoch: 1,
    tabId: "tab",
    observationId: "observation",
    documentId: "doc",
    capturedAt: 100,
    url: "https://example.com/",
    title: "Page",
    text: "Visible text",
    screenshotArtifactId: "artifact",
    elements: [{ elementId: "element-0", frameId: "child", role: "button", name: "Save" }],
  },
};
test("action receipts bound extracted content and reject evidence on uncertain outcomes", () => {
  const result = {
    protocolVersion: 1,
    actionId: "action",
    runId: "run",
    executionEpoch: 1,
    outcome: { status: "succeeded", observationId: "observation" },
  };
  const receipt = { result, extractedText: "value" };
  assert.deepEqual(parseActionReceipt(receipt), receipt);
  assert.throws(() => parseActionReceipt({ ...receipt, extractedText: "x".repeat(10_001) }), ContractError);
  assert.throws(
    () =>
      parseActionReceipt({
        ...receipt,
        result: { ...result, outcome: { status: "unknown", code: "outcome_unknown" } },
      }),
    ContractError,
  );
  assert.throws(() => parseActionReceipt({ ...receipt, approved: true }), ContractError);
});
test("observation frame trees and element references are validated without breaking base DTOs", () => {
  assert.deepEqual(parseObservationSnapshot(snapshot), snapshot);
  for (const invalid of [
    { ...snapshot, sequence: 0 },
    { ...snapshot, truncated: "false" },
    { ...snapshot, frames: [] },
    { ...snapshot, frames: [...snapshot.frames, snapshot.frames[1]] },
    { ...snapshot, frames: [...snapshot.frames].reverse() },
    { ...snapshot, frames: [{ ...snapshot.frames[0], documentId: "different" }] },
    { ...snapshot, frames: [{ ...snapshot.frames[0], url: "https://wrong.example/" }] },
    {
      ...snapshot,
      observation: {
        ...snapshot.observation,
        elements: [{ elementId: "x", frameId: "missing", role: "button", name: "x" }],
      },
    },
  ])
    assert.throws(() => parseObservationSnapshot(invalid), ContractError);
});
test("artifact and validation requests reject paths, extra authority, and invalid integrity metadata", () => {
  const request = {
    protocolVersion: 1,
    workspaceId: "local",
    runId: "run",
    executionEpoch: 1,
    target: { observationId: "observation", documentId: "doc", frameId: "root", elementId: "element-0" },
  };
  assert.deepEqual(parseTargetValidationRequest(request), request);
  assert.throws(() => parseTargetValidationRequest({ ...request, approved: true }), ContractError);
  assert.throws(
    () =>
      parseArtifactRequest({
        protocolVersion: 1,
        workspaceId: "local",
        runId: "run",
        artifactId: "../secret",
      }),
    ContractError,
  );
  const artifact = { artifactId: "artifact", mimeType: "image/png", sha256: "a".repeat(64), byteLength: 100 };
  assert.deepEqual(parseScreenshotArtifact(artifact), artifact);
  for (const invalid of [
    { ...artifact, byteLength: 5_000_001 },
    { ...artifact, sha256: "bad" },
    { ...artifact, mimeType: "text/html" },
  ])
    assert.throws(() => parseScreenshotArtifact(invalid), ContractError);
});
