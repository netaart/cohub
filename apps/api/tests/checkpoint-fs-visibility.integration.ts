import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, mock, test } from "node:test";

process.env.LOG_LEVEL = "silent";
const root = await mkdtemp(join(tmpdir(), "cohub-checkpoint-visibility-test-"));
const spaceId = "space";
const workspace = join(root, spaceId, "workspace");
const repo = join(root, spaceId, "repo");
const checkpoint = { id: "checkpoint", spaceId, commitHash: "", createdAt: new Date(0), parentCheckpointId: null };
let active = checkpoint;
const cache = new Map<string, string>();
const mocks = [
  mock.module("../src/config.js", { exports: { config: { spaceStorageRoot: root, spaceSystemRoot: root } } }),
  mock.module("../src/db/index.js", { exports: { db: {
    select: () => ({ from: () => ({ where: () => ({ limit: async () => [active] }) }) }),
  } } }),
  mock.module("../src/redis.js", { exports: { redisCommandClient: {
    get: async (key: string) => cache.get(key) ?? null,
    set: async (key: string, value: string) => { cache.set(key, value); },
  } } }),
  mock.module("../src/object-presign.js", { exports: { createPresignedGetObjectUrl: () => {} } }),
  mock.module("../src/checkpoint-storage.js", { exports: { ensureCheckpointObjects: async () => undefined } }),
  mock.module("../src/space-fs-cdn-cache.js", { exports: {
    buildPreparingFile: () => {}, buildUrlFileResponse: () => {}, ensureFsCdnManifest: () => {},
    enqueueFsCdnWarmForMeta: () => {}, getFreshFsCdnManifests: () => {}, shouldUseFsCdnForMeta: () => {},
    waitForFsCdnManifests: () => {},
  } }),
];
after(async () => { for (const item of mocks.reverse()) item.restore(); await rm(root, { recursive: true, force: true }); });

const git = (dir: string, ...args: string[]) => execFileSync("git", ["-C", dir, ...args], {
  encoding: "utf8",
  stdio: ["ignore", "pipe", "pipe"],
  env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.test", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.test" },
}).trim();

const HIDDEN = ".cohub/secret.txt";
const VISIBLE = ".cohub/normal.txt";

await mkdir(join(workspace, ".cohub"), { recursive: true });
await mkdir(repo, { recursive: true });
await writeFile(join(workspace, ".gitignore"), "");
await writeFile(join(repo, "placeholder"), "");
git(repo, "init", "-q");
await mkdir(join(repo, ".cohub"), { recursive: true });
await writeFile(join(repo, VISIBLE), "OLD");
await writeFile(join(repo, HIDDEN), "SECRET");
git(repo, "add", ".");
git(repo, "commit", "-q", "-m", "checkpoint");
checkpoint.commitHash = git(repo, "rev-parse", "HEAD");

const { listCheckpointDirectory, readCheckpointFile } = await import("../src/checkpoint-fs.js");
const { getCheckpointDiffFile, getCheckpointDiffSummary } = await import("../src/checkpoint-diff.js");

const guest = "filtered" as const;
const owner = "full" as const;
const notFound = { status: 404, code: "path_not_found" };
const hideRule = async () => { await writeFile(join(workspace, ".gitignore"), `${HIDDEN}\n`); };

test("owner sees the file through every checkpoint route", async () => {
  assert.equal((await readCheckpointFile({ spaceId, checkpointId: checkpoint.id, path: HIDDEN, visibility: owner })).content, "SECRET");
  const tree = await listCheckpointDirectory({ spaceId, checkpointId: checkpoint.id, path: ".cohub", visibility: owner });
  assert.deepEqual(tree.entries.map((entry) => entry.name).sort(), ["normal.txt", "secret.txt"]);
  const summary = await getCheckpointDiffSummary({ spaceId, checkpointId: checkpoint.id, visibility: owner });
  assert.ok(summary.files.some((file) => file.path === HIDDEN));
  const diff = await getCheckpointDiffFile({ spaceId, checkpointId: checkpoint.id, path: HIDDEN, visibility: owner });
  assert.equal(diff.status, "A");
});

