import { randomUUID } from "node:crypto";
import {
  type ElementTarget,
  type ObservationSnapshot,
  type ObservedFrame,
  parseObservationSnapshot,
  type SessionLease,
} from "@pba/contracts/runtime";
import type { ElementHandle, Frame, JSHandle, Page } from "playwright";

interface FrameState {
  document: Document;
  revision: number;
  observer: MutationObserver;
  nodes: Element[];
  data: { text: string; elements: { role: string; name: string }[]; truncated: boolean };
}
interface FrameReference {
  frame: Frame;
  info: ObservedFrame;
  handle: JSHandle<FrameState>;
}
interface CurrentObservation {
  snapshot: ObservationSnapshot;
  generation: number;
  refs: FrameReference[];
}
export class ObservationError extends Error {
  readonly statusCode = 409;
  constructor(
    code:
      | "stale_observation"
      | "observation_changed"
      | "observation_busy"
      | "observation_unavailable"
      | "target_missing",
  ) {
    super(code);
  }
}

// Serialized by Playwright into the page. Keep the collector self-contained and bounded.
function collectFrame(limits: { text: number; elements: number }): FrameState {
  const nodes: Element[] = [];
  const data: FrameState["data"] = { text: "", elements: [], truncated: false };
  const state: FrameState = {
    document,
    revision: 0,
    observer: new MutationObserver(() => {
      state.revision++;
    }),
    nodes,
    data,
  };
  state.observer.observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
  const roots: Node[] = [document.body ?? document.documentElement];
  let inspected = 0;
  function visible(element: Element): boolean {
    if (element.closest("[hidden],[inert],[aria-hidden='true'],script,style,template")) return false;
    const style = getComputedStyle(element);
    return (
      style.display !== "none" &&
      style.visibility !== "hidden" &&
      style.visibility !== "collapse" &&
      element.getClientRects().length > 0
    );
  }
  function role(element: Element): string {
    const explicit = element.getAttribute("role");
    if (explicit) return explicit.slice(0, 100);
    if (element instanceof HTMLInputElement) {
      if (element.type === "checkbox") return "checkbox";
      if (element.type === "radio") return "radio";
      if (["button", "submit", "reset"].includes(element.type)) return "button";
      return "textbox";
    }
    return (
      (
        { A: "link", BUTTON: "button", SELECT: "combobox", TEXTAREA: "textbox", SUMMARY: "button" } as Record<
          string,
          string
        >
      )[element.tagName] ?? "button"
    );
  }
  function name(element: Element): string {
    const root = element.getRootNode();
    const labelled = (element.getAttribute("aria-labelledby") ?? "")
      .split(/\s+/)
      .slice(0, 20)
      .map((id) =>
        root instanceof Document || root instanceof ShadowRoot
          ? (root.getElementById(id)?.textContent ?? "")
          : "",
      )
      .join(" ")
      .trim();
    const labels =
      element instanceof HTMLInputElement ||
      element instanceof HTMLSelectElement ||
      element instanceof HTMLTextAreaElement
        ? Array.from(element.labels ?? [])
            .map((label) => label.textContent ?? "")
            .join(" ")
        : "";
    // Input values are intentionally excluded, especially passwords and prefilled sensitive fields.
    const text =
      element instanceof HTMLElement &&
      !(element instanceof HTMLInputElement) &&
      !(element instanceof HTMLTextAreaElement)
        ? // biome-ignore lint/performance/useDomNodeTextContent: Only visible control text should become a label.
          element.innerText
        : "";
    return (
      labelled ||
      element.getAttribute("aria-label") ||
      labels ||
      element.getAttribute("alt") ||
      text ||
      element.getAttribute("title") ||
      element.getAttribute("placeholder") ||
      ""
    )
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 1000);
  }
  const interactive =
    "a[href],button,input:not([type='hidden']):not([type='password']),textarea,select,summary,[contenteditable='true'],[role='button'],[role='link'],[role='checkbox'],[role='radio'],[role='textbox'],[role='combobox'],[tabindex]:not([tabindex='-1'])";
  for (let rootIndex = 0; rootIndex < roots.length; rootIndex++) {
    const root = roots[rootIndex];
    if (!root) continue;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT);
    let node = walker.nextNode();
    while (node) {
      if (++inspected > 20_000) {
        data.truncated = true;
        return state;
      }
      if (node instanceof Element && visible(node)) {
        if (node.shadowRoot) {
          roots.push(node.shadowRoot);
          state.observer.observe(node.shadowRoot, {
            subtree: true,
            childList: true,
            attributes: true,
            characterData: true,
          });
        }
        if (
          node.matches(interactive) &&
          !node.matches(":disabled,[aria-disabled='true'],input[type='password']")
        ) {
          if (nodes.length < limits.elements) {
            nodes.push(node);
            data.elements.push({ role: role(node), name: name(node) });
          } else data.truncated = true;
        }
      } else if (
        node.nodeType === Node.TEXT_NODE &&
        node.parentElement &&
        visible(node.parentElement) &&
        !node.parentElement.closest("textarea,select")
      ) {
        const text = (node.textContent ?? "").replace(/\s+/g, " ").trim();
        if (text) {
          const remaining = limits.text - data.text.length;
          if (text.length + 1 > remaining) data.truncated = true;
          if (remaining > 0) data.text += `${text}\n`.slice(0, remaining);
        }
      }
      node = walker.nextNode();
    }
  }
  return state;
}

