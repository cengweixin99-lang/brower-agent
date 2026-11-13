import { createHash, randomUUID } from "node:crypto";
import { link, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseScreenshotArtifact, type ScreenshotArtifact } from "@pba/contracts/runtime";

// Directory comes only from trusted process configuration. Requests never supply filesystem paths.
export class ScreenshotStore {
  private readonly root: string;
  constructor(
    root = process.env.RUNTIME_ARTIFACT_ROOT ??
      fileURLToPath(new URL("../../../.data/runtime-artifacts/", import.meta.url)),
  ) {
    this.root = root;
  }
  private path(id: string): string {
    if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(id))
      throw new Error("Invalid artifact identifier");
    return join(this.root, `${id}.png`);
  }
  async write(artifactId: string, bytes: Buffer): Promise<ScreenshotArtifact> {
    if (!bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])))
      throw new Error("Invalid PNG");
    const metadata = parseScreenshotArtifact({
      artifactId,
      mimeType: "image/png",
      sha256: createHash("sha256").update(bytes).digest("hex"),
      byteLength: bytes.length,
    });
    const target = this.path(artifactId);
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const temporary = join(this.root, `${randomUUID()}.tmp`);
    try {
      await writeFile(temporary, bytes, { flag: "wx", mode: 0o600 });
      await link(temporary, target);
    } finally {
      await rm(temporary, { force: true });
    }
    return metadata;
  }
  async read(metadata: ScreenshotArtifact): Promise<Buffer> {
    const bytes = await readFile(this.path(metadata.artifactId));
    if (
      bytes.length !== metadata.byteLength ||
      createHash("sha256").update(bytes).digest("hex") !== metadata.sha256
    )
      throw new Error("Artifact integrity mismatch");
    return bytes;
  }
  async remove(artifactId: string): Promise<void> {
    await rm(this.path(artifactId), { force: true });
  }
}
