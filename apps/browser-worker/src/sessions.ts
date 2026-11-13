import { randomUUID } from "node:crypto";
import { type Browser, BrowserSessions, ObservationError } from "@pba/browser";
import {
  type ObservationSnapshot,
  parseArtifactRequest,
  parseSessionRequest,
  parseStopRunRequest,
  parseTargetValidationRequest,
  type SessionLease,
  type SessionView,
} from "@pba/contracts/runtime";
import { StoreError } from "@pba/persistence";
import type { RuntimeStore } from "@pba/persistence/runtime";
import type { FastifyInstance } from "fastify";
import { registerActions } from "./actions.ts";
import { ScreenshotStore } from "./artifacts.ts";
import { readResource } from "./network.ts";

export async function registerRuntimeSessions(
  server: FastifyInstance,
  browser: Browser,
  store: RuntimeStore,
  privateOrigins: string[],
): Promise<{ close(): Promise<void> }> {
  const ownerId = randomUUID();
  const sessions = new BrowserSessions(browser);
  const artifacts = new ScreenshotStore();
  const observing = new Set<string>();
  const leases = new Map<string, { lease: SessionLease; abort: AbortController }>();
  const closing = new Map<string, Promise<void>>();
  const opening = new Map<string, Promise<SessionView>>();
  let shuttingDown = false;
  // Caller already owns the schema's exclusive gateway lock. Old sessions are quarantined, not reclaimed.
  await store.quarantineAbandoned(ownerId);

  function close(
    lease: SessionLease,
    reason: "session_closed" | "session_lost" | "open_failed",
  ): Promise<void> {
    const existing = closing.get(lease.sessionId);
    if (existing) return existing;
    const operation = (async () => {
      leases.get(lease.sessionId)?.abort.abort();
      await sessions.close(lease.sessionId);
      // Only commit release after the real context has closed. DB failure retains the durable lease.
      await store.closed(lease, reason);
      leases.delete(lease.sessionId);
    })();
    closing.set(lease.sessionId, operation);
    void operation.finally(() => closing.delete(lease.sessionId)).catch(() => {});
    return operation;
  }

  server.post("/runtime/sessions/open", async (request): Promise<SessionView> => {
    const input = parseSessionRequest(request.body);
    if (shuttingDown || !browser.isConnected()) throw new StoreError("Gateway is restarting", 503);
    const task = await store.getTask(input.workspaceId, input.runId);
    if (!task.startUrl) throw new StoreError("An initial URL is required for P03 sessions", 400);
    const lease = await store.reserve(input, ownerId);
    const existing = opening.get(lease.sessionId);
    if (existing) return existing;
    const abort = new AbortController();
    const prior = leases.get(lease.sessionId);
    if (!prior) leases.set(lease.sessionId, { lease, abort });
    const signal = prior?.abort.signal ?? abort.signal;
    const operation = (async (): Promise<SessionView> => {
      try {
        const view = await sessions.open(lease.sessionId, task.startUrl ?? "", async (context) => {
          await context.route("**/*", async (route) => {
            const resource = route.request();
            try {
              const url = new URL(resource.url());
              if (
                signal.aborted ||
                !task.allowedOrigins.includes(url.origin) ||
                resource.method() !== "GET" ||
                !["document", "stylesheet", "image", "font"].includes(resource.resourceType())
              ) {
                await route.abort();
                return;
              }
              await route.fulfill(await readResource(url.href, privateOrigins, signal));
            } catch {
              await route.abort().catch(() => {});
            }
          });
        });
        const active = await store.activate(lease);
        return { session: active, ...view };
      } catch {
        await close(lease, "open_failed");
        throw new StoreError("Session could not open or was revoked", 409);
      }
    })();
    opening.set(lease.sessionId, operation);
    try {
      return await operation;
    } finally {
      opening.delete(lease.sessionId);
    }
  });

  server.post("/runtime/sessions/status", async (request): Promise<SessionView> => {
    const input = parseSessionRequest(request.body);
    const lease = await store.getSession(input.workspaceId, input.runId);
    if (
      !lease ||
      lease.ownerId !== ownerId ||
      lease.executionEpoch !== input.executionEpoch ||
      lease.state !== "active" ||
      !(await store.heartbeat(lease))
    )
      throw new StoreError("Session unavailable or revoked", 409);
    try {
      return { session: lease, ...(await sessions.get(lease.sessionId)) };
    } catch {
      await close(lease, "session_lost");
      throw new StoreError("Browser session lost", 409);
    }
  });

  server.post("/runtime/sessions/stop", async (request) => {
    const input = parseStopRunRequest(request.body);
    const accepted = await store.requestStop(
      input.workspaceId,
      input.runId,
      input.commandId,
      input.expectedVersion,
    );
    const lease = await store.getSession(input.workspaceId, input.runId);
    if (lease?.ownerId === ownerId && lease.state !== "closed") await close(lease, "session_closed");
    // Return the original command receipt, not a falsely synchronous success before closure.
    return { accepted, current: await store.get(input.workspaceId, input.runId) };
  });

  async function active(input: unknown): Promise<SessionLease> {
    const request = parseSessionRequest(input);
    const lease = await store.getSession(request.workspaceId, request.runId);
    if (
      !lease ||
      lease.ownerId !== ownerId ||
      lease.executionEpoch !== request.executionEpoch ||
      lease.state !== "active" ||
      !(await store.heartbeat(lease))
    )
      throw new StoreError("Session unavailable or revoked", 409);
    return lease;
  }
  async function capture(lease: SessionLease): Promise<ObservationSnapshot> {
    let observationId: string | undefined;
    let writtenArtifact: string | undefined;
    try {
      const capture = await sessions.observe(lease);
      observationId = capture.snapshot.observation.observationId;
      const artifactId = capture.snapshot.observation.screenshotArtifactId;
      if (!artifactId) throw new Error("Missing screenshot reference");
      const artifact = await artifacts.write(artifactId, capture.screenshot);
      writtenArtifact = artifactId;
      await store.saveObservation(lease, capture.snapshot, artifact);
      return capture.snapshot;
    } catch (error) {
      if (writtenArtifact) {
        // A lost COMMIT acknowledgement is ambiguous. Keep files if DB visibility is uncertain.
        const artifactId = writtenArtifact;
        await store
          .getArtifact(lease.workspaceId, lease.runId, artifactId)
          .then(async (saved) => {
            if (!saved) await artifacts.remove(artifactId);
          })
          .catch(() => {});
      }
      if (observationId) await sessions.invalidateObservation(lease.sessionId, observationId).catch(() => {});
      throw error instanceof ObservationError || error instanceof StoreError
        ? error
        : new StoreError("Observation could not be saved", 409);
    }
  }
  server.post("/runtime/sessions/observe", async (request): Promise<ObservationSnapshot> => {
    const lease = await active(request.body);
    if (observing.has(lease.sessionId)) throw new ObservationError("observation_busy");
    observing.add(lease.sessionId);
    try {
      return await capture(lease);
    } finally {
      observing.delete(lease.sessionId);
    }
  });
  registerActions(server, {
    store,
    sessions,
    busy: observing,
    active,
    capture,
    close,
    signal(sessionId) {
      const entry = leases.get(sessionId);
      if (!entry) throw new StoreError("Session unavailable", 409);
      return entry.abort.signal;
    },
  });
  server.post("/runtime/sessions/validate-target", async (request) => {
    const { target, ...input } = parseTargetValidationRequest(request.body);
    const lease = await active(input);
    const latest = await store.latestObservation(lease.workspaceId, lease.runId);
    if (latest?.observation.observationId !== target.observationId)
      throw new ObservationError("stale_observation");
    await sessions.validateTarget(lease.sessionId, target);
    // Recheck revocation after browser I/O. P05 must check again within action admission.
    if (!(await store.heartbeat(lease))) throw new StoreError("Session unavailable or revoked", 409);
    return { valid: true, observationId: target.observationId };
  });
  server.post("/runtime/artifacts/read", async (request, reply) => {
    const input = parseArtifactRequest(request.body);
    const metadata = await store.getArtifact(input.workspaceId, input.runId, input.artifactId);
    if (!metadata) throw new StoreError("Artifact not found", 404);
    try {
      return reply
        .type("image/png")
        .header("cache-control", "private, no-store")
        .send(await artifacts.read(metadata));
    } catch {
      throw new StoreError("Artifact unavailable", 404);
    }
  });

  let checking: Promise<void> | null = null;
  const timer = setInterval(() => {
    if (checking || shuttingDown) return;
    checking = (async () => {
      for (const { lease } of leases.values()) {
        try {
          if (!browser.isConnected() || !(await store.heartbeat(lease))) await close(lease, "session_lost");
        } catch {
          // Fail closed on DB loss; do not mark a lease released without durable acknowledgement.
          await close(lease, "session_lost").catch(() => {});
        }
      }
    })().finally(() => {
      checking = null;
    });
  }, 250);
  timer.unref();
  return {
    async close() {
      shuttingDown = true;
      clearInterval(timer);
      await checking;
      await Promise.all([...leases.values()].map(({ lease }) => close(lease, "session_closed")));
    },
  };
}
