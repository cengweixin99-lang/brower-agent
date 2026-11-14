import { isTerminal, type Task } from "@pba/contracts";
import { useEffect, useRef, useState } from "react";
import { BrowserPreview } from "./browser-preview.tsx";
import { ApiError, api, useTasks } from "./task-api.ts";
import { TaskHistory } from "./task-history.tsx";
import { dateLabel, duration, samplePrompt } from "./task-model.ts";
import { EmptyState, Icon, IconButton, type IconName, StatusBadge } from "./ui.tsx";

type View = "new" | "all" | "history" | "recent" | "sessions" | "scheduled" | "workspace";
const navigation: { label: string; icon: IconName; view: View }[] = [
  { label: "New Task", icon: "plus", view: "new" },
  { label: "All Tasks", icon: "grid", view: "all" },
  { label: "Recent Tasks", icon: "clock", view: "recent" },
  { label: "Scheduled Tasks", icon: "calendar", view: "scheduled" },
  { label: "Browser Sessions", icon: "browser", view: "sessions" },
  { label: "History", icon: "history", view: "history" },
];
function route(): { view: View; id: string | null } {
  const hash = window.location.hash.slice(1);
  const id = /^task\/([0-9a-f-]{36})$/i.exec(hash)?.[1];
  return id
    ? { view: "workspace", id }
    : { view: navigation.find((item) => item.view === hash)?.view ?? "new", id: null };
}
function pendingRequest(): { id: string; prompt: string } | null {
  try {
    const parsed: unknown = JSON.parse(sessionStorage.getItem("pending-task") ?? "null");
    return parsed &&
      typeof parsed === "object" &&
      "id" in parsed &&
      typeof parsed.id === "string" &&
      "prompt" in parsed &&
      typeof parsed.prompt === "string"
      ? { id: parsed.id, prompt: parsed.prompt }
      : null;
  } catch {
    return null;
  }
}
function rememberPending(value: { id: string; prompt: string } | null) {
  try {
    if (value) sessionStorage.setItem("pending-task", JSON.stringify(value));
    else sessionStorage.removeItem("pending-task");
  } catch {
    /* Request ID remains in memory if storage is unavailable. */
  }
}

