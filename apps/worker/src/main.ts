import { fileURLToPath } from "node:url";
import { NativeConnection, Worker } from "@temporalio/worker";
import * as environment from "./activities/environment.ts";
import { closeTaskActivities, finishTask, readPausableTaskPage, readTaskPage } from "./activities/tasks.ts";

const connection = await NativeConnection.connect({
  address: process.env.TEMPORAL_ADDRESS ?? "127.0.0.1:7233",
});
try {
  const worker = await Worker.create({
    connection,
    namespace: process.env.TEMPORAL_NAMESPACE ?? "default",
    taskQueue: process.env.TEMPORAL_TASK_QUEUE ?? "pba-local",
    workflowsPath: fileURLToPath(new URL("./workflows/index.ts", import.meta.url)),
    activities: { ...environment, readTaskPage, readPausableTaskPage, finishTask },
  });
  await worker.run();
} finally {
  await closeTaskActivities();
  await connection.close();
}
