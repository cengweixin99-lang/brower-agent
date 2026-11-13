import { type RuntimeStatus, summarizeTask, type Task, type TaskSummary } from "@pba/contracts";
import { useCallback, useEffect, useState } from "react";
import { mergeSnapshots } from "./task-model.ts";

export class ApiError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}
export async function api<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(`/api${path}`, {
    ...(body === undefined
      ? {}
      : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(8000),
    cache: "no-store",
  });
  if (!response.ok) {
    const data = (await response.json().catch(() => ({}))) as { error?: string };
    throw new ApiError(data.error ?? "Could not reach the task service. Retry shortly.", response.status);
  }
  return response.json() as Promise<T>;
}
export function useTasks(activeId: string | null) {
  const [tasks, setTasks] = useState<TaskSummary[]>([]);
  const [details, setDetails] = useState<Task[]>([]);
  const [runtime, setRuntime] = useState<RuntimeStatus | null>(null);
  const [connectionError, setConnectionError] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [missing, setMissing] = useState<string | null>(null);
  const accept = useCallback((task: Task) => {
    setDetails((current) => mergeSnapshots(current, [task]));
    setTasks((current) => mergeSnapshots(current, [summarizeTask(task)]));
  }, []);
  useEffect(() => {
    let disposed = false;
    let timer = 0;
    const poll = async () => {
      try {
        const [list, detail, status] = await Promise.all([
          api<{ tasks: TaskSummary[] }>("/tasks"),
          activeId
            ? api<Task>(`/tasks/${activeId}`).catch((error: unknown) => {
                if (error instanceof ApiError && error.status === 404) return null;
                throw error;
              })
            : Promise.resolve(null),
          api<RuntimeStatus>("/runtime").catch(() => null),
        ]);
        if (disposed) return;
        setTasks((current) => mergeSnapshots(current, list.tasks));
        if (detail) accept(detail);
        setMissing(activeId && !detail ? activeId : null);
        setRuntime(status);
        setConnectionError("");
        setLoaded(true);
      } catch {
        if (!disposed)
          setConnectionError(
            "Connection interrupted. Showing the last saved state; reconnecting automatically. Your task continues on the server.",
          );
      } finally {
        if (!disposed)
          timer = window.setTimeout(() => {
            void poll();
          }, 1000);
      }
    };
    void poll();
    return () => {
      disposed = true;
      window.clearTimeout(timer);
    };
  }, [activeId, accept]);
  return {
    tasks,
    task: details.find((task) => task.id === activeId),
    runtime,
    connectionError,
    loaded,
    missing,
    accept,
  };
}
