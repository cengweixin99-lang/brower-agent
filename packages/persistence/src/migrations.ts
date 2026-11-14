import { createHash } from "node:crypto";
import type { Pool } from "pg";

// Append migrations; never edit applied SQL. All changes here are additive to legacy tables.
const migrations = [
  {
    version: 1,
    sql: `
CREATE TABLE agent_tasks (
  workspace_id text NOT NULL, task_id text NOT NULL, definition jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(workspace_id,task_id)
);
CREATE TABLE agent_runs (
  workspace_id text NOT NULL, run_id text NOT NULL, task_id text NOT NULL,
  status text NOT NULL CHECK(status IN ('queued','running','waiting','pausing','paused','stopping','stopped','completed','failed')),
  version integer NOT NULL CHECK(version>0), execution_epoch integer NOT NULL CHECK(execution_epoch>0),
  execution_version integer NOT NULL DEFAULT 3 CHECK(execution_version=3),
  waiting_reason text CHECK(waiting_reason IN ('input','approval','login','handoff','verification')),
  session_id text, error_code text,
  created_at timestamptz NOT NULL DEFAULT now(), ended_at timestamptz,
  PRIMARY KEY(workspace_id,run_id), FOREIGN KEY(workspace_id,task_id) REFERENCES agent_tasks(workspace_id,task_id),
  CHECK((status='waiting')=(waiting_reason IS NOT NULL)),
  CHECK((status IN ('stopped','completed','failed'))=(ended_at IS NOT NULL))
);
CREATE INDEX agent_runs_queue ON agent_runs(status,created_at);
CREATE TABLE agent_sessions (
  workspace_id text NOT NULL, session_id text NOT NULL, run_id text NOT NULL,
  owner_id text NOT NULL, execution_epoch integer NOT NULL CHECK(execution_epoch>0),
  state text NOT NULL CHECK(state IN ('opening','active','quarantined','closed')),
  slot text NOT NULL DEFAULT 'personal' CHECK(slot='personal'),
  lease_until timestamptz NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), closed_at timestamptz,
  PRIMARY KEY(workspace_id,session_id), UNIQUE(workspace_id,run_id,session_id),
  FOREIGN KEY(workspace_id,run_id) REFERENCES agent_runs(workspace_id,run_id),
  CHECK((state='closed')=(closed_at IS NOT NULL))
);
CREATE UNIQUE INDEX agent_sessions_slot ON agent_sessions(slot) WHERE state<>'closed';
ALTER TABLE agent_runs ADD CONSTRAINT agent_run_session FOREIGN KEY(workspace_id,run_id,session_id)
  REFERENCES agent_sessions(workspace_id,run_id,session_id);
CREATE TABLE agent_commands (
  workspace_id text NOT NULL, run_id text NOT NULL, command_id text NOT NULL,
  kind text NOT NULL CHECK(kind='stop'), expected_version integer NOT NULL, result jsonb NOT NULL,
  PRIMARY KEY(workspace_id,run_id,command_id),
  FOREIGN KEY(workspace_id,run_id) REFERENCES agent_runs(workspace_id,run_id)
);
CREATE TABLE agent_events (
  workspace_id text NOT NULL, run_id text NOT NULL, sequence integer NOT NULL,
  type text NOT NULL, snapshot jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(workspace_id,run_id,sequence), FOREIGN KEY(workspace_id,run_id) REFERENCES agent_runs(workspace_id,run_id)
);
CREATE TABLE agent_outbox (
  workspace_id text NOT NULL, run_id text NOT NULL, sequence integer NOT NULL,
  delivered_at timestamptz, PRIMARY KEY(workspace_id,run_id,sequence),
  FOREIGN KEY(workspace_id,run_id,sequence) REFERENCES agent_events(workspace_id,run_id,sequence)
);
CREATE INDEX agent_outbox_pending ON agent_outbox(workspace_id,run_id,sequence) WHERE delivered_at IS NULL;
`,
  },
  {
    version: 2,
    sql: `
CREATE TABLE agent_artifacts (
  workspace_id text NOT NULL, run_id text NOT NULL, artifact_id text NOT NULL UNIQUE,
  mime_type text NOT NULL CHECK(mime_type='image/png'), sha256 text NOT NULL CHECK(sha256 ~ '^[a-f0-9]{64}$'),
  byte_length integer NOT NULL CHECK(byte_length>0 AND byte_length<=5000000), created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(workspace_id,run_id,artifact_id), FOREIGN KEY(workspace_id,run_id) REFERENCES agent_runs(workspace_id,run_id)
);
CREATE TABLE agent_observations (
  workspace_id text NOT NULL, run_id text NOT NULL, session_id text NOT NULL, observation_id text NOT NULL,
  execution_epoch integer NOT NULL CHECK(execution_epoch>0), sequence integer NOT NULL CHECK(sequence>0),
  screenshot_artifact_id text NOT NULL, snapshot jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(workspace_id,run_id,observation_id), UNIQUE(workspace_id,session_id,sequence),
  UNIQUE(workspace_id,run_id,session_id,observation_id),
  FOREIGN KEY(workspace_id,run_id,session_id) REFERENCES agent_sessions(workspace_id,run_id,session_id),
  FOREIGN KEY(workspace_id,run_id,screenshot_artifact_id) REFERENCES agent_artifacts(workspace_id,run_id,artifact_id)
);
ALTER TABLE agent_sessions ADD COLUMN latest_observation_id text;
ALTER TABLE agent_sessions ADD CONSTRAINT agent_session_observation FOREIGN KEY(workspace_id,run_id,session_id,latest_observation_id)
  REFERENCES agent_observations(workspace_id,run_id,session_id,observation_id);
`,
  },
  {
    version: 3,
    sql: `
CREATE TABLE agent_actions (
  workspace_id text NOT NULL, run_id text NOT NULL, action_id text NOT NULL, session_id text NOT NULL,
  step_id text NOT NULL, execution_epoch integer NOT NULL CHECK(execution_epoch>0), owner_id text NOT NULL,
  fingerprint text NOT NULL CHECK(fingerprint ~ '^[a-f0-9]{64}$'),
  action_type text NOT NULL CHECK(action_type IN ('navigate','click','fill','select','scroll','pressKey','wait','extract')),
  deadline_at bigint NOT NULL, result jsonb, extracted_text text CHECK(length(extracted_text)<=10000),
  created_at timestamptz NOT NULL DEFAULT now(), finished_at timestamptz,
  PRIMARY KEY(workspace_id,run_id,action_id),
  FOREIGN KEY(workspace_id,run_id,session_id) REFERENCES agent_sessions(workspace_id,run_id,session_id),
  CHECK((result IS NULL)=(finished_at IS NULL))
);
CREATE UNIQUE INDEX agent_actions_pending ON agent_actions(workspace_id,run_id) WHERE result IS NULL;
`,
  },
] as const;

export async function migrateRuntime(pool: Pool): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext(current_schema()),724923)");
    await client.query(
      "CREATE TABLE IF NOT EXISTS agent_schema_migrations(version integer PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())",
    );
    const applied = await client.query<{ version: number; checksum: string }>(
      "SELECT version,checksum FROM agent_schema_migrations ORDER BY version",
    );
    if (applied.rows.some((row) => !migrations.some((migration) => migration.version === row.version)))
      throw new Error("Runtime schema is newer than this application");
    for (const migration of migrations) {
      const checksum = createHash("sha256").update(migration.sql).digest("hex");
      const existing = applied.rows.find((row) => row.version === migration.version);
      if (existing) {
        if (existing.checksum !== checksum) throw new Error("Runtime migration checksum mismatch");
        continue;
      }
      await client.query(migration.sql);
      await client.query("INSERT INTO agent_schema_migrations(version,checksum) VALUES($1,$2)", [
        migration.version,
        checksum,
      ]);
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
