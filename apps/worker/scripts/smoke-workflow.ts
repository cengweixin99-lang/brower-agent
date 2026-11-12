import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Client, Connection } from "@temporalio/client";

const connection = await Connection.connect({ address: process.env.TEMPORAL_ADDRESS ?? "127.0.0.1:7233" });
try {
  const client = new Client({ connection, namespace: process.env.TEMPORAL_NAMESPACE ?? "default" });
  const result: unknown = await client.workflow.execute("environmentCheck", {
    taskQueue: process.env.TEMPORAL_TASK_QUEUE ?? "pba-local",
    workflowId: `environment-check-${randomUUID()}`,
    workflowExecutionTimeout: "30 seconds",
  });
  assert.ok(typeof result === "object" && result !== null && "status" in result && result.status === "ok");
  console.log("PASS: Temporal workflow and activity executed by the worker.");
} finally {
  await connection.close();
}
