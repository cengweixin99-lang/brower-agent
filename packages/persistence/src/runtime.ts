import { randomUUID } from "node:crypto";
import {
  type AgentRun,
  type AgentTask,
  isRunTerminal,
  type ObservationSnapshot,
  parseAgentRun,
  parseAgentTask,
  parseObservationSnapshot,
  parseScreenshotArtifact,
  parseSessionRequest,
  parseStopRunRequest,
  type ScreenshotArtifact,
  type SessionLease,
  type SessionRequest,
  transitionRun,
} from "@pba/contracts/runtime";
import type { Pool, PoolClient } from "pg";
import { StoreError, TaskStore } from "./index.ts";

export type { ActionReceipt } from "@pba/contracts/runtime";
export { ActionLedger, actionFingerprint, unknownReceipt } from "./actions.ts";

interface RunRow {
  workspace_id: string;
  run_id: string;
  task_id: string;
  status: AgentRun["status"];
  version: number;
  execution_epoch: number;
  waiting_reason: AgentRun["waitingReason"];
  session_id: string | null;
  error_code: string | null;
}
interface SessionRow {
  workspace_id: string;
  run_id: string;
  session_id: string;
  owner_id: string;
  execution_epoch: number;
  state: SessionLease["state"];
}
function run(row: RunRow): AgentRun {
  return parseAgentRun({
    protocolVersion: 1,
    executionVersion: 3,
    workspaceId: row.workspace_id,
    runId: row.run_id,
    taskId: row.task_id,
    status: row.status,
    version: row.version,
    executionEpoch: row.execution_epoch,
    waitingReason: row.waiting_reason,
    sessionId: row.session_id,
    checkpointStepId: null,
  });
}
function session(row: SessionRow): SessionLease {
  return {
    protocolVersion: 1,
    workspaceId: row.workspace_id,
    runId: row.run_id,
    sessionId: row.session_id,
    ownerId: row.owner_id,
    executionEpoch: row.execution_epoch,
    state: row.state,
  };
}

