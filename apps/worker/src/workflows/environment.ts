import { proxyActivities } from "@temporalio/workflow";
import type * as activities from "../activities/environment.ts";

const { inspectEnvironment } = proxyActivities<typeof activities>({ startToCloseTimeout: "10 seconds" });

export async function environmentCheck() {
  return inspectEnvironment();
}
