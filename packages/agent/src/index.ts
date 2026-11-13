import type { BrowserReadInput } from "@pba/contracts";

export function planUrls(prompt: string): string[] {
  const matches = prompt.match(/https?:\/\/[^\s<>"`]+/g) ?? [];
  const urls = [
    ...new Set(
      matches.map((raw) => {
        const url = new URL(raw.replace(/[.,;!?)\]。，；！）]+$/u, ""));
        if (url.username || url.password) throw new Error("URLs must not contain credentials.");
        url.hash = "";
        return url.href;
      }),
    ),
  ];
  if (urls.length === 0 || urls.length > 5)
    throw new Error(
      "Include 1–5 HTTP(S) page URLs in your task. This version captures the pages you specify.",
    );
  return urls;
}
// All browser I/O crosses the authenticated gateway; this package never imports Playwright.
export async function readPageThroughGateway(
  input: BrowserReadInput,
  baseUrl: string,
  token: string,
): Promise<Response> {
  return fetch(`${baseUrl}/read`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify(input),
    signal: AbortSignal.timeout(75_000),
  });
}
