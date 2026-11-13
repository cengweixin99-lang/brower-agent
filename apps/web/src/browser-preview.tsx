import type { Task } from "@pba/contracts";
import { useState } from "react";
import { dateLabel } from "./task-model.ts";
import { EmptyState, Icon, IconButton } from "./ui.tsx";

export function BrowserPreview({ task }: { task: Task }) {
  const [selected, setSelected] = useState<string | null>(null);
  const [view, setView] = useState<"screenshot" | "text">("screenshot");
  const [expanded, setExpanded] = useState(false);
  const source = task.sources.find((item) => item.id === selected) ?? task.sources.at(-1);
  return (
    <section className={`browser-panel panel ${expanded ? "browser-expanded" : ""}`}>
      <div className="view-toolbar">
        <div className="view-tabs">
          <button
            type="button"
            className={view === "screenshot" ? "selected" : ""}
            onClick={() => setView("screenshot")}
          >
            <Icon name="browser" />
            Browser capture
          </button>
          <button type="button" className={view === "text" ? "selected" : ""} onClick={() => setView("text")}>
            <Icon name="article" />
            Page text
          </button>
          <button type="button" disabled title="Live browser control is not available yet">
            Live control
          </button>
        </div>
        <IconButton
          name={expanded ? "close" : "expand"}
          label={expanded ? "Close expanded capture" : "Expand capture"}
          onClick={() => setExpanded(!expanded)}
        />
      </div>
      <div className="browser-tabs">
        {task.sources.map((item) => (
          <button
            type="button"
            key={item.id}
            className={source?.id === item.id ? "selected" : ""}
            onClick={() => setSelected(item.id)}
            title={item.title}
          >
            <Icon name="globe" />
            <span className="capture-tab-label">{item.title}</span>
          </button>
        ))}
      </div>
      <div className="address-toolbar">
        <Icon name="lock" />
        <div className="address-bar">
          <span>{source?.url ?? "Waiting for a captured page…"}</span>
        </div>
      </div>
      <div className="website-preview">
        {source ? (
          view === "screenshot" ? (
            <CaptureImage
              key={source.id}
              path={`/api/tasks/${task.id}/sources/${source.id}/screenshot`}
              title={source.title}
            />
          ) : (
            <pre className="captured-text">{source.text}</pre>
          )
        ) : (
          <EmptyState
            icon="browser"
            title={
              task.status === "stopped"
                ? "Stopped before the first capture"
                : task.status === "failed"
                  ? "No page captured"
                  : "Waiting for the browser"
            }
          >
            <p>
              Captured pages appear here after they load. A capture is a saved snapshot, not a live stream.
            </p>
          </EmptyState>
        )}
      </div>
      <div className="browser-status">
        <span>
          <Icon name="shield" />
          Read-only capture
        </span>
        <span>{source ? `Saved ${dateLabel(source.capturedAt)}` : task.phase}</span>
      </div>
    </section>
  );
}
function CaptureImage({ path, title }: { path: string; title: string }) {
  const [failed, setFailed] = useState(false);
  return failed ? (
    <EmptyState icon="file" title="Screenshot unavailable">
      <p>The saved page text is still available.</p>
      <button type="button" className="button" onClick={() => setFailed(false)}>
        Retry screenshot
      </button>
    </EmptyState>
  ) : (
    <img
      className="captured-image"
      src={path}
      alt={`Captured page: ${title}`}
      onError={() => setFailed(true)}
    />
  );
}