test("guest reads files that are not ignored, including after the rule is added", async () => {
  assert.equal((await readCheckpointFile({ spaceId, checkpointId: checkpoint.id, path: VISIBLE, visibility: guest })).content, "OLD");
  const tree = await listCheckpointDirectory({ spaceId, checkpointId: checkpoint.id, path: ".cohub", visibility: guest });
  assert.deepEqual(tree.entries.map((entry) => entry.name).sort(), ["normal.txt", "secret.txt"]);
  await hideRule();
});

test("guest gets path_not_found for an ignored committed file on every checkpoint route", async () => {
  await assert.rejects(readCheckpointFile({ spaceId, checkpointId: checkpoint.id, path: HIDDEN, visibility: guest }), notFound);
  await assert.rejects(getCheckpointDiffFile({ spaceId, checkpointId: checkpoint.id, path: HIDDEN, visibility: guest }), notFound);
  const tree = await listCheckpointDirectory({ spaceId, checkpointId: checkpoint.id, path: ".cohub", visibility: guest });
  assert.deepEqual(tree.entries.map((entry) => entry.name), ["normal.txt"]);
  const summary = await getCheckpointDiffSummary({ spaceId, checkpointId: checkpoint.id, visibility: guest });
  assert.ok(!summary.files.some((file) => file.path === HIDDEN));
  assert.ok(summary.files.some((file) => file.path === VISIBLE));
  await assert.rejects(listCheckpointDirectory({ spaceId, checkpointId: checkpoint.id, path: ".cohub/secret.txt", visibility: guest }), notFound);
});

test("guest diff of a visible file still works after owner reads populated the cache", async () => {
  const diff = await getCheckpointDiffFile({ spaceId, checkpointId: checkpoint.id, path: VISIBLE, visibility: guest });
  assert.equal(diff.status, "A");
  assert.equal(diff.newSize, 3);
});

test("reads of a checkpoint committed before a .gitignore rule are filtered by the current rule", async () => {
  const late = ".cohub/late.txt";
  const c3 = { ...checkpoint, id: "c3" };
  const c4 = { ...checkpoint, id: "c4" };
  await writeFile(join(workspace, ".gitignore"), "");
  await writeFile(join(repo, late), "LATE");
  git(repo, "add", late);
  git(repo, "commit", "-q", "-m", "c3");
  c3.commitHash = git(repo, "rev-parse", "HEAD");
  await writeFile(join(workspace, ".gitignore"), `${late}\n`);
  git(repo, "rm", "-q", late);
  git(repo, "commit", "-q", "-m", "c4");
  c4.commitHash = git(repo, "rev-parse", "HEAD");

  active = c3;
  assert.equal((await readCheckpointFile({ spaceId, checkpointId: "c3", path: late, visibility: owner })).content, "LATE");
  assert.ok((await listCheckpointDirectory({ spaceId, checkpointId: "c3", path: ".cohub", visibility: owner })).entries.some((entry) => entry.name === "late.txt"));
  assert.equal((await getCheckpointDiffFile({ spaceId, checkpointId: "c3", path: late, visibility: owner })).status, "A");
  assert.ok([...cache.keys()].some((key) => key.startsWith("checkpoint-fs:blob:v1:c3:")), "owner read populated the C3 blob cache");

  await assert.rejects(readCheckpointFile({ spaceId, checkpointId: "c3", path: late, visibility: guest }), notFound);
  const guestTree = await listCheckpointDirectory({ spaceId, checkpointId: "c3", path: ".cohub", visibility: guest });
  assert.deepEqual(guestTree.entries.map((entry) => entry.name).sort(), ["normal.txt", "secret.txt"]);
  await assert.rejects(getCheckpointDiffFile({ spaceId, checkpointId: "c3", path: late, visibility: guest }), notFound);
  const guestSummary = await getCheckpointDiffSummary({ spaceId, checkpointId: "c3", visibility: guest });
  assert.ok(!guestSummary.files.some((file) => file.path === late));

  active = c4;
  await assert.rejects(readCheckpointFile({ spaceId, checkpointId: "c4", path: late, visibility: guest }), notFound);
  await assert.rejects(readCheckpointFile({ spaceId, checkpointId: "c4", path: late, visibility: owner }), notFound);

  active = c3;
  assert.equal((await readCheckpointFile({ spaceId, checkpointId: "c3", path: late, visibility: owner })).content, "LATE");
});
