import { createHash } from "node:crypto";
import {
  type ActionReceipt,
  type ActionRequest,
  type ActionResult,
  parseActionReceipt,
  parseActionRequest,
  type SessionLease,
} from "@pba/contracts/runtime";
import type { Pool } from "pg";
import { StoreError, TaskStore } from "./index.ts";

export function actionFingerprint(request: ActionRequest): string {
  return createHash("sha256")
    .update(JSON.stringify(parseActionRequest(request)))
    .digest("hex");
}
export function unknownReceipt(request: ActionRequest): ActionReceipt {
  return {
    result: {
      protocolVersion: 1,
      actionId: request.actionId,
      runId: request.runId,
      executionEpoch: request.executionEpoch,
      outcome: { status: "unknown", code: "outcome_unknown" },
    },
    extractedText: null,
  };
}
interface Row {
  fingerprint: string;
  result: ActionResult | null;
  extracted_text: string | null;
}
function replay(row: Row, request: ActionRequest): ActionReceipt {
  if (row.fingerprint !== actionFingerprint(request))
    throw new StoreError("Action ID has different parameters", 409);
  return row.result
    ? parseActionReceipt({ result: row.result, extractedText: row.extracted_text })
    : unknownReceipt(request);
}

// Stores fingerprints, not raw fill arguments. A durable dispatch reservation is never executed twice.
export class ActionLedger {
  private readonly pool: Pool;
  private readonly transactions: TaskStore;
  constructor(pool: Pool) {
    this.pool = pool;
    this.transactions = new TaskStore(pool);
  }
  async lookup(request: ActionRequest): Promise<ActionReceipt | null> {
    const rows = await this.pool.query<Row>(
      "SELECT fingerprint,result,extracted_text FROM agent_actions WHERE workspace_id=$1 AND run_id=$2 AND action_id=$3",
      [request.workspaceId, request.runId, request.actionId],
    );
    return rows.rows[0] ? replay(rows.rows[0], request) : null;
  }
  async admit(request: ActionRequest, lease: SessionLease): Promise<ActionReceipt | null> {
    return this.transactions.transaction(async (client) => {
      const run = await client.query<{ status: string; execution_epoch: number; session_id: string }>(
        "SELECT status,execution_epoch,session_id FROM agent_runs WHERE workspace_id=$1 AND run_id=$2 FOR UPDATE",
        [request.workspaceId, request.runId],
      );
      const old = await client.query<Row>(
        "SELECT fingerprint,result,extracted_text FROM agent_actions WHERE workspace_id=$1 AND run_id=$2 AND action_id=$3",
        [request.workspaceId, request.runId, request.actionId],
      );
      if (old.rows[0]) return replay(old.rows[0], request);
      const current = run.rows[0];
      if (
        current?.status !== "running" ||
        current.execution_epoch !== request.executionEpoch ||
        current.session_id !== request.sessionId ||
        lease.workspaceId !== request.workspaceId ||
        lease.runId !== request.runId ||
        lease.sessionId !== request.sessionId ||
        lease.executionEpoch !== request.executionEpoch
      )
        throw new StoreError("execution_revoked", 409);
      const session = await client.query(
        `SELECT 1 FROM agent_sessions WHERE workspace_id=$1 AND session_id=$2 AND owner_id=$3
         AND execution_epoch=$4 AND state='active' AND lease_until>clock_timestamp() FOR UPDATE`,
        [request.workspaceId, request.sessionId, lease.ownerId, request.executionEpoch],
      );
      if (!session.rowCount) throw new StoreError("execution_revoked", 409);
      if (request.deadlineAt <= Date.now()) throw new StoreError("deadline_exceeded", 409);
      const busy = await client.query(
        "SELECT 1 FROM agent_actions WHERE workspace_id=$1 AND run_id=$2 AND (result IS NULL OR result->'outcome'->>'status'='unknown')",
        [request.workspaceId, request.runId],
      );
      if (busy.rowCount) throw new StoreError("An unresolved action requires verification", 409);
      await client.query(
        `INSERT INTO agent_actions(workspace_id,run_id,action_id,session_id,step_id,execution_epoch,owner_id,fingerprint,action_type,deadline_at)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [
          request.workspaceId,
          request.runId,
          request.actionId,
          request.sessionId,
          request.stepId,
          request.executionEpoch,
          lease.ownerId,
          actionFingerprint(request),
          request.action.type,
          request.deadlineAt,
        ],
      );
      return null;
    });
  }
  async finish(request: ActionRequest, receipt: ActionReceipt): Promise<ActionReceipt> {
    const { result } = parseActionReceipt(receipt);
    if (
      result.actionId !== request.actionId ||
      result.runId !== request.runId ||
      result.executionEpoch !== request.executionEpoch ||
      (receipt.extractedText !== null &&
        (request.action.type !== "extract" || receipt.extractedText.length > 10_000))
    )
      throw new Error("Invalid action receipt");
    const rows = await this.pool.query<Row>(
      `UPDATE agent_actions SET result=COALESCE(result,$5::jsonb),extracted_text=CASE WHEN result IS NULL THEN $6 ELSE extracted_text END,
       finished_at=COALESCE(finished_at,now()) WHERE workspace_id=$1 AND run_id=$2 AND action_id=$3 AND fingerprint=$4
       RETURNING fingerprint,result,extracted_text`,
      [
        request.workspaceId,
        request.runId,
        request.actionId,
        actionFingerprint(request),
        result,
        receipt.extractedText,
      ],
    );
    if (!rows.rows[0]) throw new StoreError("Action reservation missing", 409);
    return replay(rows.rows[0], request);
  }
}
