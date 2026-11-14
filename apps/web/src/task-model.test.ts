import assert from "node:assert/strict";
import { test } from "node:test";
import type { TaskSummary } from "@pba/contracts";
import { duration, mergeSnapshots } from "./task-model.ts";

const task: TaskSummary = {
  id: "one",
  title: "Research",
  prompt: "Read page",
  urls: ["https://example.com/"],
  status: "running",
  phase: "Reading",
  version: 3,
  createdAt: "2026-11-13T00:00:00.000Z",
  startedAt: "2026-11-13T00:00:01.000Z",
  endedAt: null,
  sourceCount: 0,
  error: null,
};
test("late polling cannot roll back a stop response or terminal state", () => {
  const stopping: TaskSummary = { ...task, status: "stopping", version: 4 };
  const stopped: TaskSummary = {
    ...stopping,
    status: "stopped",
    version: 5,
    endedAt: "2026-11-13T00:00:12.000Z",
  };
  assert.deepEqual(mergeSnapshots([stopping], [task]), [stopping]);
  assert.deepEqual(mergeSnapshots([stopped], [task, stopping]), [stopped]);
  assert.equal(duration(stopped), "00:11");
});
test("new tasks are merged without disappearing on an older list response and newest sorts first", () => {
  const newer = { ...task, id: "two", createdAt: "2026-11-13T00:01:00.000Z" };
  assert.deepEqual(
    mergeSnapshots([newer], [task]).map((row) => row.id),
    ["two", "one"],
  );
  assert.equal(mergeSnapshots([task], [{ ...task, version: 4, sourceCount: 1 }])[0]?.sourceCount, 1);
});

test("paused duration freezes and resume/stop exclude acknowledged pause time", () => {
  const paused: TaskSummary = {
    ...task,
    status: "paused",
    version: 4,
    pausedAt: "2026-11-13T00:00:12.000Z",
    pausedMs: 2000,
  };
  assert.equal(duration(paused), "00:09");
  assert.deepEqual(mergeSnapshots([paused], [task]), [paused]);
  const ended: TaskSummary = {
    ...paused,
    status: "stopped",
    pausedAt: null,
    pausedMs: 62000,
    endedAt: "2026-11-13T00:01:12.000Z",
  };
  assert.equal(duration(ended), "00:09");
});
