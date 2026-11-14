import { continueAsNew, proxyActivities, sleep } from "@temporalio/workflow";
import type * as activities from "../activities/tasks.ts";

const { readTaskPage, finishTask } = proxyActivities<typeof activities>({
  startToCloseTimeout: "90 seconds",
  scheduleToCloseTimeout: "10 minutes",
  retry: { initialInterval: "1 second", maximumInterval: "10 seconds" },
});
// Durable, deterministic orchestration only. DB/network/browser work lives in activities.
export async function executeTask(id: string, count: number): Promise<void> {
  try {
    for (let index = 0; index < count; index += 1) if (!(await readTaskPage(id, index))) break;
    await finishTask(id, false);
  } catch {
    await finishTask(id, true);
  }
}

// Separate workflow type keeps histories of tasks started before pause support replay-compatible.
const { readPausableTaskPage } = proxyActivities<typeof activities>({
  startToCloseTimeout: "90 seconds",
  scheduleToCloseTimeout: "10 minutes",
  retry: { initialInterval: "1 second", maximumInterval: "10 seconds" },
});
export async function executePausableTask(id: string, count: number, nextIndex = 0): Promise<void> {
  let index = nextIndex;
  let polls = 0;
  try {
    while (index < count) {
      const result = await readPausableTaskPage(id, index);
      if (result === "end") break;
      if (result === "advance") index += 1;
      else await sleep("2 seconds");
      polls += 1;
      if (polls >= 120 && index < count) break;
    }
    if (index >= count || polls < 120) {
      await finishTask(id, false);
      return;
    }
  } catch {
    await finishTask(id, true);
    return;
  }
  // Outside catch: ContinueAsNew is a control-flow exception, not task failure.
  await continueAsNew<typeof executePausableTask>(id, count, index);
}