export class PageObservations {
  private readonly page: Page;
  private readonly tabId: string;
  private readonly ids = new WeakMap<Frame, { frameId: string; documentId: string }>();
  private generation = 0;
  private sequence = 0;
  private busy = false;
  private disposed = false;
  private current: CurrentObservation | null = null;
  private readonly navigated = (frame: Frame): void => {
    const prior = this.ids.get(frame);
    this.ids.set(frame, { frameId: prior?.frameId ?? randomUUID(), documentId: randomUUID() });
    this.generation++;
  };
  private readonly changed = (): void => {
    this.generation++;
  };
  constructor(page: Page, tabId: string) {
    this.page = page;
    this.tabId = tabId;
    page.on("framenavigated", this.navigated);
    page.on("frameattached", this.changed);
    page.on("framedetached", this.changed);
  }
  private frameInfo(frame: Frame): ObservedFrame {
    let value = this.ids.get(frame);
    if (!value) {
      value = { frameId: randomUUID(), documentId: randomUUID() };
      this.ids.set(frame, value);
    }
    const parent = frame.parentFrame();
    return { ...value, parentFrameId: parent ? this.frameInfo(parent).frameId : null, url: frame.url() };
  }
  private async release(refs: FrameReference[]): Promise<void> {
    await Promise.all(
      refs.map(async ({ handle }) => {
        await handle.evaluate((state) => state.observer.disconnect()).catch(() => {});
        await handle.dispose().catch(() => {});
      }),
    );
  }
  async invalidate(observationId?: string): Promise<void> {
    const previous = this.current;
    if (!previous || (observationId && previous.snapshot.observation.observationId !== observationId)) return;
    this.current = null;
    await this.release(previous.refs);
  }
  private async unchanged(refs: FrameReference[], generation: number): Promise<boolean> {
    if (this.disposed || this.page.isClosed() || this.generation !== generation) return false;
    try {
      for (const { handle, frame } of refs) {
        if (
          frame.isDetached() ||
          !(await handle.evaluate((state) => {
            if (state.observer.takeRecords().length) state.revision++;
            return state.document === document && state.revision === 0;
          }))
        )
          return false;
      }
      return this.generation === generation;
    } catch {
      return false;
    }
  }
  async capture(
    identity: Pick<SessionLease, "workspaceId" | "runId" | "sessionId" | "executionEpoch">,
  ): Promise<{ snapshot: ObservationSnapshot; screenshot: Buffer }> {
    if (this.busy) throw new ObservationError("observation_busy");
    if (this.disposed || this.page.isClosed()) throw new ObservationError("observation_unavailable");
    this.busy = true;
    const refs: FrameReference[] = [];
    try {
      await this.invalidate();
      const generation = this.generation;
      const frameQueue = [this.page.mainFrame()];
      const elements: ObservationSnapshot["observation"]["elements"] = [];
      let text = "";
      let truncated = false;
      for (let index = 0; index < frameQueue.length; index++) {
        const frame = frameQueue[index];
        if (!frame) continue;
        if (refs.length >= 20) {
          truncated = true;
          break;
        }
        if (frame.parentFrame()) {
          const element = await frame.frameElement();
          const visible = await element.isVisible();
          await element.dispose();
          if (!visible) continue;
        }
        if (!/^(https?:|about:blank$|about:srcdoc$)/.test(frame.url())) {
          truncated = true;
          continue;
        }
        const info = this.frameInfo(frame);
        const handle = await frame.evaluateHandle(collectFrame, {
          text: 30_000 - text.length,
          elements: 1000 - elements.length,
        });
        refs.push({ frame, handle, info });
        const data = await handle.evaluate((state) => state.data);
        text += data.text;
        truncated ||= data.truncated;
        for (const [elementIndex, element] of data.elements.entries())
          elements.push({ ...element, frameId: info.frameId, elementId: `element-${elementIndex}` });
        frameQueue.push(...frame.childFrames());
      }
      const main = refs[0];
      if (!main) throw new ObservationError("observation_unavailable");
      const title = (await this.page.title()).slice(0, 2000);
      const screenshot = await this.page.screenshot({
        type: "png",
        timeout: 5000,
        fullPage: false,
        mask: this.page.frames().map((frame) => frame.locator("input[type=password]")),
        maskColor: "#000000",
      });
      if (!(await this.unchanged(refs, generation))) throw new ObservationError("observation_changed");
      const snapshot = parseObservationSnapshot({
        observation: {
          protocolVersion: 1,
          ...identity,
          tabId: this.tabId,
          observationId: randomUUID(),
          documentId: main.info.documentId,
          capturedAt: Date.now(),
          url: main.info.url,
          title,
          text,
          screenshotArtifactId: randomUUID(),
          elements,
        },
        sequence: ++this.sequence,
        frames: refs.map(({ info }) => info),
        truncated,
      });
      this.current = { snapshot, generation, refs };
      return { snapshot, screenshot };
    } catch (error) {
      await this.release(refs);
      if (error instanceof ObservationError) throw error;
      throw new ObservationError("observation_unavailable");
    } finally {
      this.busy = false;
    }
  }
  async validate(target: ElementTarget): Promise<void> {
    const current = this.current;
    if (
      !current ||
      current.snapshot.observation.observationId !== target.observationId ||
      current.snapshot.observation.documentId !== target.documentId ||
      !(await this.unchanged(current.refs, current.generation))
    )
      throw new ObservationError("stale_observation");
    const reference = current.refs.find(({ info }) => info.frameId === target.frameId);
    const element = current.snapshot.observation.elements.find(
      (element) => element.frameId === target.frameId && element.elementId === target.elementId,
    );
    if (!reference || !element) throw new ObservationError("target_missing");
    const index = Number(target.elementId.slice("element-".length));
    const present = await reference.handle
      .evaluate((state, index) => {
        const node = state.nodes[index];
        if (!node) return false;
        const style = getComputedStyle(node);
        return Boolean(
          node.isConnected &&
            node.ownerDocument === document &&
            node.getClientRects().length &&
            style.display !== "none" &&
            style.visibility !== "hidden" &&
            style.visibility !== "collapse" &&
            !node.closest("[hidden],[inert],[aria-hidden='true']") &&
            !node.matches(":disabled,[aria-disabled='true']"),
        );
      }, index)
      .catch(() => false);
    if (!present) throw new ObservationError("stale_observation");
  }
  async resolve(target: ElementTarget): Promise<ElementHandle<Element>> {
    await this.validate(target);
    const reference = this.current?.refs.find(({ info }) => info.frameId === target.frameId);
    if (!reference) throw new ObservationError("stale_observation");
    const handle = await reference.handle.evaluateHandle(
      (state, index) => state.nodes[index],
      Number(target.elementId.slice("element-".length)),
    );
    const element = handle.asElement();
    if (!element) {
      await handle.dispose();
      throw new ObservationError("target_missing");
    }
    return element;
  }
  async dispose(): Promise<void> {
    this.disposed = true;
    this.page.off("framenavigated", this.navigated);
    this.page.off("frameattached", this.changed);
    this.page.off("framedetached", this.changed);
    await this.invalidate();
  }
}
