import type { EnvironmentReport } from "@pba/contracts";

export async function inspectEnvironment(): Promise<EnvironmentReport> {
  return { status: "ok", nodeVersion: process.version };
}
