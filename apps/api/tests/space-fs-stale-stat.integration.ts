import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as realFs from "node:fs/promises";
import { chmod, mkdtemp, mkdir, readFile, rm, stat as realStat, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, mock, test } from "node:test";

process.env.LOG_LEVEL = "silent";

const storageRoot = await mkdtemp(join(tmpdir(), "cohub-fs-"));
const spaceId = "s"; // short: Unix socket paths are limited to 104 bytes on macOS
const workspace = join(storageRoot, spaceId, "workspace");
const target = join(workspace, "AGENTS.md");
const stale = new Map<string, Awaited<ReturnType<typeof realStat>>>();

// Simulates another API replica whose NFS attribute cache still holds an old version.
const mocks = [
  mock.module("node:fs/promises", { exports: {
    ...realFs,
    stat: async (path: string) => stale.get(path) ?? realFs.stat(path),
    lstat: async (path: string) => stale.get(path) ?? realFs.lstat(path),
  } }),
  mock.module("../src/config.js", { exports: { config: { spaceStorageRoot: storageRoot } } }),
  mock.module("../src/space-fs-cdn-cache.js", { exports: {
    buildPreparingFile: () => {}, buildUrlFileResponse: () => {}, ensureFsCdnManifest: () => {},
    enqueueFsCdnWarmForMeta: () => {}, getFreshFsCdnManifests: () => {}, shouldUseFsCdnForMeta: () => false,
    waitForFsCdnManifests: () => {},
  } }),
];
after(async () => {
  for (const item of mocks.reverse()) item.restore();
  await rm(storageRoot, { recursive: true, force: true });
});

const { readSpaceFile, writeSpaceFile } = await import("../src/space-fs.js");

test("file versions ignore stale path attributes", async () => {
  await mkdir(workspace, { recursive: true });
  await writeFile(target, "old");
  stale.set(target, await realStat(target));
  await writeFile(target, "newer content");
  const fresh = await realStat(target);

  const read = await readSpaceFile(spaceId, "AGENTS.md");
  assert.equal(read.delivery, "inline");
  assert.equal(read.size, fresh.size);
  assert.equal(Math.trunc(read.mtimeMs), Math.trunc(fresh.mtimeMs));

  const expected = { size: fresh.size, mtimeMs: fresh.mtimeMs };
  await writeSpaceFile(spaceId, { path: "AGENTS.md", content: "saved", expected });
  assert.equal(await readFile(target, "utf8"), "saved");
  await assert.rejects(writeSpaceFile(spaceId, { path: "AGENTS.md", content: "x", expected }), { code: "file_conflict" });
  assert.equal(await readFile(target, "utf8"), "saved");
});

test("version checks reject special files and keep real open errors", async () => {
  execFileSync("mkfifo", [join(workspace, "pipe.md")]);
  const server = createServer();
  await new Promise<void>((done) => server.listen(join(workspace, "socket.md"), done));
  const expected = { size: 0, mtimeMs: 0 };
  try {
    for (const path of ["pipe.md", "socket.md"]) {
      await assert.rejects(writeSpaceFile(spaceId, { path, content: "x", expected }), { code: "file_conflict" });
    }
  } finally {
    server.close();
  }

  if (process.getuid?.() === 0) return;
  const locked = join(workspace, "locked.md");
  await writeFile(locked, "locked");
  await chmod(locked, 0o000);
  await assert.rejects(
    writeSpaceFile(spaceId, { path: "locked.md", content: "x", expected }),
    (error: NodeJS.ErrnoException) => error.code === "EACCES",
  );
});
