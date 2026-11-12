import assert from "node:assert/strict";
import { createDatabasePool } from "@pba/persistence";
import { Connection } from "@temporalio/client";

if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is missing. Run pnpm env:init.");
const pool = createDatabasePool(process.env.DATABASE_URL);
try {
  const result = await pool.query<{ ready: number }>("SELECT 1 AS ready");
  assert.equal(result.rows[0]?.ready, 1);
  console.log("PASS: PostgreSQL connection and query.");
} finally {
  await pool.end();
}
const connection = await Connection.connect({ address: process.env.TEMPORAL_ADDRESS ?? "127.0.0.1:7233" });
try {
  const namespace = process.env.TEMPORAL_NAMESPACE ?? "default";
  const description = await connection.workflowService.describeNamespace({ namespace });
  assert.equal(description.namespaceInfo?.name, namespace);
  console.log("PASS: Temporal connection and namespace.");
} finally {
  await connection.close();
}
