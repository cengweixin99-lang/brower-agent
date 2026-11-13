import {
  isTerminal,
  type PageSource,
  sourceId,
  summarizeTask,
  type Task,
  type TaskSummary,
} from "@pba/contracts";
import { Pool, type PoolClient } from "pg";
import { migrateRuntime } from "./migrations.ts";

export function createDatabasePool(connectionString: string): Pool {
  return new Pool({ connectionString, max: 8, connectionTimeoutMillis: 5000 });
}
export class StoreError extends Error {
  readonly statusCode: number;
  constructor(message: string, statusCode = 409) {
    super(message);
    this.statusCode = statusCode;
  }
}
export function event(task: Task, message: string): void {
  task.events.push({ seq: task.events.length + 1, at: new Date().toISOString(), message });
  task.phase = message;
}
function markPaused(task: Task): void {
  task.status = "paused";
  task.pausedAt = new Date().toISOString();
  event(task, "Task paused · progress saved");
}
function closePause(task: Task): void {
  if (task.pausedAt) {
    if (task.startedAt)
      task.pausedMs = (task.pausedMs ?? 0) + Math.max(0, Date.now() - Date.parse(task.pausedAt));
    task.pausedAt = null;
  }
}
export class TaskStore {
  readonly pool: Pool;
  constructor(pool: Pool) {
    this.pool = pool;
  }
  async initialize(): Promise<void> {
    await migrateRuntime(this.pool);
    await this.transaction(async (client) => {
      await client.query("SELECT pg_advisory_xact_lock(724920)");
      await client.query(`
      CREATE TABLE IF NOT EXISTS tasks (id uuid PRIMARY KEY, data jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now());
      CREATE INDEX IF NOT EXISTS tasks_created ON tasks(created_at DESC);
      CREATE TABLE IF NOT EXISTS browser_leases (session text PRIMARY KEY, task_id uuid NOT NULL REFERENCES tasks(id), action_id text NOT NULL);
      CREATE TABLE IF NOT EXISTS browser_actions (id text PRIMARY KEY, task_id uuid NOT NULL REFERENCES tasks(id), status text NOT NULL, updated_at timestamptz NOT NULL DEFAULT now());
      `);
    });
  }
  async transaction<T>(action: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await action(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
  async locked(client: PoolClient, id: string): Promise<Task> {
    const result = await client.query<{ data: Task }>("SELECT data FROM tasks WHERE id=$1 FOR UPDATE", [id]);
    const task = result.rows[0]?.data;
    if (!task) throw new StoreError("Task not found", 404);
    return task;
  }
  async save(client: PoolClient, task: Task): Promise<Task> {
    task.version += 1;
    task.sourceCount = task.sources.length;
    await client.query("UPDATE tasks SET data=$2 WHERE id=$1", [task.id, JSON.stringify(task)]);
    return task;
  }
  async create(id: string, prompt: string, urls: string[]): Promise<Task> {
    return this.transaction(async (client) => {
      const now = new Date().toISOString();
      const task: Task = {
        id,
        prompt,
        urls,
        title: prompt.split("\n")[0]?.slice(0, 85) || "Website research",
        status: "queued",
        phase: "Queued for execution",
        version: 1,
        createdAt: now,
        startedAt: null,
        endedAt: null,
        error: null,
        sourceCount: 0,
        executionVersion: 2,
        pausedAt: null,
        pausedMs: 0,
        sources: [],
        events: [{ seq: 1, at: now, message: "Queued for execution" }],
      };
      await client.query("INSERT INTO tasks(id,data) VALUES($1,$2) ON CONFLICT DO NOTHING", [
        id,
        JSON.stringify(task),
      ]);
      const existing = await this.locked(client, id);
      if (existing.prompt !== prompt) throw new StoreError("This request ID belongs to a different task.");
      return existing;
    });
  }
  async get(id: string): Promise<Task | null> {
    const result = await this.pool.query<{ data: Task }>("SELECT data FROM tasks WHERE id=$1", [id]);
    return result.rows[0]?.data ?? null;
  }
  async list(): Promise<TaskSummary[]> {
    const result = await this.pool.query<{ data: Task }>(
      "SELECT data FROM tasks ORDER BY created_at DESC, id DESC",
    );
    return result.rows.map(({ data }) => summarizeTask(data));
  }
  async pendingIds(): Promise<string[]> {
    const result = await this.pool.query<{ id: string }>(
      "SELECT id FROM tasks WHERE data->>'status' IN ('queued','running','pausing','paused','stopping')",
    );
    return result.rows.map((row) => row.id);
  }
  async pause(id: string): Promise<Task> {
    return this.transaction(async (client) => {
      const task = await this.locked(client, id);
      if (isTerminal(task.status) || ["pausing", "paused", "stopping"].includes(task.status)) return task;
      if (task.executionVersion !== 2)
        throw new StoreError("This task started before pause was available. New tasks support pause.");
      const lease = await client.query<{ action_id: string }>(
        "SELECT action_id FROM browser_leases WHERE task_id=$1",
        [id],
      );
      if (lease.rows[0] && !lease.rows[0].action_id.startsWith("hold:")) {
        task.status = "pausing";
        event(task, "Pause requested · finishing the current page");
      } else markPaused(task);
      return this.save(client, task);
    });
  }
  async resume(id: string): Promise<Task> {
    return this.transaction(async (client) => {
      const task = await this.locked(client, id);
      if (task.status !== "paused") return task;
      closePause(task);
      task.status = task.startedAt ? "running" : "queued";
      event(task, "Task resumed · continuing from saved progress");
      return this.save(client, task);
    });
  }
  async stop(id: string): Promise<Task> {
    return this.transaction(async (client) => {
      const task = await this.locked(client, id);
      if (isTerminal(task.status) || task.status === "stopping") return task;
      closePause(task);
      task.status = "stopping";
      event(task, "Stop requested · closing the browser");
      return this.save(client, task);
    });
  }
  async finish(id: string, error?: string): Promise<Task> {
    return this.transaction(async (client) => {
      const task = await this.locked(client, id);
      if (isTerminal(task.status)) return task;
      if (task.status === "stopping" || error)
        await client.query("DELETE FROM browser_leases WHERE task_id=$1 AND action_id LIKE 'hold:%'", [id]);
      const lease = await client.query(
        "SELECT 1 FROM browser_leases WHERE task_id=$1 AND action_id NOT LIKE 'hold:%'",
        [id],
      );
      if (lease.rowCount) return task;
      if (task.status === "pausing") {
        markPaused(task);
        return this.save(client, task);
      }
      if (task.status === "paused" && !error) return task;
      if (task.status === "stopping") {
        task.status = "stopped";
        event(task, "Task stopped · browser released · progress saved");
      } else if (error) {
        task.status = "failed";
        task.error = error;
        event(task, error);
      } else if (task.sources.length === task.urls.length) {
        task.status = "completed";
        event(task, "All pages captured · report saved");
      } else return task;
      closePause(task);
      task.endedAt = new Date().toISOString();
      return this.save(client, task);
    });
  }
  async acquire(id: string, index: number): Promise<{ task: Task; cached: boolean }> {
    return this.transaction(async (client) => {
      await client.query("SELECT pg_advisory_xact_lock(hashtext(current_schema()),724922)");
      const task = await this.locked(client, id);
      if (task.status === "stopping" || isTerminal(task.status))
        throw new StoreError("Task is no longer accepting browser actions", 410);
      if (task.status === "paused" || task.status === "pausing") throw new StoreError("Task is paused", 423);
      if (task.sources.some((source) => source.id === sourceId(index))) return { task, cached: true };
      const url = task.urls[index];
      if (!url) throw new StoreError("Invalid source index", 400);
      const actionId = `${id}:${index}`;
      const occupied = await client.query("SELECT 1 FROM agent_sessions WHERE state<>'closed'");
      if (occupied.rowCount) throw new StoreError("Browser is busy; task remains queued", 409);
      const lease = await client.query(
        "INSERT INTO browser_leases(session,task_id,action_id) VALUES('personal',$1,$2) ON CONFLICT(session) DO UPDATE SET action_id=EXCLUDED.action_id WHERE browser_leases.task_id=EXCLUDED.task_id AND browser_leases.action_id='hold:' || EXCLUDED.task_id::text RETURNING session",
        [id, actionId],
      );
      if (!lease.rowCount) throw new StoreError("Browser is busy; task remains queued", 409);
      await client.query(
        "INSERT INTO browser_actions(id,task_id,status) VALUES($1,$2,'running') ON CONFLICT(id) DO UPDATE SET status='running',updated_at=now()",
        [actionId, id],
      );
      task.status = "running";
      task.startedAt ??= new Date().toISOString();
      event(task, `Reading ${new URL(url).hostname} · page ${index + 1} of ${task.urls.length}`);
      await this.save(client, task);
      return { task, cached: false };
    });
  }
  // Called only after the browser context has closed, so terminal states acknowledge actual release.
  async release(id: string, index: number, source: PageSource | null, error: string | null): Promise<void> {
    await this.transaction(async (client) => {
      const task = await this.locked(client, id);
      const actionId = `${id}:${index}`;
      const lease = await client.query("DELETE FROM browser_leases WHERE action_id=$1 RETURNING session", [
        actionId,
      ]);
      if (!lease.rowCount) return;
      const stopped = task.status === "stopping" || isTerminal(task.status);
      await client.query("UPDATE browser_actions SET status=$2,updated_at=now() WHERE id=$1", [
        actionId,
        stopped ? "aborted" : source ? "completed" : "failed",
      ]);
      if (!stopped && source && !task.sources.some((item) => item.id === source.id)) {
        task.sources.push(source);
        event(task, `Captured ${source.title} · ${source.text.length} characters`);
      } else if (!stopped && error) {
        task.status = "failed";
        task.error = error;
        task.endedAt = new Date().toISOString();
        event(task, error);
      }
      if (task.status === "stopping") {
        task.status = "stopped";
        task.endedAt = new Date().toISOString();
        event(task, "Task stopped · browser released · progress saved");
      } else if (
        (task.status === "running" || task.status === "pausing") &&
        task.sources.length === task.urls.length
      ) {
        task.status = "completed";
        task.endedAt = new Date().toISOString();
        event(task, "All pages captured · report saved");
      } else if (task.status === "pausing") {
        markPaused(task);
        await client.query("INSERT INTO browser_leases(session,task_id,action_id) VALUES('personal',$1,$2)", [
          id,
          `hold:${id}`,
        ]);
      }
      await this.save(client, task);
    });
  }
  async busyTaskId(): Promise<string | null> {
    const result = await this.pool.query<{ task_id: string }>(
      "SELECT task_id FROM browser_leases WHERE session='personal'",
    );
    return result.rows[0]?.task_id ?? null;
  }
  // Gateway holds an exclusive advisory lock before reconciling leases from a previous process.
  async recoverGateway(): Promise<void> {
    const leases = await this.pool.query<{ task_id: string }>("SELECT task_id FROM browser_leases");
    for (const { task_id: id } of leases.rows) {
      await this.transaction(async (client) => {
        const task = await this.locked(client, id);
        await client.query(
          "UPDATE browser_actions SET status='interrupted',updated_at=now() WHERE task_id=$1 AND status='running'",
          [id],
        );
        if (task.status === "pausing" || task.status === "paused") {
          await client.query("UPDATE browser_leases SET action_id=$2 WHERE task_id=$1", [id, `hold:${id}`]);
          if (task.status === "pausing") {
            markPaused(task);
            await this.save(client, task);
          }
        } else {
          await client.query(
            "DELETE FROM browser_leases WHERE task_id=$1 AND (action_id NOT LIKE 'hold:%' OR $2)",
            [id, task.status === "stopping" || isTerminal(task.status)],
          );
        }
      });
    }
    for (const id of await this.pendingIds()) await this.finish(id);
  }
}