export class RuntimeStore {
  readonly pool: Pool;
  private readonly transactions: TaskStore;
  constructor(pool: Pool) {
    this.pool = pool;
    this.transactions = new TaskStore(pool);
  }
  async initialize(): Promise<void> {
    await this.transactions.initialize();
  }
  private async locked(client: PoolClient, workspaceId: string, runId: string): Promise<AgentRun> {
    const result = await client.query<RunRow>(
      "SELECT * FROM agent_runs WHERE workspace_id=$1 AND run_id=$2 FOR UPDATE",
      [workspaceId, runId],
    );
    const row = result.rows[0];
    if (!row) throw new StoreError("Run not found", 404);
    return run(row);
  }
  private async record(
    client: PoolClient,
    current: AgentRun,
    type: string,
    errorCode: string | null = null,
  ): Promise<void> {
    await client.query(
      `UPDATE agent_runs SET status=$3,version=$4,execution_epoch=$5,waiting_reason=$6,session_id=$7,
      error_code=COALESCE($8,error_code),ended_at=CASE WHEN $9 THEN COALESCE(ended_at,now()) ELSE NULL END
      WHERE workspace_id=$1 AND run_id=$2`,
      [
        current.workspaceId,
        current.runId,
        current.status,
        current.version,
        current.executionEpoch,
        current.waitingReason,
        current.sessionId,
        errorCode,
        isRunTerminal(current.status),
      ],
    );
    await client.query(
      "INSERT INTO agent_events(workspace_id,run_id,sequence,type,snapshot) VALUES($1,$2,$3,$4,$5)",
      [current.workspaceId, current.runId, current.version, type, current],
    );
    await client.query("INSERT INTO agent_outbox(workspace_id,run_id,sequence) VALUES($1,$2,$3)", [
      current.workspaceId,
      current.runId,
      current.version,
    ]);
  }
  async create(taskInput: unknown, runId: string): Promise<AgentRun> {
    const task = parseAgentTask(taskInput);
    parseSessionRequest({ protocolVersion: 1, workspaceId: task.workspaceId, runId, executionEpoch: 1 });
    return this.transactions.transaction(async (client) => {
      await client.query(
        "INSERT INTO agent_tasks(workspace_id,task_id,definition) VALUES($1,$2,$3) ON CONFLICT DO NOTHING",
        [task.workspaceId, task.taskId, task],
      );
      const same = await client.query<{ matches: boolean }>(
        "SELECT definition=$3::jsonb AS matches FROM agent_tasks WHERE workspace_id=$1 AND task_id=$2 FOR UPDATE",
        [task.workspaceId, task.taskId, task],
      );
      if (!same.rows[0]?.matches) throw new StoreError("Task ID has different parameters");
      const inserted = await client.query(
        "INSERT INTO agent_runs(workspace_id,run_id,task_id,status,version,execution_epoch) VALUES($1,$2,$3,'queued',1,1) ON CONFLICT DO NOTHING RETURNING run_id",
        [task.workspaceId, runId, task.taskId],
      );
      const current = await this.locked(client, task.workspaceId, runId);
      if (current.taskId !== task.taskId) throw new StoreError("Run ID belongs to another task");
      if (inserted.rowCount) await this.record(client, current, "run.created");
      return current;
    });
  }
  async get(workspaceId: string, runId: string): Promise<AgentRun | null> {
    const result = await this.pool.query<RunRow>(
      "SELECT * FROM agent_runs WHERE workspace_id=$1 AND run_id=$2",
      [workspaceId, runId],
    );
    return result.rows[0] ? run(result.rows[0]) : null;
  }
  async getTask(workspaceId: string, runId: string): Promise<AgentTask> {
    const result = await this.pool.query<{ definition: unknown }>(
      "SELECT t.definition FROM agent_tasks t JOIN agent_runs r USING(workspace_id,task_id) WHERE r.workspace_id=$1 AND r.run_id=$2",
      [workspaceId, runId],
    );
    if (!result.rows[0]) throw new StoreError("Run not found", 404);
    return parseAgentTask(result.rows[0].definition);
  }
  async getSession(workspaceId: string, runId: string): Promise<SessionLease | null> {
    const result = await this.pool.query<SessionRow>(
      "SELECT s.* FROM agent_sessions s JOIN agent_runs r ON (s.workspace_id=r.workspace_id AND s.run_id=r.run_id AND s.session_id=r.session_id) WHERE r.workspace_id=$1 AND r.run_id=$2",
      [workspaceId, runId],
    );
    return result.rows[0] ? session(result.rows[0]) : null;
  }
  async reserve(requestInput: SessionRequest, ownerId: string): Promise<SessionLease> {
    const request = parseSessionRequest(requestInput);
    return this.transactions.transaction(async (client) => {
      await client.query("SELECT pg_advisory_xact_lock(hashtext(current_schema()),724922)");
      const current = await this.locked(client, request.workspaceId, request.runId);
      if (
        current.executionEpoch !== request.executionEpoch ||
        !["queued", "running"].includes(current.status)
      )
        throw new StoreError("Run is not accepting a session", 409);
      if (current.sessionId) {
        const found = await client.query<SessionRow>(
          "SELECT * FROM agent_sessions WHERE workspace_id=$1 AND session_id=$2 FOR UPDATE",
          [request.workspaceId, current.sessionId],
        );
        const row = found.rows[0];
        if (
          !row ||
          row.owner_id !== ownerId ||
          !["opening", "active"].includes(row.state) ||
          row.execution_epoch !== current.executionEpoch
        )
          throw new StoreError("Session requires isolation or recovery", 409);
        const live = await client.query(
          "SELECT 1 FROM agent_sessions WHERE workspace_id=$1 AND session_id=$2 AND lease_until>now()",
          [request.workspaceId, current.sessionId],
        );
        if (!live.rowCount) throw new StoreError("Session lease expired", 409);
        return session(row);
      }
      const busy = await client.query(
        "SELECT 1 FROM browser_leases UNION ALL SELECT 1 FROM agent_sessions WHERE state<>'closed'",
      );
      if (busy.rowCount) throw new StoreError("Browser is busy; run remains queued", 409);
      const sessionId = randomUUID();
      const result = await client.query<SessionRow>(
        `INSERT INTO agent_sessions(workspace_id,session_id,run_id,owner_id,execution_epoch,state,lease_until)
        VALUES($1,$2,$3,$4,$5,'opening',now()+interval '10 seconds') RETURNING *`,
        [request.workspaceId, sessionId, request.runId, ownerId, request.executionEpoch],
      );
      await this.record(client, { ...current, sessionId, version: current.version + 1 }, "session.reserved");
      const row = result.rows[0];
      if (!row) throw new Error("Session insert failed");
      return session(row);
    });
  }
  async activate(lease: SessionLease): Promise<SessionLease> {
    return this.transactions.transaction(async (client) => {
      const current = await this.locked(client, lease.workspaceId, lease.runId);
      if (
        current.executionEpoch !== lease.executionEpoch ||
        current.sessionId !== lease.sessionId ||
        !["queued", "running"].includes(current.status)
      )
        throw new StoreError("Session opening was revoked", 409);
      const result = await client.query<SessionRow>(
        `UPDATE agent_sessions SET state='active',lease_until=now()+interval '10 seconds'
        WHERE workspace_id=$1 AND session_id=$2 AND owner_id=$3 AND execution_epoch=$4 AND state IN ('opening','active') AND lease_until>now() RETURNING *`,
        [lease.workspaceId, lease.sessionId, lease.ownerId, lease.executionEpoch],
      );
      if (!result.rows[0]) throw new StoreError("Session no longer owned", 409);
      if (current.status === "queued")
        await this.record(
          client,
          { ...current, ...transitionRun(current, { type: "start" }, "worker", current.version) },
          "run.started",
        );
      return session(result.rows[0]);
    });
  }
  async heartbeat(lease: SessionLease): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE agent_sessions s SET lease_until=now()+interval '10 seconds'
      FROM agent_runs r WHERE s.workspace_id=$1 AND s.session_id=$2 AND s.owner_id=$3 AND s.execution_epoch=$4
      AND s.state IN ('opening','active') AND s.lease_until>now() AND r.workspace_id=s.workspace_id AND r.run_id=s.run_id
      AND r.execution_epoch=s.execution_epoch AND r.status IN ('queued','running') RETURNING s.session_id`,
      [lease.workspaceId, lease.sessionId, lease.ownerId, lease.executionEpoch],
    );
    return Boolean(result.rowCount);
  }
  async requestStop(
    workspaceId: string,
    runId: string,
    commandId: string,
    expectedVersion: number,
  ): Promise<AgentRun> {
    parseStopRunRequest({ protocolVersion: 1, workspaceId, runId, commandId, expectedVersion });
    return this.transactions.transaction(async (client) => {
      const current = await this.locked(client, workspaceId, runId);
      const old = await client.query<{ expected_version: number; result: unknown }>(
        "SELECT expected_version,result FROM agent_commands WHERE workspace_id=$1 AND run_id=$2 AND command_id=$3",
        [workspaceId, runId, commandId],
      );
      if (old.rows[0]) {
        if (old.rows[0].expected_version !== expectedVersion)
          throw new StoreError("Command ID has different parameters");
        return parseAgentRun(old.rows[0].result);
      }
      if (current.version !== expectedVersion) throw new StoreError("Run version changed", 409);
      let next = current;
      if (!isRunTerminal(current.status) && current.status !== "stopping") {
        next = { ...current, ...transitionRun(current, { type: "stop" }, "api", expectedVersion) };
        await this.record(client, next, "run.stop_requested");
        if (!current.sessionId) {
          next = {
            ...next,
            ...transitionRun(next, { type: "stopped", quiescent: true }, "gateway", next.version),
          };
          await this.record(client, next, "run.stopped");
        }
      }
      await client.query(
        "INSERT INTO agent_commands(workspace_id,run_id,command_id,kind,expected_version,result) VALUES($1,$2,$3,'stop',$4,$5)",
        [workspaceId, runId, commandId, expectedVersion, next],
      );
      return next;
    });
  }
  async saveObservation(
    lease: SessionLease,
    input: ObservationSnapshot,
    artifactInput: ScreenshotArtifact,
  ): Promise<void> {
    const snapshot = parseObservationSnapshot(input);
    const artifact = parseScreenshotArtifact(artifactInput);
    const observation = snapshot.observation;
    if (
      observation.workspaceId !== lease.workspaceId ||
      observation.runId !== lease.runId ||
      observation.sessionId !== lease.sessionId ||
      observation.executionEpoch !== lease.executionEpoch ||
      observation.screenshotArtifactId !== artifact.artifactId
    )
      throw new StoreError("Observation ownership mismatch", 409);
    await this.transactions.transaction(async (client) => {
      const current = await this.locked(client, lease.workspaceId, lease.runId);
      if (
        current.status !== "running" ||
        current.executionEpoch !== lease.executionEpoch ||
        current.sessionId !== lease.sessionId
      )
        throw new StoreError("Observation was revoked", 409);
      const session = await client.query(
        `SELECT 1 FROM agent_sessions WHERE workspace_id=$1 AND session_id=$2
        AND owner_id=$3 AND execution_epoch=$4 AND state='active' AND lease_until>now() FOR UPDATE`,
        [lease.workspaceId, lease.sessionId, lease.ownerId, lease.executionEpoch],
      );
      if (!session.rowCount) throw new StoreError("Observation session is unavailable", 409);
      const newer = await client.query(
        "SELECT 1 FROM agent_observations WHERE workspace_id=$1 AND session_id=$2 AND sequence>=$3",
        [lease.workspaceId, lease.sessionId, snapshot.sequence],
      );
      if (newer.rowCount) throw new StoreError("Observation sequence is stale", 409);
      await client.query(
        "INSERT INTO agent_artifacts(workspace_id,run_id,artifact_id,mime_type,sha256,byte_length) VALUES($1,$2,$3,$4,$5,$6)",
        [
          lease.workspaceId,
          lease.runId,
          artifact.artifactId,
          artifact.mimeType,
          artifact.sha256,
          artifact.byteLength,
        ],
      );
      await client.query(
        `INSERT INTO agent_observations(workspace_id,run_id,session_id,observation_id,execution_epoch,sequence,screenshot_artifact_id,snapshot)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
        [
          lease.workspaceId,
          lease.runId,
          lease.sessionId,
          observation.observationId,
          lease.executionEpoch,
          snapshot.sequence,
          artifact.artifactId,
          snapshot,
        ],
      );
      await client.query(
        "UPDATE agent_sessions SET latest_observation_id=$3 WHERE workspace_id=$1 AND session_id=$2",
        [lease.workspaceId, lease.sessionId, observation.observationId],
      );
      await this.record(client, { ...current, version: current.version + 1 }, "observation.saved");
    });
  }
  async latestObservation(workspaceId: string, runId: string): Promise<ObservationSnapshot | null> {
    const result = await this.pool.query<{ snapshot: unknown }>(
      `SELECT o.snapshot FROM agent_observations o
      JOIN agent_sessions s ON s.workspace_id=o.workspace_id AND s.run_id=o.run_id AND s.session_id=o.session_id AND s.latest_observation_id=o.observation_id
      JOIN agent_runs r ON r.workspace_id=s.workspace_id AND r.run_id=s.run_id AND r.session_id=s.session_id
      WHERE r.workspace_id=$1 AND r.run_id=$2`,
      [workspaceId, runId],
    );
    return result.rows[0] ? parseObservationSnapshot(result.rows[0].snapshot) : null;
  }
  async getArtifact(
    workspaceId: string,
    runId: string,
    artifactId: string,
  ): Promise<ScreenshotArtifact | null> {
    const result = await this.pool.query<{ mime_type: string; sha256: string; byte_length: number }>(
      "SELECT mime_type,sha256,byte_length FROM agent_artifacts WHERE workspace_id=$1 AND run_id=$2 AND artifact_id=$3",
      [workspaceId, runId, artifactId],
    );
    const row = result.rows[0];
    return row
      ? parseScreenshotArtifact({
          artifactId,
          mimeType: row.mime_type,
          sha256: row.sha256,
          byteLength: row.byte_length,
        })
      : null;
  }
  // Only the owning gateway after actual context closure, or a trusted isolation operator, may call this.
  async closed(
    lease: SessionLease,
    reason: "session_closed" | "session_lost" | "open_failed",
  ): Promise<void> {
    await this.transactions.transaction(async (client) => {
      const current = await this.locked(client, lease.workspaceId, lease.runId);
      const released = await client.query(
        `UPDATE agent_sessions SET state='closed',closed_at=now()
        WHERE workspace_id=$1 AND session_id=$2 AND owner_id=$3 AND execution_epoch=$4 AND state<>'closed' RETURNING session_id`,
        [lease.workspaceId, lease.sessionId, lease.ownerId, lease.executionEpoch],
      );
      if (!released.rowCount) return;
      if (current.sessionId !== lease.sessionId)
        throw new StoreError("Session does not belong to current run");
      if (isRunTerminal(current.status)) return;
      const control =
        current.status === "stopping"
          ? transitionRun(current, { type: "stopped", quiescent: true }, "gateway", current.version)
          : transitionRun(current, { type: "fail", quiescent: true }, "worker", current.version);
      await this.record(
        client,
        { ...current, ...control },
        control.status === "stopped" ? "run.stopped" : "run.failed",
        control.status === "failed" ? reason : null,
      );
    });
  }
  // A lost DB owner lock does not prove its browser was killed. Never reclaim on TTL alone.
  async quarantineAbandoned(ownerId: string): Promise<void> {
    await this.transactions.transaction(async (client) => {
      await client.query("SELECT pg_advisory_xact_lock(hashtext(current_schema()),724922)");
      const candidates = await client.query<SessionRow>(
        "SELECT * FROM agent_sessions WHERE owner_id<>$1 AND state IN ('opening','active')",
        [ownerId],
      );
      for (const row of candidates.rows) {
        const current = await this.locked(client, row.workspace_id, row.run_id);
        const updated = await client.query(
          "UPDATE agent_sessions SET state='quarantined' WHERE workspace_id=$1 AND session_id=$2 AND state IN ('opening','active') RETURNING session_id",
          [row.workspace_id, row.session_id],
        );
        if (updated.rowCount)
          await this.record(
            client,
            { ...current, version: current.version + 1 },
            "session.quarantined",
            "session_lost",
          );
      }
    });
  }
}
