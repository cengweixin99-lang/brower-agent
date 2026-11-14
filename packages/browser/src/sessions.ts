import { randomUUID } from "node:crypto";
import type { ActionRequest, ElementTarget, ObservationSnapshot, SessionLease } from "@pba/contracts/runtime";
import type { Browser, BrowserContext, Page } from "playwright";
import { ActionError, executeAction } from "./actions.ts";
import { PageObservations } from "./observations.ts";

interface LiveSession {
  context: BrowserContext;
  page: Page;
  tabId: string;
  observations: PageObservations;
}
export interface BrowserSessionSummary {
  tabId: string;
  url: string;
  title: string;
}

// In-memory context ownership only. Durable ownership/admission belongs to the gateway/store.
export class BrowserSessions {
  private readonly browser: Browser;
  private readonly contexts = new Map<string, BrowserContext>();
  private readonly sessions = new Map<string, Promise<LiveSession>>();
  private readonly closing = new Set<string>();
  constructor(browser: Browser) {
    this.browser = browser;
  }

  async open(
    sessionId: string,
    url: string,
    configure: (context: BrowserContext) => Promise<void>,
  ): Promise<BrowserSessionSummary> {
    if (this.closing.has(sessionId)) throw new Error("Session closing");
    let live = this.sessions.get(sessionId);
    if (!live) {
      live = this.create(sessionId, url, configure);
      this.sessions.set(sessionId, live);
    }
    return this.summary(await live);
  }
  private async create(
    sessionId: string,
    url: string,
    configure: (context: BrowserContext) => Promise<void>,
  ): Promise<LiveSession> {
    // P05 permits native interactions; page scripts and network writes remain disabled.
    const context = await this.browser.newContext({
      viewport: { width: 1280, height: 800 },
      javaScriptEnabled: false,
      serviceWorkers: "block",
      acceptDownloads: false,
    });
    this.contexts.set(sessionId, context);
    try {
      if (this.closing.has(sessionId)) throw new Error("Session closing");
      await configure(context);
      const page = await context.newPage();
      const response = await page.goto(url, { waitUntil: "load", timeout: 30_000 });
      if (!response?.ok()) throw new Error("Initial navigation failed");
      if (this.closing.has(sessionId)) throw new Error("Session closing");
      const tabId = randomUUID();
      return { context, page, tabId, observations: new PageObservations(page, tabId) };
    } catch (error) {
      await context.close();
      throw error;
    }
  }
  async get(sessionId: string): Promise<BrowserSessionSummary> {
    const live = this.sessions.get(sessionId);
    if (!live || this.closing.has(sessionId)) throw new Error("Session unavailable");
    return this.summary(await live);
  }
  private async summary(live: LiveSession): Promise<BrowserSessionSummary> {
    if (live.page.isClosed()) throw new Error("Session unavailable");
    return { tabId: live.tabId, url: live.page.url(), title: (await live.page.title()).slice(0, 2000) };
  }
  private async live(sessionId: string): Promise<LiveSession> {
    const value = this.sessions.get(sessionId);
    if (!value || this.closing.has(sessionId)) throw new Error("Session unavailable");
    return value;
  }
  async observe(lease: SessionLease): Promise<{ snapshot: ObservationSnapshot; screenshot: Buffer }> {
    return (await this.live(lease.sessionId)).observations.capture({
      workspaceId: lease.workspaceId,
      runId: lease.runId,
      sessionId: lease.sessionId,
      executionEpoch: lease.executionEpoch,
    });
  }
  async validateTarget(sessionId: string, target: ElementTarget): Promise<void> {
    await (await this.live(sessionId)).observations.validate(target);
  }
  async execute(
    request: ActionRequest,
    origins: string[],
    signal: AbortSignal,
    dispatched: () => void,
  ): Promise<string | null> {
    const live = await this.live(request.sessionId);
    if (live.tabId !== request.tabId) throw new ActionError("session_lost");
    return executeAction(
      live.page,
      live.observations,
      request.action,
      origins,
      request.deadlineAt,
      signal,
      dispatched,
    );
  }
  async invalidateObservation(sessionId: string, observationId: string): Promise<void> {
    await (await this.live(sessionId)).observations.invalidate(observationId);
  }
  async close(sessionId: string): Promise<void> {
    this.closing.add(sessionId);
    try {
      await this.contexts.get(sessionId)?.close();
      const live = await this.sessions.get(sessionId)?.catch(() => undefined);
      await live?.observations.dispose();
      // Creation may have resolved after the first lookup; close also covers that window.
      await this.contexts.get(sessionId)?.close();
      this.contexts.delete(sessionId);
      this.sessions.delete(sessionId);
    } finally {
      this.closing.delete(sessionId);
    }
  }
}
