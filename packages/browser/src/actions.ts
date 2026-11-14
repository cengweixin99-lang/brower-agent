import { setTimeout as delay } from "node:timers/promises";
import type { ActionErrorCode, BrowserAction } from "@pba/contracts/runtime";
import type { ElementHandle, Page } from "playwright";
import type { PageObservations } from "./observations.ts";

export class ActionError extends Error {
  readonly code: ActionErrorCode;
  constructor(code: ActionErrorCode) {
    super(code);
    this.code = code;
  }
}
export async function executeAction(
  page: Page,
  observations: PageObservations,
  action: BrowserAction,
  allowedOrigins: string[],
  deadlineAt: number,
  signal: AbortSignal,
  dispatched: () => void,
): Promise<string | null> {
  let element: ElementHandle<Element> | undefined;
  const timeout = (): number => {
    signal.throwIfAborted();
    const remaining = deadlineAt - Date.now();
    if (remaining <= 0) throw new ActionError("deadline_exceeded");
    return Math.min(remaining, 10_000);
  };
  try {
    timeout();
    if (action.type === "navigate" && !allowedOrigins.includes(new URL(action.url).origin))
      throw new ActionError("policy_denied");
    if ("target" in action) {
      element = await observations.resolve(action.target);
      const permitted = await element.evaluate(
        (node, input) => {
          const link = node instanceof HTMLAnchorElement ? node : null;
          const textInput =
            node instanceof HTMLTextAreaElement ||
            (node instanceof HTMLInputElement &&
              ["text", "search", "email", "tel", "url", "number"].includes(node.type));
          if (input.action.type === "fill") return textInput && !node.matches(":read-only");
          if (input.action.type === "select") return node instanceof HTMLSelectElement;
          if (input.action.type === "extract")
            return !(node instanceof HTMLInputElement && ["password", "file", "hidden"].includes(node.type));
          if (input.action.type === "pressKey" && input.action.key !== "Enter") return true;
          // JS is disabled. Only native controls whose default activation cannot submit are allowed.
          if (link) {
            const url = new URL(link.href);
            const target = link.target || document.querySelector("base[target]")?.getAttribute("target");
            return (
              ["http:", "https:"].includes(url.protocol) &&
              !url.username &&
              !url.password &&
              input.allowedOrigins.includes(url.origin) &&
              !link.hasAttribute("download") &&
              (!target || target === "_self")
            );
          }
          if (input.action.type === "pressKey") return node.tagName === "SUMMARY";
          return (
            node.tagName === "SUMMARY" ||
            (node instanceof HTMLButtonElement && node.type === "button") ||
            (node instanceof HTMLInputElement && ["checkbox", "radio", "button"].includes(node.type))
          );
        },
        { action, allowedOrigins },
      );
      if (!permitted) throw new ActionError("policy_denied");
      await observations.validate(action.target);
    }
    const remaining = timeout();
    dispatched(); // Synchronous local revocation check immediately before calling the browser.
    switch (action.type) {
      case "navigate": {
        const response = await page.goto(action.url, { waitUntil: "load", timeout: remaining });
        if (!response?.ok()) throw new Error("Navigation failed");
        break;
      }
      case "click":
        await element?.click({ timeout: remaining });
        break;
      case "fill":
        await element?.fill(action.text, { timeout: remaining });
        break;
      case "select": {
        const values = await element?.selectOption({ value: action.value }, { timeout: remaining });
        if (!values?.includes(action.value)) throw new Error("Selection not applied");
        break;
      }
      case "pressKey":
        await element?.press(action.key, { timeout: remaining });
        break;
      case "scroll":
        await page.evaluate(
          ({ direction, pixels }) => window.scrollBy(0, direction === "down" ? pixels : -pixels),
          action,
        );
        break;
      case "wait":
        await delay(Math.min(action.milliseconds, remaining), undefined, { signal });
        if (action.milliseconds > remaining) throw new ActionError("deadline_exceeded");
        break;
      case "extract":
        return (
          (await element?.evaluate((node) => {
            if (node instanceof HTMLInputElement && ["checkbox", "radio"].includes(node.type))
              return String(node.checked);
            if (
              node instanceof HTMLInputElement ||
              node instanceof HTMLTextAreaElement ||
              node instanceof HTMLSelectElement
            )
              return node.value.slice(0, 10_000);
            // biome-ignore lint/performance/useDomNodeTextContent: Extraction follows visible text.
            return (node instanceof HTMLElement ? node.innerText : (node.textContent ?? "")).slice(0, 10_000);
          })) ?? null
        );
    }
    timeout();
    return null;
  } finally {
    await element?.dispose().catch(() => {});
  }
}
