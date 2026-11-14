import type { ReactNode } from "react";
import type { TaskStatus } from "./task-model.ts";

export type IconName =
  | "arrow"
  | "article"
  | "browser"
  | "calendar"
  | "check"
  | "chevron"
  | "clip"
  | "clock"
  | "close"
  | "code"
  | "command"
  | "compare"
  | "down"
  | "download"
  | "expand"
  | "extract"
  | "file"
  | "form"
  | "globe"
  | "grid"
  | "help"
  | "history"
  | "left"
  | "lock"
  | "more"
  | "pause"
  | "plus"
  | "refresh"
  | "research"
  | "right"
  | "search"
  | "settings"
  | "shield"
  | "spark"
  | "square"
  | "terminal";

export function Icon({ name, className = "" }: { name: IconName; className?: string }) {
  return (
    <span className={`icon ${className}`} aria-hidden="true">
      <img src={`/icons/${name}.svg`} alt="" />
    </span>
  );
}

export function IconButton({
  name,
  label,
  onClick,
  disabled = false,
}: {
  name: IconName;
  label: string;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      className="icon-button"
      aria-label={label}
      title={label}
      onClick={onClick}
      disabled={disabled}
    >
      <Icon name={name} />
    </button>
  );
}

export const statusLabels: Record<TaskStatus, string> = {
  running: "Running",
  queued: "Queued",
  stopping: "Stopping",
  pausing: "Pausing",
  paused: "Paused",
  completed: "Completed",
  stopped: "Stopped",
  failed: "Failed",
};

export function StatusBadge({ status }: { status: TaskStatus }) {
  return (
    <span className={`status-badge status-${status} ${status === "pausing" ? "status-stopping" : ""}`}>
      <span className="status-dot" />
      {statusLabels[status]}
    </span>
  );
}

export function EmptyState({
  icon = "search",
  title,
  children,
}: {
  icon?: IconName;
  title: string;
  children: ReactNode;
}) {
  return (
    <div className="empty-state">
      <div className="empty-icon">
        <Icon name={icon} />
      </div>
      <h2>{title}</h2>
      {children}
    </div>
  );
}

export function downloadFile(name: string, contents: string, type = "text/plain") {
  const url = URL.createObjectURL(new Blob([contents], { type }));
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}
