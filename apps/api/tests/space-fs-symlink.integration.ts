import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, mock, test } from "node:test";
import { isSpaceFsSymlink } from "@cohub/protocol/fs";

process.env.LOG_LEVEL = "silent";

const storageRoot = await mkdtemp(join(tmpdir(), "cohub-fs-"));
const spaceId = "s";
const workspace = join(storageRoot, spaceId, "workspace");

const mocks = [
  mock.module("../src/config.js", { exports: { config: { spaceStorageRoot: storageRoot } } }),
  mock.module("../src/space-fs-cdn-cache.js", { exports: {
    buildPreparingFile: () => {}, buildUrlFileResponse: () => {}, ensureFsCdnManifest: () => {},
    enqueueFsCdnWarmForMeta: () => {}, getFreshFsCdnManifests: async () => new Map(), shouldUseFsCdnForMeta: () => false,
    waitForFsCdnManifests: async () => ({ ready: new Map(), pending: [] }),
  } }),
];
after(async () => {
  for (const item of mocks.reverse()) item.restore();
  await rm(storageRoot, { recursive: true, force: true });
});

const { readSpaceFile, readSpaceFiles } = await import("../src/space-fs.js");

await mkdir(join(workspace, "docs"), { recursive: true });
await writeFile(join(workspace, "CLAUDE.md"), "rules");
await writeFile(join(workspace, "secret.md"), "hidden");
await writeFile(join(storageRoot, "outside.md"), "private");
await writeFile(join(workspace, ".gitignore"), "secret.md\nhidden-link.md\n");
await symlink("CLAUDE.md", join(workspace, "AGENTS.md"));
await symlink("../CLAUDE.md", join(workspace, "docs", "up.md"));
await symlink("/workspace/CLAUDE.md", join(workspace, "absolute.md"));
await symlink("../../outside.md", join(workspace, "escape.md"));
await symlink("secret.md", join(workspace, "secret-link.md"));
await symlink("CLAUDE.md", join(workspace, "hidden-link.md"));

async function readLink(path: string, visibility: "full" | "filtered" = "full") {
  const file = await readSpaceFile(spaceId, path, { visibility, describeSymlink: true });
  assert.ok(isSpaceFsSymlink(file), `${path} should read as a symlink`);
  const { size: _size, mtimeMs: _mtimeMs, ...link } = file;
  return link;
}

test("describes symlinks by link text and resolves in-workspace targets", async () => {
  assert.deepEqual(await readLink("AGENTS.md"), { kind: "symlink", path: "AGENTS.md", name: "AGENTS.md", target: "CLAUDE.md", targetPath: "CLAUDE.md" });
  assert.equal((await readLink("docs/up.md")).targetPath, "CLAUDE.md");
  assert.equal((await readLink("absolute.md")).targetPath, "CLAUDE.md");
  assert.deepEqual(await readLink("escape.md"), { kind: "symlink", path: "escape.md", name: "escape.md", target: "../../outside.md" });
});

test("symlinks keep visibility checks and stay rejected elsewhere", async () => {
  assert.equal((await readLink("secret-link.md", "filtered")).targetPath, "secret.md");
  await assert.rejects(readSpaceFile(spaceId, "secret.md", { visibility: "filtered" }), { status: 404 });
  await assert.rejects(readLink("hidden-link.md", "filtered"), { status: 404 });

  await assert.rejects(readSpaceFile(spaceId, "AGENTS.md"), { code: "symlink_not_supported" });
  const batch = await readSpaceFiles(spaceId, ["AGENTS.md"]);
  assert.equal(batch.errors[0]?.code, "symlink_not_supported");
});
