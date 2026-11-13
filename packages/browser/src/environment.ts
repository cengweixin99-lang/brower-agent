import { fileURLToPath } from "node:url";

// Loaded before Playwright evaluates its browser registry, for every entry point.
process.env.PLAYWRIGHT_BROWSERS_PATH ??= fileURLToPath(new URL("../../../.data/browsers", import.meta.url));
