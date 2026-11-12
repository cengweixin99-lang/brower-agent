import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const manifests = [
  "package.json",
  ...["apps", "packages"].flatMap((directory) =>
    readdirSync(directory, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(directory, entry.name, "package.json")),
  ),
];
for (const path of manifests) {
  const manifest = JSON.parse(readFileSync(path, "utf8"));
  assert.equal(manifest.private, true, `${path}: workspace must be private`);
  for (const dependencies of [manifest.dependencies, manifest.devDependencies]) {
    for (const [name, version] of Object.entries(dependencies ?? {})) {
      assert.ok(
        typeof version === "string" &&
          (version === "workspace:*" || /^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(version)),
        `${path}: ${name} must use an exact version`,
      );
    }
  }
}
console.log(`PASS: ${manifests.length} private manifests; direct dependencies are pinned.`);
