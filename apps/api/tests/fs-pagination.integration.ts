import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, mock, test } from "node:test";
import type { SpaceFsTreePage } from "@cohub/protocol/fs";

process.env.LOG_LEVEL = "silent";
const root = await mkdtemp(join(tmpdir(), "cohub-list-test-"));
let supportsPagination = false;
let rpc: (params: Record<string, unknown>) => unknown;
const checkpoint = { id: "checkpoint", spaceId: "space", commitHash: "", createdAt: new Date(0) };
const cache = new Map<string, string>();
const mocks = [
  mock.module("../src/config.js", { exports: { config: { spaceStorageRoot: root, spaceSystemRoot: root } } }),
  mock.module("../src/db/index.js", { exports: { db: {
    select: () => ({ from: () => ({ where: () => ({ limit: async () => [checkpoint] }) }) }),
  } } }),
  mock.module("../src/redis.js", { exports: { redisCommandClient: {
    get: async (key: string) => cache.get(key) ?? null,
    set: async (key: string, value: string) => { cache.set(key, value); },
  } } }),
  mock.module("../src/object-presign.js", { exports: { createPresignedGetObjectUrl: () => {} } }),
  mock.module("../src/space-sandbox-rpc.js", { exports: {
    getSandboxCapabilities: async () => ({ fsTreePagination: supportsPagination }),
    callSandboxRpc: async (_space: string, method: string, params: Record<string, unknown>) => { assert.equal(method, "fs.tree"); return rpc(params); },
    SandboxOfflineError: class extends Error {},
  } }),
  mock.module("../src/space-fs-cdn-cache.js", { exports: {
    buildPreparingFile: () => {}, buildUrlFileResponse: () => {}, ensureFsCdnManifest: () => {},
    enqueueFsCdnWarmForMeta: () => {}, getFreshFsCdnManifests: () => {}, shouldUseFsCdnForMeta: () => {},
    waitForFsCdnManifests: () => {},
  } }),
];
after(async () => { for (const item of mocks.reverse()) item.restore(); await rm(root, { recursive: true, force: true }); });
const direct = await import("../src/space-fs.js");
const remote = await import("../src/space-fs-remote.js");
const entry = (name: string) => ({ name, path: name, type: "file", size: 0, mtimeMs: 0 });

async function populateDirectory(path: string, count: number) {
  await mkdir(path, { recursive: true });
  for (let batch = 0; batch < count; batch += 100) {
    await Promise.all(Array.from({ length: Math.min(100, count - batch) }, (_, index) => writeFile(join(path, `file-${String(batch + index).padStart(5, "0")}`), "")));
  }
}

test("direct listing reads more than 5000 entries in full or in bounded pages", async () => {
  const path = join(root, "space", "workspace");
  await populateDirectory(path, 5001);
  const all = await direct.listSpaceDirectory("space");
  assert.equal(all.entries.length, 5001);
  assert.deepEqual(Object.keys(all).sort(), ["entries", "path"]);
  const names = new Set<string>();
  let cursor: string | undefined;
  let firstCursor: string | undefined;
  do {
    const page = await direct.listSpaceDirectory("space", "", { pagination: true, limit: 1000, cursor }) as SpaceFsTreePage;
    assert.ok(page.entries.length <= 1000);
    assert.equal(page.truncated, false);
    for (const entry of page.entries) { assert.ok(!names.has(entry.name)); names.add(entry.name); }
    cursor = page.nextCursor ?? undefined;
    firstCursor ??= cursor;
  } while (cursor);
  assert.equal(names.size, 5001);
  await writeFile(join(path, "new-file"), "");
  const resumed = await direct.listSpaceDirectory("space", "", { pagination: true, cursor: firstCursor }) as SpaceFsTreePage;
  assert.equal(resumed.entries[0]?.name, "file-01000");
});

test("old sandboxes keep their request and result, including truncation", async () => {
  supportsPagination = false;
  rpc = (params) => {
    assert.deepEqual(params, { path: ".", depth: 1, limit: 1000, respectGitignore: false });
    return { path: "/workspace", entries: [entry("a"), entry("b")], truncated: true };
  };
  const legacy = await remote.listSpaceDirectory("local");
  assert.deepEqual(Object.keys(legacy).sort(), ["entries", "path"]);
  assert.equal(legacy.entries.length, 2);
  const first = await remote.listSpaceDirectory("local", "", { pagination: true, limit: 1 }) as SpaceFsTreePage;
  assert.equal(first.truncated, true);
  assert.ok(first.nextCursor);
  const second = await remote.listSpaceDirectory("local", "", { pagination: true, limit: 1, cursor: first.nextCursor }) as SpaceFsTreePage;
  assert.equal(second.entries[0]?.name, "b");
  assert.equal(second.nextCursor, null);
  assert.equal(second.truncated, true);
});

test("new sandboxes auto-page legacy API calls and forward explicit pagination", async () => {
  supportsPagination = true;
  const cursors: unknown[] = [];
  rpc = (params) => {
    assert.equal(params.pagination, true);
    cursors.push(params.cursor);
    return { path: "/workspace", entries: [entry(params.cursor ? "b" : "a")], nextCursor: params.cursor ? null : "next", truncated: false };
  };
  assert.equal((await remote.listSpaceDirectory("local")).entries.length, 2);
  assert.deepEqual(cursors, [undefined, "next"]);
  const page = await remote.listSpaceDirectory("local", "", { pagination: true, cursor: "next" }) as SpaceFsTreePage;
  assert.equal(page.entries[0]?.name, "b");
  assert.equal(page.nextCursor, null);
  assert.equal(page.truncated, false);
});

test("checkpoint pagination reads uncapped trees and reuses the versioned full-tree cache", async () => {
  const repo = join(root, "space", "repo");
  await populateDirectory(repo, 1001);
  const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  git("init");
  git("add", ".");
  checkpoint.commitHash = git("write-tree");
  const { listCheckpointDirectory } = await import("../src/checkpoint-fs.js");
  const input = { spaceId: "space", checkpointId: checkpoint.id };
  const tree = await listCheckpointDirectory(input);
  assert.equal(tree.entries.length, 1001);
  assert.ok([...cache.keys()].some((key) => key.startsWith("checkpoint-fs:tree:v2:")));
  const first = await listCheckpointDirectory({ ...input, pagination: { pagination: true, limit: 1000 } }) as SpaceFsTreePage;
  assert.equal(first.entries.length, 1000);
  assert.ok(first.nextCursor);
  const second = await listCheckpointDirectory({ ...input, pagination: { pagination: true, limit: 1000, cursor: first.nextCursor } }) as SpaceFsTreePage;
  assert.equal(new Set([...first.entries, ...second.entries].map((entry) => entry.name)).size, 1001);
  checkpoint.id = "other-checkpoint";
  await assert.rejects(listCheckpointDirectory({ ...input, checkpointId: checkpoint.id, pagination: { pagination: true, cursor: first.nextCursor } }), { code: "directory_changed" });
});
