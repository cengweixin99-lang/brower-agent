export interface HealthResponse {
  service: "api" | "browser-worker";
  status: "ok";
}
export interface EnvironmentReport {
  status: "ok";
  nodeVersion: string;
}
export type TaskStatus =
  | "queued"
  | "running"
  | "pausing"
  | "paused"
  | "stopping"
  | "completed"
  | "stopped"
  | "failed";
export interface TaskEvent {
  seq: number;
  at: string;
  message: string;
}
export interface PageSource {
  id: string;
  url: string;
  title: string;
  text: string;
  headings: string[];
  capturedAt: string;
}
export interface TaskSummary {
  id: string;
  title: string;
  prompt: string;
  urls: string[];
  status: TaskStatus;
  phase: string;
  version: number;
  createdAt: string;
  startedAt: string | null;
  endedAt: string | null;
  error: string | null;
  sourceCount: number;
  executionVersion?: 2;
  pausedAt?: string | null;
  pausedMs?: number;
}
export interface Task extends TaskSummary {
  events: TaskEvent[];
  sources: PageSource[];
}
export interface CreateTaskInput {
  id: string;
  prompt: string;
}
export interface BrowserReadInput {
  taskId: string;
  index: number;
}
export interface RuntimeStatus {
  browser: boolean;
  workflow: boolean;
  busyTaskId: string | null;
}
export function isTerminal(status: TaskStatus): boolean {
  return status === "completed" || status === "stopped" || status === "failed";
}
export function sourceId(index: number): string {
  return `source-${index + 1}`;
}
export function summarizeTask(task: Task): TaskSummary {
  const { sources: _sources, events: _events, ...summary } = task;
  return summary;
}
export function taskReport(task: Task): string {
  return [
    `# ${task.title}`,
    `Status: ${task.status}`,
    `Created: ${task.createdAt}`,
    "Read-only page capture. These are source excerpts, not AI-generated conclusions.",
    task.error ? `Error: ${task.error}` : "",
    `Captured ${task.sources.length} of ${task.urls.length} pages.`,
    ...task.sources.map(
      (source) =>
        `## ${source.title}\nSource: ${source.url}\nCaptured: ${source.capturedAt}\n\n${source.text}`,
    ),
  ]
    .filter(Boolean)
    .join("\n\n");
}
