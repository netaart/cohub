import assert from "node:assert/strict";
import { test } from "node:test";
import { validSandboxdArchiveEntries, validateSandboxdArchive } from "../src/commands/sandboxd-binary.js";
import { mkdtemp, writeFile, symlink, link, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);

test("archive validation rejects links and directories before extraction", async () => {
  const root = await mkdtemp(join(tmpdir(), "sandboxd-archive-test-"));
  try {
    await writeFile(join(root, "LICENSE"), "license");
    await writeFile(join(root, "NOTICE"), "notice");
    const binary = join(root, "cohub-sandboxd");
    const archive = join(root, "test.tar.gz");
    for (const kind of ["regular", "symlink", "hardlink", "directory"]) {
      await rm(binary, { force: true, recursive: true });
      if (kind === "regular") await writeFile(binary, "binary");
      if (kind === "symlink") await symlink("LICENSE", binary);
      if (kind === "hardlink") await link(join(root, "LICENSE"), binary);
      if (kind === "directory") await mkdir(binary);
      await exec("tar", ["-czf", archive, "-C", root, "LICENSE", "NOTICE", "cohub-sandboxd"]);
      if (kind === "regular") {
        await validateSandboxdArchive(archive, "linux");
      } else {
        await assert.rejects(validateSandboxdArchive(archive, "linux"));
      }
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("sandboxd archives must ship the binary with its notices", () => {
  assert(validSandboxdArchiveEntries(["cohub-sandboxd", "LICENSE", "NOTICE"], "linux"));
  assert(validSandboxdArchiveEntries(["NOTICE", "cohub-sandboxd", "LICENSE"], "linux"));
  for (const entries of [[], ["cohub-sandboxd"], ["LICENSE"], ["cohub-sandboxd", "LICENSE"], ["cohub-sandboxd", "LICENSE", "../NOTICE"], ["cohub-sandboxd", "LICENSE", "/NOTICE"], ["cohub-sandboxd", "LICENSE", "NOTICE", "extra"], ["cohub-sandboxd", "LICENSE", "LICENSE"]]) {
    assert.equal(validSandboxdArchiveEntries(entries, "linux"), false);
  }
});
