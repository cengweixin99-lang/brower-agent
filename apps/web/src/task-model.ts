import type { TaskSummary } from "@pba/contracts";

export type { TaskStatus } from "@pba/contracts";

export const samplePrompt =
  "Research these product pages and save their source text:\nhttps://linear.app/pricing\nhttps://asana.com/pricing\nhttps://www.notion.com/pricing";
// A late poll must never roll back a stop acknowledgement or a newer terminal state.
export function mergeSnapshots<T extends TaskSummary>(current: T[], incoming: T[]): T[] {
  const records = new Map(current.map((task) => [task.id, task]));
  for (const task of incoming) {
    const previous = records.get(task.id);
    if (!previous || task.version > previous.version) records.set(task.id, task);
  }
  return [...records.values()].sort(
    (a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id),
  );
}
export function duration(task: TaskSummary): string {
  const seconds = Math.max(
    0,
    Math.floor(
      ((task.endedAt ? Date.parse(task.endedAt) : task.pausedAt ? Date.parse(task.pausedAt) : Date.now()) -
        Date.parse(task.startedAt ?? task.createdAt) -
        (task.pausedMs ?? 0)) /
        1000,
    ),
  );
  return `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
}
export function dateLabel(value: string): string {
  return new Date(value).toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}
