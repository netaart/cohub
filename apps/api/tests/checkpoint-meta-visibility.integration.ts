import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, mock, test } from "node:test";

process.env.LOG_LEVEL = "silent";
const root = await mkdtemp(join(tmpdir(), "cohub-checkpoint-meta-test-"));
const spaceId = "space";
const workspace = join(root, spaceId, "workspace");
const HIDDEN = ".env";
const VISIBLE = "src/app.ts";
const PATCH_TEXT = "SECRET_PATCH_LINE";
let rows: unknown[] = [];
const mocks = [
  mock.module("../src/config.js", { exports: { config: { spaceStorageRoot: root, spaceSystemRoot: root } } }),
  mock.module("../src/db/index.js", { exports: { db: {
    select: () => ({ from: () => ({ where: () => ({ limit: async () => rows }) }) }),
  } } }),
  mock.module("../src/redis.js", { exports: { redisCommandClient: {
    get: async () => null,
    set: async () => undefined,
  } } }),
  mock.module("../src/object-presign.js", { exports: { createPresignedGetObjectUrl: () => {} } }),
  mock.module("../src/checkpoint-storage.js", { exports: { ensureCheckpointObjects: async () => undefined } }),
];
after(async () => { for (const item of mocks.reverse()) item.restore(); await rm(root, { recursive: true, force: true }); });

const summaryFile = (path: string) => ({ path, oldPath: null, status: "A", kind: "text", binary: false, asset: false, additions: 1, deletions: 0, truncated: false, oldSize: null, newSize: 3 });
const patchFile = (path: string) => ({
  version: 1,
  delivery: "inline",
  patch: { ...summaryFile(path), lines: [{ type: "add", text: PATCH_TEXT }] },
});
const checkpoint = {
  id: "checkpoint",
  spaceId,
  commitHash: "a".repeat(40),
  description: "save",
  parentCheckpointId: null,
  rootCheckpointId: null,
  forkCount: 0,
  createdAt: new Date(0),
  meta: {
    stats: { changedFileCount: 2 },
    paths: { latestSubPath: "cache/space/latest" },
    storage: { seq: 3 },
    diffs: {
      parent: {
        version: 1,
        kind: "parent",
        delivery: "inline",
        summary: {
          baseCheckpointId: null,
          baseCommitHash: null,
          headCheckpointId: "checkpoint",
          headCommitHash: "a".repeat(40),
          files: [summaryFile(HIDDEN), summaryFile(VISIBLE)],
          truncated: false,
          stats: { changedFileCount: 2, addedFileCount: 2, modifiedFileCount: 0, deletedFileCount: 0, renamedFileCount: 0, copiedFileCount: 0, additions: 2, deletions: 0 },
          precomputed: true,
          delivery: "inline",
        },
        files: { [HIDDEN]: patchFile(HIDDEN), [VISIBLE]: patchFile(VISIBLE) },
      },
    },
    warnings: [{ path: HIDDEN, type: "unsupported" }, { path: VISIBLE, type: "unsupported" }, { type: "git_remote" }],
  },
};

await mkdir(join(workspace, "src"), { recursive: true });
await writeFile(join(workspace, ".gitignore"), `${HIDDEN}\n`);

const { redactCheckpointForView } = await import("../src/checkpoint-fs.js");
const { getCheckpointDiffSummary } = await import("../src/checkpoint-diff.js");

test("checkpoint row keeps diff patch text only for the full file view", async () => {
  assert.deepEqual((await redactCheckpointForView(checkpoint, "full")).meta, checkpoint.meta);
  for (const visibility of ["filtered", null] as const) {
    const row = await redactCheckpointForView(checkpoint, visibility);
    const payload = JSON.stringify(row);
    assert.equal(payload.includes(PATCH_TEXT), false);
    assert.equal(payload.includes(HIDDEN), false);
    assert.equal("diffs" in (row.meta as object), false);
    assert.equal("paths" in (row.meta as object), false);
    assert.equal("storage" in (row.meta as object), false);
  }
  assert.deepEqual((await redactCheckpointForView(checkpoint, "filtered")).meta, {
    stats: { changedFileCount: 2 },
    warnings: [{ path: VISIBLE, type: "unsupported" }, { type: "git_remote" }],
  });
  assert.deepEqual((await redactCheckpointForView(checkpoint, null)).meta, {
    stats: { changedFileCount: 2 },
    warnings: [{ type: "git_remote" }],
  });
});

test("diff summary payload has paths, status and sizes, never patch lines", async () => {
  rows = [checkpoint];
  const summary = await getCheckpointDiffSummary({ spaceId, checkpointId: checkpoint.id, visibility: "full" });
  const payload = JSON.stringify(summary);
  assert.equal(payload.includes(PATCH_TEXT), false);
  assert.equal(payload.includes('"lines"'), false);
  assert.equal(summary.precomputed, true);
  assert.deepEqual(summary.files.map((file) => file.path), [HIDDEN, VISIBLE]);
  for (const file of summary.files) {
    assert.deepEqual(Object.keys(file).sort(), ["additions", "asset", "binary", "deletions", "kind", "newSize", "oldPath", "oldSize", "path", "status", "truncated"]);
  }
});
