import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SANDBOXD_VERSION, validateSandboxdArchive } from "../src/commands/sandboxd-binary.js";

// Validate the exact public artifacts a clean installation will download.
const directory = await mkdtemp(join(tmpdir(), "sandboxd-release-"));
try {
  for (const platform of ["linux_amd64", "linux_arm64", "darwin_amd64", "darwin_arm64", "windows_amd64", "windows_arm64"]) {
    const name = `cohub-sandboxd_${SANDBOXD_VERSION}_${platform}.tar.gz`;
    const url = `https://public.cohub.live/sandboxd/${SANDBOXD_VERSION}/${name}`;
    const [archive, checksum] = await Promise.all([
      fetch(url, { signal: AbortSignal.timeout(120_000) }),
      fetch(`${url}.sha256`, { signal: AbortSignal.timeout(30_000) }),
    ]);
    if (!archive.ok || !checksum.ok) throw new Error(`Unpublished sandbox artifact: ${name}`);
    const bytes = Buffer.from(await archive.arrayBuffer());
    const expected = (await checksum.text()).trim().split(/\s+/)[0];
    if (createHash("sha256").update(bytes).digest("hex") !== expected) throw new Error(`Invalid checksum: ${name}`);
    const path = join(directory, name);
    await writeFile(path, bytes);
    await validateSandboxdArchive(path, platform.split("_")[0]);
    console.log(`Verified ${name}`);
  }
} finally {
  await rm(directory, { recursive: true, force: true });
}