export function App() {
  const [location, setLocation] = useState(route);
  const { tasks, task, runtime, loaded, connectionError, missing, accept } = useTasks(location.id);
  const pending = useRef(pendingRequest());
  const [prompt, setPrompt] = useState(pending.current?.prompt ?? "");
  const [submitting, setSubmitting] = useState(false);
  const submittingRef = useRef(false);
  const [controlling, setControlling] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [stopDialog, setStopDialog] = useState(false);
  const [error, setError] = useState("");
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [information, setInformation] = useState<"settings" | "help" | null>(null);
  const composer = useRef<HTMLTextAreaElement>(null);
  const [showActivity, setShowActivity] = useState(false);
  const view = location.view;
  const latest = task ?? tasks[0];
  const activeSession = tasks.find((item) => item.id === runtime?.busyTaskId);
  function navigate(next: View, id?: string) {
    window.location.hash = next === "workspace" && id ? `task/${id}` : next;
    setSidebarOpen(false);
    setError("");
    setStopDialog(false);
    setShowActivity(false);
  }
  useEffect(() => {
    const changed = () => {
      setLocation(route());
      setStopDialog(false);
      setError("");
      setShowActivity(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "n") {
        event.preventDefault();
        window.location.hash = "new";
      }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        window.location.hash = "history";
      }
    };
    window.addEventListener("hashchange", changed);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("hashchange", changed);
      window.removeEventListener("keydown", onKey);
    };
  }, []);
  async function runTask() {
    if (submittingRef.current || !prompt.trim()) return;
    submittingRef.current = true;
    setSubmitting(true);
    setError("");
    const input =
      pending.current?.prompt === prompt.trim()
        ? pending.current
        : { id: crypto.randomUUID(), prompt: prompt.trim() };
    pending.current = input;
    rememberPending(input);
    try {
      const created = await api<Task>("/tasks", input);
      accept(created);
      pending.current = null;
      rememberPending(null);
      setPrompt("");
      navigate("workspace", created.id);
    } catch (caught) {
      setError(
        caught instanceof ApiError
          ? caught.message
          : "Could not confirm submission. Retry uses the same request ID and will not duplicate your task.",
      );
      if (caught instanceof ApiError && caught.status < 500) {
        pending.current = null;
        rememberPending(null);
      }
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
    }
  }
  async function pauseOrResume() {
    if (!task || controlling) return;
    const action = task.status === "paused" ? "resume" : "pause";
    setControlling(true);
    setError("");
    try {
      accept(await api<Task>(`/tasks/${task.id}/${action}`, {}));
    } catch {
      setError(
        `Could not confirm ${action}. Check the current status and retry; saved progress is preserved.`,
      );
    } finally {
      setControlling(false);
    }
  }
  async function stopTask() {
    if (!task || stopping) return;
    setStopping(true);
    setError("");
    try {
      accept(await api<Task>(`/tasks/${task.id}/stop`, {}));
      setStopDialog(false);
    } catch {
      setError(
        "Could not confirm the stop request. Check the current status and retry; repeating Stop is safe.",
      );
    } finally {
      setStopping(false);
    }
  }
  return (
    <div className="app-shell">
      {sidebarOpen && (
        <button
          type="button"
          className="sidebar-scrim"
          aria-label="Close navigation"
          onClick={() => setSidebarOpen(false)}
        />
      )}
      <aside className={`sidebar ${sidebarOpen ? "mobile-open" : ""}`}>
        <button type="button" className="brand" onClick={() => navigate("new")}>
          <span className="brand-mark small">
            <Icon name="command" />
          </span>
          <strong>Browse Agent</strong>
        </button>
        <div className="workspace-switcher">
          <button type="button" disabled>
            Personal workspace
            <Icon name="down" />
          </button>
        </div>
        <nav className="navigation" aria-label="Main navigation">
          {navigation.map((item) => (
            <button
              type="button"
              key={item.label}
              className={view === item.view ? "selected" : ""}
              aria-current={view === item.view ? "page" : undefined}
              onClick={() => navigate(item.view)}
            >
              <Icon name={item.icon} />
              <span>{item.label}</span>
              {item.view === "new" && <kbd>⌘ N</kbd>}
            </button>
          ))}
        </nav>
        {latest && (
          <div className="pinned-section">
            <div className="sidebar-caption">LATEST TASK</div>
            <button type="button" className="pinned-task" onClick={() => navigate("workspace", latest.id)}>
              <Icon name="browser" />
              <span>
                <strong>{latest.title}</strong>
                <small>
                  {latest.sourceCount} / {latest.urls.length} pages captured
                </small>
              </span>
            </button>
          </div>
        )}
        <div className="sidebar-bottom">
          <button type="button" className="connection-card" onClick={() => navigate("sessions")}>
            <span>
              <span className={!connectionError && runtime?.browser ? "green-dot" : "gray-dot"} />
              Browser {connectionError ? "status unknown" : runtime?.browser ? "connected" : "unavailable"}
            </span>
            <small>Chrome · Personal session</small>
          </button>
          <button type="button" className="sidebar-link" onClick={() => setInformation("settings")}>
            <Icon name="settings" />
            Settings
          </button>
          <button type="button" className="sidebar-link" onClick={() => setInformation("help")}>
            <Icon name="help" />
            Help & documentation
          </button>
          <div className="account">
            <span className="account-avatar">
              <Icon name="command" />
            </span>
            <span>
              <strong>Local workspace</strong>
              <small>Personal account</small>
            </span>
          </div>
        </div>
      </aside>
      <div className="app-main">
        <header className="page-header">
          <button
            type="button"
            className="mobile-menu icon-button"
            aria-label="Open navigation"
            onClick={() => setSidebarOpen(true)}
          >
            <Icon name="grid" />
          </button>
          <div className="breadcrumbs">
            <button type="button" onClick={() => navigate(view === "workspace" ? "history" : "new")}>
              {view === "workspace" ? "All Tasks" : "Workspace"}
            </button>
            <Icon name="chevron" />
            <span>
              {view === "workspace"
                ? (task?.title ?? "Task")
                : navigation.find((item) => item.view === view)?.label}
            </span>
          </div>
          <div className="header-end">
            <span className="demo-label">
              <span />
              Read-only browsing
            </span>
            <span>Personal workspace</span>
          </div>
        </header>
        <main>
          {connectionError && (
            <div role="status" className="service-notice warning">
              {connectionError}
            </div>
          )}
          {error && (
            <div role="alert" className="service-notice error">
              {error}
              <button type="button" onClick={() => setError("")} aria-label="Dismiss error">
                ×
              </button>
            </div>
          )}
          {view === "new" && (
            <div className="new-task-page">
              <div className="new-task-intro">
                <div className="brand-mark large">
                  <Icon name="command" />
                </div>
                <h1>What should I do for you?</h1>
                <p>Browse real pages, collect their contents, and keep your research in one place.</p>
              </div>
              <form
                className="task-composer"
                onSubmit={(event) => {
                  event.preventDefault();
                  void runTask();
                }}
              >
                <label htmlFor="task-prompt" className="sr-only">
                  Describe a task
                </label>
                <textarea
                  id="task-prompt"
                  ref={composer}
                  maxLength={6000}
                  value={prompt}
                  disabled={submitting}
                  placeholder="Describe a task and include 1–5 page URLs…"
                  onChange={(event) => setPrompt(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                      event.preventDefault();
                      void runTask();
                    }
                  }}
                />
                <div className="composer-controls">
                  <IconButton
                    name="clip"
                    label="Attachments are not available yet"
                    disabled
                    onClick={() => {}}
                  />
                  <label className="composer-session">
                    <Icon name="browser" />
                    <select aria-label="Browser session" disabled>
                      <option>Personal session</option>
                    </select>
                  </label>
                  <span
                    className="model-selector"
                    title="Captures the URLs you provide. No paid model is called."
                  >
                    Read-only capture
                  </span>
                  <button
                    type="submit"
                    className="button primary run-task"
                    disabled={!prompt.trim() || submitting}
                  >
                    {submitting ? "Submitting…" : "Run Task"}
                    <Icon name="arrow" />
                  </button>
                </div>
              </form>
              <div className="composer-hint">
                <span>Include page URLs. Source excerpts and screenshots are saved automatically.</span>
                <span>⌘ ↵ to run</span>
              </div>
              {runtime && (!runtime.browser || !runtime.workflow) && (
                <div className="service-notice warning">
                  Execution services are reconnecting. New tasks will stay queued until they are available.
                </div>
              )}
              <section className="templates-section">
                <h2>START WITH A TEMPLATE</h2>
                <div className="template-grid">
                  {(
                    [
                      {
                        title: "Research competitors",
                        subtitle: "Capture product pages",
                        icon: "research",
                        prompt: samplePrompt,
                      },
                      {
                        title: "Compare products",
                        subtitle: "Collect source material",
                        icon: "compare",
                        prompt:
                          "Collect these product pages for comparison:\nhttps://linear.app/pricing\nhttps://asana.com/pricing",
                      },
                      {
                        title: "Extract website data",
                        subtitle: "Save page text",
                        icon: "extract",
                        prompt: "Capture the text and headings from https://example.com",
                      },
                      {
                        title: "Fill out web forms",
                        subtitle: "Not available yet",
                        icon: "form",
                        prompt: "",
                      },
                      {
                        title: "Summarize articles",
                        subtitle: "AI summary coming later",
                        icon: "article",
                        prompt: "",
                      },
                    ] satisfies { title: string; subtitle: string; icon: IconName; prompt: string }[]
                  ).map((template) => (
                    <button
                      type="button"
                      key={template.title}
                      className="template-card"
                      disabled={!template.prompt || submitting}
                      onClick={() => {
                        setPrompt(template.prompt);
                        composer.current?.focus();
                      }}
                    >
                      <div>
                        <Icon name={template.icon} />
                        <Icon name="arrow" />
                      </div>
                      <strong>{template.title}</strong>
                      <small>{template.subtitle}</small>
                    </button>
                  ))}
                </div>
              </section>
              <section className="recent-section">
                <div className="section-heading">
                  <h2>Recent tasks</h2>
                  <button type="button" className="text-button" onClick={() => navigate("history")}>
                    View all tasks
                    <Icon name="arrow" />
                  </button>
                </div>
                <div className="recent-list">
                  {tasks.slice(0, 3).map((record) => (
                    <button
                      type="button"
                      className="recent-row"
                      key={record.id}
                      onClick={() => navigate("workspace", record.id)}
                    >
                      <Icon name="research" />
                      <span className="recent-title">
                        <strong>{record.title}</strong>
                        <small>
                          {record.sourceCount} / {record.urls.length} pages captured
                        </small>
                      </span>
                      <StatusBadge status={record.status} />
                      <span className="recent-date">{dateLabel(record.createdAt)}</span>
                      <Icon name="chevron" />
                    </button>
                  ))}
                  {!tasks.length && (
                    <p className="empty-recent">
                      {loaded ? "No tasks yet. Your first run will appear here." : "Loading saved tasks…"}
                    </p>
                  )}
                </div>
              </section>
            </div>
          )}
          {view === "workspace" && !task && (
            <EmptyState icon="file" title={missing ? "Task not found" : "Restoring your task…"}>
              <p>
                {missing
                  ? "This task is not in the current workspace."
                  : "Reading the saved state from the server."}
              </p>
              <button type="button" className="button" onClick={() => navigate("history")}>
                View task history
              </button>
            </EmptyState>
          )}
          {view === "workspace" && task && (
            <div className="workspace-page content-page">
              <div className="task-heading">
                <div>
                  <h1>{task.title}</h1>
                  <p title={task.prompt}>{task.prompt}</p>
                </div>
                <div className="task-actions">
                  <StatusBadge status={task.status} />
                  {!isTerminal(task.status) && (
                    <>
                      <button
                        type="button"
                        className="button pause-button"
                        disabled={
                          controlling ||
                          stopping ||
                          task.status === "pausing" ||
                          task.status === "stopping" ||
                          task.executionVersion !== 2
                        }
                        title={
                          task.executionVersion !== 2
                            ? "This task started before pause was available"
                            : "Pause after the current page is saved"
                        }
                        onClick={() => {
                          void pauseOrResume();
                        }}
                      >
                        <Icon name={task.status === "paused" ? "right" : "pause"} />
                        {controlling
                          ? "Requesting…"
                          : task.status === "paused"
                            ? "Resume"
                            : task.status === "pausing"
                              ? "Pausing…"
                              : "Pause"}
                      </button>
                      <button
                        type="button"
                        className="button stop-button"
                        disabled={task.status === "stopping" || stopping}
                        onClick={() => setStopDialog(true)}
                      >
                        <Icon name="square" />
                        {task.status === "stopping" ? "Stopping…" : "Stop"}
                      </button>
                    </>
                  )}
                  {isTerminal(task.status) && (
                    <button
                      type="button"
                      className="button"
                      onClick={() => {
                        setPrompt(task.prompt);
                        navigate("new");
                      }}
                    >
                      <Icon name="plus" />
                      New task
                    </button>
                  )}
                </div>
              </div>
              {task.status === "pausing" && (
                <div className="service-notice warning" role="status">
                  Finishing the current page, then pausing. No further pages will start.
                </div>
              )}
              {task.status === "paused" && (
                <div className="service-notice" role="status">
                  Task paused. Progress is saved. Resume continues from the next unfinished page. Stop
                  releases any reserved session.
                </div>
              )}
              {task.status === "stopping" && (
                <div className="service-notice warning" role="status">
                  Stopping the browser. Captured pages will be preserved. It is safe to leave or refresh.
                </div>
              )}
              {task.status === "stopped" && (
                <div className="service-notice" role="status">
                  Task stopped. Browser released. {task.sourceCount} of {task.urls.length} pages saved; no
                  further pages will run.
                </div>
              )}
              {task.status === "failed" && (
                <div className="service-notice error" role="status">
                  {task.error} Captured pages are preserved.
                </div>
              )}
              {task.status === "completed" && !showActivity ? (
                <div className="result-layout">
                  <section className="panel result-summary">
                    <div className="result-icon success">
                      <Icon name="check" />
                    </div>
                    <h2>Your source report is ready.</h2>
                    <p>All requested pages were captured and saved to this workspace.</p>
                    <div className="result-metadata">
                      <span>{task.sourceCount} pages captured</span>
                      <span>Source text, headings and screenshots</span>
                      <span>Saved on the server · available after refresh</span>
                    </div>
                    <a className="button primary full-width" href={`/api/tasks/${task.id}/report`} download>
                      <Icon name="download" />
                      Download results
                    </a>
                    <button type="button" className="button full-width" onClick={() => setShowActivity(true)}>
                      View execution
                      <Icon name="arrow" />
                    </button>
                    <button type="button" className="button full-width" onClick={() => navigate("history")}>
                      View task history
                    </button>
                    <small className="muted">
                      AI conclusions and Notion publishing are not connected yet.
                    </small>
                  </section>
                  <section className="panel result-document">
                    <SourceReport task={task} />
                  </section>
                </div>
              ) : (
                <>
                  <div className="execution-grid">
                    <section className="activity-panel panel">
                      <div className="activity-heading">
                        <strong>Agent Activity</strong>
                        <span>{duration(task)}</span>
                      </div>
                      <div className="activity-progress">
                        <div>
                          <span>
                            {task.sourceCount} of {task.urls.length} pages
                          </span>
                          <span>{task.phase}</span>
                        </div>
                        <div className="progress-track">
                          <div style={{ width: `${(task.sourceCount / task.urls.length) * 100}%` }} />
                        </div>
                      </div>
                      <div className="timeline">
                        <div className="timeline-date">STARTED {dateLabel(task.createdAt)}</div>
                        {task.events.map((entry, index) => (
                          <div
                            className={`timeline-step ${index === task.events.length - 1 && !isTerminal(task.status) ? "current" : "done"}`}
                            key={entry.seq}
                          >
                            <span className="timeline-icon">
                              <Icon
                                name={
                                  index === task.events.length - 1 && task.status === "stopped"
                                    ? "square"
                                    : "check"
                                }
                              />
                            </span>
                            <div className="timeline-body">
                              <div>
                                <strong>{entry.message}</strong>
                                <time>{new Date(entry.at).toLocaleTimeString()}</time>
                              </div>
                            </div>
                          </div>
                        ))}
                      </div>
                      <div className="activity-footer">
                        <Icon name="shield" />
                        <span>
                          {isTerminal(task.status)
                            ? "Execution ended · progress saved"
                            : "Read-only browsing · no external writes"}
                        </span>
                      </div>
                    </section>
                    <BrowserPreview key={task.id} task={task} />
                  </div>
                  <div className="follow-up-composer">
                    <Icon name="plus" />
                    <input
                      aria-label="Add instructions for the agent"
                      disabled
                      placeholder={
                        isTerminal(task.status)
                          ? "This task has ended. Start a new task to continue."
                          : "Follow-up instructions are not available yet."
                      }
                    />
                    <button type="button" className="send-button" disabled aria-label="Send instruction">
                      <Icon name="arrow" />
                    </button>
                  </div>
                  {task.sourceCount > 0 && (
                    <section className="panel result-document partial-report">
                      <div className="section-heading">
                        <h2>{task.status === "completed" ? "Source report" : "Saved progress"}</h2>
                        <a className="button" href={`/api/tasks/${task.id}/report`} download>
                          <Icon name="download" />
                          Download results
                        </a>
                      </div>
                      <SourceReport task={task} />
                    </section>
                  )}
                </>
              )}
            </div>
          )}
          {(view === "history" || view === "all" || view === "recent") &&
            (loaded ? (
              <TaskHistory
                key={view}
                tasks={tasks}
                recent={view === "recent"}
                onNew={() => navigate("new")}
                onOpen={(id) => navigate("workspace", id)}
              />
            ) : (
              <EmptyState title="Loading task history…">
                <p>Connecting to your saved tasks.</p>
              </EmptyState>
            ))}
          {view === "scheduled" && (
            <div className="content-page">
              <h1>Scheduled Tasks</h1>
              <EmptyState icon="calendar" title="Scheduling is not available yet">
                <p>You can run a task now and return to its progress at any time.</p>
                <button type="button" className="button primary" onClick={() => navigate("new")}>
                  New Task
                </button>
              </EmptyState>
            </div>
          )}
          {view === "sessions" && (
            <div className="sessions-page content-page">
              <div className="page-heading">
                <div>
                  <h1>Browser Sessions</h1>
                  <p>One isolated browser context per task. Ownership is released when execution ends.</p>
                </div>
                <button
                  type="button"
                  className="button"
                  disabled
                  title="Additional sessions are not available yet"
                >
                  <Icon name="plus" />
                  New Session
                </button>
              </div>
              <p className="session-section-label">1 execution slot · Read-only browsing</p>
              <section className="session-card panel">
                <div className="session-card-heading">
                  <div>
                    <h2>Personal session</h2>
                    <p>
                      {connectionError
                        ? "Connection unknown"
                        : runtime?.browser
                          ? "Connected"
                          : "Unavailable"}{" "}
                      · {activeSession ? "In use" : runtime?.busyTaskId ? "In use" : "Available"}
                    </p>
                  </div>
                  <span
                    className={`connection-badge ${runtime?.browser && !connectionError ? "connected" : ""}`}
                  >
                    <span className="status-dot" />
                    {runtime?.busyTaskId ? "Busy" : "Idle"}
                  </span>
                </div>
                {activeSession && (
                  <div className="session-tabs">
                    <button type="button" onClick={() => navigate("workspace", activeSession.id)}>
                      <Icon name="browser" />
                      <span>
                        <strong>{activeSession.title}</strong>
                        <small>{activeSession.phase}</small>
                      </span>
                      <Icon name="arrow" />
                    </button>
                  </div>
                )}
                <div className="session-card-footer">
                  <span>
                    <Icon name="shield" />
                    Fresh context per task. Sign-in profiles are not connected yet.
                  </span>
                  <button
                    type="button"
                    className="button"
                    disabled
                    title="Stop the owning task to release this session"
                  >
                    Managed by task
                  </button>
                </div>
              </section>
            </div>
          )}
        </main>
      </div>
      {stopDialog && task && !isTerminal(task.status) && (
        <Modal
          title="Stop this task?"
          onClose={() => {
            if (!stopping) setStopDialog(false);
          }}
        >
          <p>
            The browser will stop loading pages. {task.sourceCount} captured pages and the activity log will
            remain available. Stopped tasks cannot resume.
          </p>
          <div className="dialog-actions">
            <button type="button" className="button" disabled={stopping} onClick={() => setStopDialog(false)}>
              Keep running
            </button>
            <button
              type="button"
              className="button primary"
              disabled={stopping}
              onClick={() => {
                void stopTask();
              }}
            >
              {stopping ? "Requesting stop…" : "Stop task"}
            </button>
          </div>
        </Modal>
      )}
      {information && (
        <Modal
          title={information === "settings" ? "Workspace settings" : "Meet your browser agent"}
          onClose={() => setInformation(null)}
        >
          <p>
            Include 1–5 HTTP(S) page URLs in your task. The browser captures their visible text, headings and
            screenshots without JavaScript or sign-in.
          </p>
          <p className="settings-note">
            Tasks and results are saved on this computer's server. Refresh or reopen a task link to restore
            progress. Pause finishes the current page and saves progress; Resume continues without repeating
            saved pages. Stop prevents further captures and keeps completed work.
          </p>
          <p className="settings-note">
            Paid AI models, attachments, scheduled tasks and publishing are not enabled in this release.
          </p>
          <button type="button" className="button primary full-width" onClick={() => setInformation(null)}>
            Got it
          </button>
        </Modal>
      )}
    </div>
  );
}
function SourceReport({ task }: { task: Task }) {
  return (
    <div className="report">
      <div className="report-kicker">
        <Icon name="file" />
        SOURCE REPORT<span>{task.status === "completed" ? "Complete" : "Partial"}</span>
      </div>
      <h2>{task.title}</h2>
      <p className="muted">
        Actual page excerpts · {task.sourceCount} of {task.urls.length} pages · No AI-generated conclusions
      </p>
      {task.sources.map((source) => (
        <article className="source-excerpt" key={source.id}>
          <h3>{source.title}</h3>
          <a href={source.url} target="_blank" rel="noreferrer">
            {source.url}
          </a>
          <small>Captured {dateLabel(source.capturedAt)}</small>
          {source.headings.length > 0 && (
            <p className="source-headings">{source.headings.slice(0, 6).join(" · ")}</p>
          )}
          <p>
            {source.text.slice(0, 1000)}
            {source.text.length > 1000 ? "…" : ""}
          </p>
        </article>
      ))}
      <p className="report-footnote">
        Downloads contain up to 30,000 characters per page. Saved captures may differ from pages that require
        JavaScript or sign-in.
      </p>
    </div>
  );
}
function Modal({
  title,
  children,
  onClose,
}: {
  title: string;
  children: React.ReactNode;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    dialog.current?.showModal();
  }, []);
  return (
    <dialog className="modal" ref={dialog} onCancel={onClose}>
      <div className="modal-header">
        <h2>{title}</h2>
        <IconButton name="close" label="Close dialog" onClick={onClose} />
      </div>
      <div className="modal-body">{children}</div>
    </dialog>
  );
}
