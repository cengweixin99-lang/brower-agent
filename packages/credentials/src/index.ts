import { randomBytes } from "node:crypto";
import { link, mkdir, readFile, rm, writeFile } from "node:fs/promises";

// Local service credential; never sent to the frontend or stored in Git.
export async function gatewayToken(): Promise<string> {
  if (process.env.BROWSER_GATEWAY_TOKEN) return process.env.BROWSER_GATEWAY_TOKEN;
  const directory = new URL("../../../.data/", import.meta.url);
  const file = new URL("gateway-token", directory);
  await mkdir(directory, { recursive: true });
  const temporary = new URL(`gateway-${randomBytes(12).toString("hex")}.tmp`, directory);
  await writeFile(temporary, randomBytes(32).toString("hex"), { flag: "wx", mode: 0o600 });
  try {
    await link(temporary, file);
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
  } finally {
    await rm(temporary, { force: true });
  }
  return (await readFile(file, "utf8")).trim();
}
