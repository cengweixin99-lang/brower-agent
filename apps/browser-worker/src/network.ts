import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { resolveAllowedUrl } from "@pba/policy";

// Resolve once, validate, and pin the connection to that address (including every redirect).
// Browser cookies, credentials and arbitrary request headers are deliberately not forwarded.
export async function readResource(
  raw: string,
  allowedOrigins: string[],
  signal: AbortSignal,
): Promise<{ status: number; headers: Record<string, string>; body: Buffer }> {
  const { url, address, family } = await resolveAllowedUrl(raw, allowedOrigins);
  return new Promise((resolve, reject) => {
    const request = (url.protocol === "https:" ? httpsRequest : httpRequest)(
      url,
      {
        method: "GET",
        signal,
        timeout: 15_000,
        lookup: (_host, options, callback) =>
          options.all ? callback(null, [{ address, family }]) : callback(null, address, family),
        headers: {
          "user-agent": "BrowseAgent/0.1 (read-only page capture)",
          accept: "*/*",
          "accept-encoding": "identity",
        },
      },
      (response) => {
        const chunks: Buffer[] = [];
        let size = 0;
        response.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > 5_000_000) response.destroy(new Error("Page resource exceeds 5 MB"));
          else chunks.push(chunk);
        });
        response.on("error", reject);
        response.on("end", () => {
          const headers: Record<string, string> = {};
          for (const name of ["content-type", "location", "content-security-policy"]) {
            const value = response.headers[name];
            if (typeof value === "string") headers[name] = value;
          }
          resolve({ status: response.statusCode ?? 502, headers, body: Buffer.concat(chunks) });
        });
      },
    );
    request.on("timeout", () => request.destroy(new Error("Page request timed out")));
    request.on("error", reject);
    request.end();
  });
}
