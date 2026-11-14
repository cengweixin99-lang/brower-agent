import { ActionError, type BrowserSessions, ObservationError } from "@pba/browser";
import {
  type ActionOutcome,
  type ActionRequest,
  matchesObservation,
  type ObservationSnapshot,
  parseActionRequest,
  type SessionLease,
} from "@pba/contracts/runtime";
import { StoreError } from "@pba/persistence";
import {
  ActionLedger,
  type ActionReceipt,
  actionFingerprint,
  type RuntimeStore,
} from "@pba/persistence/runtime";
import type { FastifyInstance } from "fastify";

export function registerActions(
  server: FastifyInstance,
  dependencies: {
    store: RuntimeStore;
    sessions: BrowserSessions;
    busy: Set<string>;
    active(input: unknown): Promise<SessionLease>;
    signal(sessionId: string): AbortSignal;
    capture(lease: SessionLease): Promise<ObservationSnapshot>;
    close(lease: SessionLease, reason: "session_closed" | "session_lost"): Promise<void>;
  },
): void {
  const { store, sessions, busy } = dependencies;
  const ledger = new ActionLedger(store.pool);
  const pending = new Map<string, { fingerprint: string; operation: Promise<ActionReceipt> }>();
  async function execute(request: ActionRequest): Promise<ActionReceipt> {
    const prior = await ledger.lookup(request);
    if (prior) return prior;
    const lease = await dependencies.active({
      protocolVersion: 1,
      workspaceId: request.workspaceId,
      runId: request.runId,
      executionEpoch: request.executionEpoch,
    });
    if (lease.sessionId !== request.sessionId) throw new StoreError("Session mismatch", 409);
    if (request.deadlineAt <= Date.now() || request.deadlineAt > Date.now() + 30_000)
      throw new StoreError("Action deadline must be within 30 seconds", 400);
    if (busy.has(lease.sessionId)) throw new StoreError("Session operation in progress", 409);
    const signal = dependencies.signal(lease.sessionId);
    busy.add(lease.sessionId);
    try {
      let timer: ReturnType<typeof setTimeout> | undefined;
      let admitted = false;
      let dispatched = false;
      let extractedText: string | null = null;
      let outcome: ActionOutcome;
      try {
        const view = await sessions.get(lease.sessionId);
        if (view.tabId !== request.tabId) throw new StoreError("Tab mismatch", 409);
        const replay = await ledger.admit(request, lease);
        if (replay) return replay;
        admitted = true;
        timer = setTimeout(
          () => {
            void dependencies.close(lease, "session_lost").catch(() => {});
          },
          Math.max(1, request.deadlineAt - Date.now()),
        );
        const task = await store.getTask(request.workspaceId, request.runId);
        if ("target" in request.action) {
          const latest = await store.latestObservation(request.workspaceId, request.runId);
          if (!latest || !matchesObservation(request, latest.observation))
            throw new ActionError("stale_observation");
        }
        if (!(await store.heartbeat(lease))) throw new ActionError("execution_revoked");
        extractedText = await sessions.execute(request, task.allowedOrigins, signal, () => {
          if (signal.aborted) throw new ActionError("execution_revoked");
          if (Date.now() >= request.deadlineAt) throw new ActionError("deadline_exceeded");
          dispatched = true;
        });
        const snapshot = await dependencies.capture(lease);
        if (signal.aborted || Date.now() >= request.deadlineAt) throw new ActionError("execution_revoked");
        outcome = { status: "succeeded", observationId: snapshot.observation.observationId };
      } catch (error) {
        if (!admitted) throw error;
        if (
          Date.now() >= request.deadlineAt ||
          (error instanceof ActionError && error.code === "deadline_exceeded")
        )
          await dependencies.close(lease, "session_lost").catch(() => {});
        const passive = ["wait", "extract"].includes(request.action.type);
        if (dispatched && !passive) {
          outcome = { status: "unknown", code: "outcome_unknown" };
          // Stop browser auto-waits and isolate uncertain effects before another action is admitted.
          await dependencies.close(lease, "session_lost").catch(() => {});
        } else {
          const code =
            Date.now() >= request.deadlineAt
              ? "deadline_exceeded"
              : signal.aborted
                ? "execution_revoked"
                : error instanceof ActionError
                  ? error.code
                  : error instanceof ObservationError
                    ? "stale_observation"
                    : "browser_error";
          outcome = {
            status: signal.aborted || code === "execution_revoked" ? "cancelled" : "failed",
            code,
            effect: "none",
          };
        }
        extractedText = null;
      } finally {
        if (timer) clearTimeout(timer);
      }
      try {
        return await ledger.finish(request, {
          result: {
            protocolVersion: 1,
            actionId: request.actionId,
            runId: request.runId,
            executionEpoch: request.executionEpoch,
            outcome,
          },
          extractedText,
        });
      } catch (error) {
        await dependencies.close(lease, "session_lost").catch(() => {});
        throw error;
      }
    } finally {
      busy.delete(lease.sessionId);
    }
  }
  server.post(
    "/runtime/sessions/action",
    { bodyLimit: 65_536 },
    async (httpRequest): Promise<ActionReceipt> => {
      const request = parseActionRequest(httpRequest.body);
      const key = JSON.stringify([request.workspaceId, request.runId, request.actionId]);
      const fingerprint = actionFingerprint(request);
      const current = pending.get(key);
      if (current) {
        if (current.fingerprint !== fingerprint)
          throw new StoreError("Action ID has different parameters", 409);
        return current.operation;
      }
      const operation = execute(request);
      pending.set(key, { fingerprint, operation });
      try {
        return await operation;
      } finally {
        pending.delete(key);
      }
    },
  );
}
