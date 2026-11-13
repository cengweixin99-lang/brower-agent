import type { TaskStatus, TaskSummary } from "@pba/contracts";
import { useState } from "react";
import { dateLabel, duration } from "./task-model.ts";
import { EmptyState, Icon, IconButton, StatusBadge, statusLabels } from "./ui.tsx";

export function TaskHistory({
  tasks,
  onNew,
  onOpen,
  recent = false,
}: {
  tasks: TaskSummary[];
  onNew: () => void;
  onOpen: (id: string) => void;
  recent?: boolean;
}) {
  const [filter, setFilter] = useState<TaskStatus | "all">("all");
  const [search, setSearch] = useState("");
  const [days, setDays] = useState(recent ? "7" : "all");
  const [page, setPage] = useState(0);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const scoped = tasks.filter(
    (task) =>
      (days === "all" || Date.now() - Date.parse(task.createdAt) < Number(days) * 86400_000) &&
      `${task.title} ${task.id} ${task.prompt}`.toLowerCase().includes(search.toLowerCase()),
  );
  const filtered = scoped.filter((task) => filter === "all" || task.status === filter);
  const pageCount = Math.max(1, Math.ceil(filtered.length / 8));
  const current = Math.min(page, pageCount - 1);
  const selected = filtered.slice(current * 8, current * 8 + 8).find((task) => task.id === selectedId);
  return (
    <div className="history-page content-page">
      <div className="page-heading">
        <div>
          <h1>{recent ? "Recent Tasks" : "Task History"}</h1>
          <p>Every task, every step. Pick up where you left off.</p>
        </div>
        <button type="button" className="button primary" onClick={onNew}>
          <Icon name="plus" />
          New Task
        </button>
      </div>
      <section className="filter-tabs" aria-label="Filter task status">
        {(
          [
            "all",
            "queued",
            "running",
            "pausing",
            "paused",
            "stopping",
            "completed",
            "stopped",
            "failed",
          ] as const
        ).map((status) => (
          <button
            type="button"
            key={status}
            className={filter === status ? "selected" : ""}
            aria-pressed={filter === status}
            onClick={() => {
              setFilter(status);
              setPage(0);
            }}
          >
            <span>{status === "all" ? "All" : statusLabels[status]}</span>
            <span className="count">
              {scoped.filter((task) => status === "all" || task.status === status).length}
            </span>
          </button>
        ))}
      </section>
      <div className="history-toolbar">
        <label className="search-field">
          <Icon name="search" />
          <input
            aria-label="Search tasks"
            placeholder="Search tasks…"
            value={search}
            onChange={(event) => {
              setSearch(event.target.value);
              setPage(0);
            }}
          />
        </label>
        <label className="select-field">
          <Icon name="calendar" />
          <select
            aria-label="Filter by date"
            value={days}
            onChange={(event) => {
              setDays(event.target.value);
              setPage(0);
            }}
          >
            <option value="all">All time</option>
            <option value="30">Last 30 days</option>
            <option value="7">Last 7 days</option>
            <option value="1">Last 24 hours</option>
          </select>
        </label>
        <span className="task-count">{filtered.length} tasks</span>
      </div>
      <div className={`history-grid ${selected ? "" : "details-closed"}`}>
        <div className="history-table panel">
          <table>
            <thead>
              <tr>
                <th>Task</th>
                <th>Created</th>
                <th>Duration</th>
                <th>Status</th>
                <th>
                  <span className="sr-only">Open task</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {filtered.slice(current * 8, current * 8 + 8).map((task) => (
                <tr key={task.id} className={selectedId === task.id ? "selected" : ""}>
                  <td>
                    <button type="button" className="task-row-button" onClick={() => setSelectedId(task.id)}>
                      <span className="task-type">
                        <Icon name="research" />
                      </span>
                      <span>
                        <strong>{task.title}</strong>
                        <small>
                          {task.sourceCount} / {task.urls.length} pages captured
                        </small>
                      </span>
                    </button>
                  </td>
                  <td>{dateLabel(task.createdAt)}</td>
                  <td>{duration(task)}</td>
                  <td>
                    <StatusBadge status={task.status} />
                  </td>
                  <td>
                    <IconButton name="chevron" label={`Open ${task.title}`} onClick={() => onOpen(task.id)} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {!filtered.length && (
            <EmptyState title="No tasks found">
              <p>Try another search, or start a new task.</p>
            </EmptyState>
          )}
          <div className="table-footer">
            <span>
              Showing {filtered.length ? current * 8 + 1 : 0}–{Math.min((current + 1) * 8, filtered.length)}{" "}
              of {filtered.length} tasks
            </span>
            <div>
              <IconButton
                name="left"
                label="Previous page"
                disabled={current === 0}
                onClick={() => setPage(current - 1)}
              />
              <span>
                {current + 1} / {pageCount}
              </span>
              <IconButton
                name="right"
                label="Next page"
                disabled={current + 1 >= pageCount}
                onClick={() => setPage(current + 1)}
              />
            </div>
          </div>
        </div>
        {selected && (
          <aside className="execution-details panel">
            <div className="detail-header">
              <strong>Execution record</strong>
              <IconButton name="close" label="Close execution details" onClick={() => setSelectedId(null)} />
            </div>
            <div className="detail-body">
              <span className="detail-type">
                <Icon name="research" />
              </span>
              <h2>{selected.title}</h2>
              <div className="detail-status">
                <StatusBadge status={selected.status} />
              </div>
              <dl>
                <div>
                  <dt>Created</dt>
                  <dd>{dateLabel(selected.createdAt)}</dd>
                </div>
                <div>
                  <dt>Duration</dt>
                  <dd>{duration(selected)}</dd>
                </div>
                <div>
                  <dt>Browser</dt>
                  <dd>Personal session</dd>
                </div>
                <div>
                  <dt>Execution</dt>
                  <dd>Read-only capture</dd>
                </div>
              </dl>
              <div className="detail-output">
                <strong>Output</strong>
                <p>{selected.error ?? `${selected.sourceCount} of ${selected.urls.length} pages saved`}</p>
                {selected.sourceCount > 0 && (
                  <a className="download-card" href={`/api/tasks/${selected.id}/report`} download>
                    <Icon name="file" />
                    <span>
                      <strong>Source report</strong>
                      <small>TXT · Actual page excerpts</small>
                    </span>
                    <Icon name="download" />
                  </a>
                )}
              </div>
              <button type="button" className="button full-width" onClick={() => onOpen(selected.id)}>
                View execution
                <Icon name="arrow" />
              </button>
            </div>
          </aside>
        )}
      </div>
      <p className="page-footnote">
        Tasks are saved on the server. Refreshing this page never starts a new execution.
      </p>
    </div>
  );
}
