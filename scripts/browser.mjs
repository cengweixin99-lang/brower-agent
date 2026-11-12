import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const browserDirectory = join(root, ".data", "browsers");
const temporaryDirectory = join(root, ".data", "tmp");
mkdirSync(browserDirectory, { recursive: true });
mkdirSync(temporaryDirectory, { recursive: true });
const require = createRequire(new URL("../packages/browser/package.json", import.meta.url));
const command = process.argv[2];
let args;
if (command === "install") {
  args = [
    join(dirname(require.resolve("playwright/package.json")), "cli.js"),
    "install",
    "chromium",
    "--no-shell",
  ];
} else if (command === "smoke" || command === "smoke-web") {
  args = [join(root, "packages", "browser", "scripts", `${command}.ts`)];
} else {
  throw new Error("Expected install, smoke, or smoke-web.");
}
const result = spawnSync(process.execPath, args, {
  cwd: root,
  stdio: "inherit",
  env: {
    ...process.env,
    PLAYWRIGHT_BROWSERS_PATH: browserDirectory,
    TMPDIR: temporaryDirectory,
    TEMP: temporaryDirectory,
    TMP: temporaryDirectory,
  },
});
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
