import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cp, lstat, mkdir, mkdtemp, readFile, readdir, readlink, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, mock, test } from "node:test";
import { spaces } from "@cohub/db";

process.env.LOG_LEVEL = "silent";
const root = await mkdtemp(join(tmpdir(), "cohub-checkpoint-storage-"));
const bucket = join(root, "bucket");
const spaceId = "11111111-1111-4111-8111-111111111111";
const forkSpaceId = "22222222-2222-4222-8222-222222222222";

const store = {
  async download(key: string, filePath: string) {
    const source = join(bucket, key);
    if (!await stat(source).then(() => true, () => false)) return false;
    await cp(source, filePath);
    return true;
  },
  async readText(key: string) {
    return readFile(join(bucket, key), "utf8").catch(() => null);
  },
};
const put = async (key: string, body: string | Buffer) => {
  await mkdir(dirname(join(bucket, key)), { recursive: true });
  await writeFile(join(bucket, key), body);
};

type Row = Record<string, unknown> & { id: string; spaceId: string; commitHash: string };
const state = { spaces: new Map<string, { id: string; headCheckpointId: string | null; slug: string | null; userUuid: string }>(), checkpoints: new Map<string, Row>(), currentSpace: spaceId, headMoved: false, crashAfterCommit: false, lookup: "" };
const compactions: Array<{ commit: string; seq: number }> = [];

const fakeDb = {
  select: (fields?: unknown) => ({
    from: (table: unknown) => ({
      where: () => ({
        limit: async () => {
          if (table === spaces) {
            const lookup = state.checkpoints.get(state.lookup);
            return [state.spaces.get(lookup && !fields ? lookup.spaceId : state.currentSpace)];
          }
          if (fields) return [state.checkpoints.get(state.spaces.get(state.currentSpace)?.headCheckpointId ?? "")].filter(Boolean);
          return [state.checkpoints.get(state.lookup)].filter(Boolean);
        },
      }),
    }),
  }),
  transaction: async (fn: (tx: unknown) => Promise<Row>) => {
    let inserted: Row | null = null;
    const result = await fn({
      insert: () => ({ values: (row: Row) => ({ returning: async () => { inserted = row; return [row]; } }) }),
      update: () => ({ set: (values: { headCheckpointId: string }) => ({ where: () => ({ returning: async () => {
        if (state.headMoved) return [];
        const space = state.spaces.get(state.currentSpace);
        if (space) space.headCheckpointId = values.headCheckpointId;
        return [{ id: state.currentSpace }];
      } }) }) }),
    });
    if (inserted) state.checkpoints.set(inserted.id, inserted);
    if (state.crashAfterCommit) throw new Error("simulated crash after commit");
    return result;
  },
};

const mocks = [
  mock.module("../src/config.js", { exports: { config: {
    spaceStorageRoot: join(root, "storage"),
    spaceSystemRoot: join(root, "system"),
    checkpointCacheRoot: join(root, "cache"),
    checkpointCacheSubpath: "cache",
    checkpointAssetThresholdBytes: 1024,
    checkpointGitAuthorEmail: "worker@cohub.test",
    bullmqRedisUrl: "redis://unused",
  } } }),
  mock.module("../src/db.js", { exports: { db: fakeDb } }),
  mock.module("../src/redis.js", { exports: { redisCommandClient: {}, redisBestEffortCommandClient: {} } }),
  mock.module("../src/checkpoint/assets.js", { exports: {
    checkpointObjectStore: store,
    checkpointObjectExists: async (key: string) => stat(join(bucket, key)).then(() => true, () => false),
    putCheckpointJsonIfMissing: async (key: string, value: unknown) => {
      if (await stat(join(bucket, key)).then(() => true, () => false)) return false;
      await put(key, `${JSON.stringify(value)}\n`);
      return true;
    },
    uploadObjectFileIfMissing: async (input: { filePath: string; objectKey: string }) => {
      await put(input.objectKey, await readFile(input.filePath));
      return input.objectKey;
    },
    uploadAssetIfMissing: async (input: { filePath: string; sha256: string }) => {
      const key = `checkpoint-assets/sha256/${input.sha256}`;
      await put(key, await readFile(input.filePath));
      return key;
    },
    getCheckpointAssetClient: () => ({ send: async (command: { input: { Key: string } }) => ({ Body: (await import("node:fs")).createReadStream(join(bucket, command.input.Key)) }) }),
  } }),
  mock.module("../src/checkpoint/compact.js", { exports: { enqueueCheckpointCompaction: (data: { commit: string; seq: number }) => compactions.push(data) } }),
  mock.module("../src/checkpoint/board.js", { exports: { saveBoardCheckpointSnapshots: async () => ({ count: 0 }) } }),
  mock.module("../src/checkpoint/metadata.js", { exports: {
    updateCheckpointMeta: async () => undefined,
    findCheckpointForTaskRun: async (_db: unknown, sid: string, taskRunId: string) => {
      const row = state.checkpoints.get(taskRunId);
      return row?.spaceId === sid ? row : null;
    },
  } }),
  mock.module("../src/checkpoint/lock.js", { exports: { withSpaceSaveLock: async () => ({ acquired: false }) } }),
  mock.module("../src/reference-index-queue.js", { exports: { enqueueReferences: () => undefined } }),
  mock.module("../src/space-events.js", { exports: { publishSpaceEvent: async () => undefined } }),
  mock.module("../src/tasks/registry.js", { exports: { registerTask: () => undefined } }),
];

const { saveCheckpointForSpace } = await import("../src/tasks/save-checkpoint-task.js");
const { prepareCheckpointRepo, restoreWorkspaceFromCheckpoint } = await import("../src/checkpoint/restore.js");
const { compactCheckpointCovers } = await import(`../src/checkpoint/compact.js?real=${Date.now()}`);
const { loadFileIndex, promoteFileIndex, stageFileIndex } = await import("../src/checkpoint/file-index.js");
const { ensureCheckpointCommits } = await import("@cohub/core/checkpoint/storage");

after(async () => {
  for (const item of mocks) item.restore();
  await rm(root, { recursive: true, force: true });
});

const workspace = join(root, "storage", spaceId, "workspace");
const repoDir = join(root, "system", spaceId, "repo");
let hydrations = 0;
/** A fresh repository filled only from object storage: saves never write the cache repository. */
const fromStorage = async (commit: string) => {
  const dir = join(root, "hydrated", String(hydrations++));
  await prepareCheckpointRepo({ sourceSpaceId: "unused", targetRepoDir: dir, commitHash: commit });
  return dir;
};
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
const save = async (description: string) => saveCheckpointForSpace({ spaceId: state.currentSpace, description });
const manifestOf = async (commit: string) => JSON.parse(await readFile(join(bucket, "checkpoint-manifests", `${commit}.json`), "utf8"));
// Entries modified within the racy window are rehashed next time; let them age out of it.
const settle = () => new Promise((resolve) => setTimeout(resolve, 3_200));

state.spaces.set(spaceId, { id: spaceId, headCheckpointId: null, slug: null, userUuid: "user" });
state.spaces.set(forkSpaceId, { id: forkSpaceId, headCheckpointId: null, slug: null, userUuid: "user" });

test("saves are incremental packs whose manifests rebuild every checkpoint byte for byte", async () => {
  await mkdir(join(workspace, "src"), { recursive: true });
  await writeFile(join(workspace, "src/a.txt"), "alpha\r\n");
  await writeFile(join(workspace, "big.bin"), Buffer.alloc(4096, 7));
  await writeFile(join(workspace, ".gitattributes"), "*.txt text eol=lf\n/kept export-ignore\n");
  await mkdir(join(workspace, "kept"));
  await writeFile(join(workspace, "kept/file"), "kept");
  for (const name of ["cr\r", "space ", "back\\slash"]) await writeFile(join(workspace, name), name);
  await writeFile(join(workspace, "run.sh"), "#!/bin/sh\n", { mode: 0o755 });
  await symlink("src/a.txt", join(workspace, "link"));
  await mkdir(join(workspace, "src/sub"), { recursive: true });
  await mkdir(join(workspace, "d"), { recursive: true });
  await symlink("../a.txt", join(workspace, "src/sub/up"));
  await symlink("..", join(workspace, "d/up"));
  await symlink("d/up/..", join(workspace, "chain"));
  await symlink("../outside", join(workspace, "escape"));
  await writeFile(join(workspace, "weird\nname"), "x");
  await settle();

  const first = await save("first");
  assert.equal(first.stats.hashedFileCount, 12);
  const firstMeta = state.checkpoints.get(first.checkpointId)?.meta as { warnings?: Array<{ path: string; reason: string }> } | undefined;
  const skipped = firstMeta?.warnings ?? [];
  assert.deepEqual(skipped.filter((warning) => warning.reason === "unsafe_symlink_target").map((warning) => warning.path).sort(), ["chain", "escape"]);
  const firstManifest = await manifestOf(first.commitHash);
  assert.equal(firstManifest.seq, 0);
  const firstRepo = await fromStorage(first.commitHash);
  assert.equal(execFileSync("git", ["show", `${first.commitHash}:src/a.txt`], { cwd: firstRepo, encoding: "utf8" }), "alpha\r\n");
  assert.match(git(firstRepo, "show", `${first.commitHash}:big.bin`), /^version https:\/\/cohub.run\/spec\/asset-pointer\/v1/);
  assert.equal(git(firstRepo, "ls-tree", first.commitHash, "run.sh").split(" ")[0], "100755");
  assert.equal(git(firstRepo, "ls-tree", first.commitHash, "link").split(" ")[0], "120000");

  await writeFile(join(workspace, "src/b.txt"), "beta\n");
  await rm(join(workspace, "run.sh"));
  const second = await save("second");
  assert.equal(second.stats.hashedFileCount, 1);
  assert.equal(second.stats.addedFileCount, 1);
  assert.equal(second.stats.deletedFileCount, 1);
  const secondManifest = await manifestOf(second.commitHash);
  assert.equal(secondManifest.seq, 1);
  assert.equal(secondManifest.packs.length, 2);
  const secondRepo = await fromStorage(second.commitHash);
  assert.equal(git(secondRepo, "rev-parse", `${second.commitHash}^`), first.commitHash);
  git(secondRepo, "fsck", "--connectivity-only", "--no-dangling", second.commitHash);
  assert.equal(await stat(join(repoDir, ".git")).then(() => true, () => false), false, "saves must not touch the cache repository");

  const latest = join(root, "cache", spaceId, "latest");
  assert.equal(await readFile(join(latest, "src/b.txt"), "utf8"), "beta\n");
  assert.equal(await stat(join(latest, "run.sh")).then(() => true, () => false), false);

  // A fork reads only object storage: a fresh cache repository and no access to the source repo.
  await rm(repoDir, { recursive: true, force: true });
  state.lookup = second.checkpointId;
  const target = join(root, "fork-workspace");
  await mkdir(target, { recursive: true });
  await restoreWorkspaceFromCheckpoint({ checkpointId: second.checkpointId, targetWorkspaceDir: target, targetRepoDir: join(root, "system", forkSpaceId, "repo"), restoreTmpDir: join(root, "restore-tmp") });
  assert.equal(await readFile(join(target, "src/a.txt"), "utf8"), "alpha\r\n");
  assert.deepEqual(await readFile(join(target, "big.bin")), Buffer.alloc(4096, 7));
  assert.equal(await readFile(join(target, "weird\nname"), "utf8"), "x");
  assert.equal(await readFile(join(target, "kept/file"), "utf8"), "kept");
  for (const name of ["cr\r", "space ", "back\\slash"]) assert.equal(await readFile(join(target, name), "utf8"), name);
  assert.equal(await readlink(join(target, "src/sub/up")), "../a.txt");
  assert.equal(await readFile(join(target, "src/sub/up"), "utf8"), "alpha\r\n");
  assert.equal(await readlink(join(target, "d/up")), "..");
  assert.equal(await lstat(join(target, "chain")).then(() => true, () => false), false);
});

test("a save refuses to land when the head moved underneath it", async () => {
  state.headMoved = true;
  await writeFile(join(workspace, "src/c.txt"), "gamma\n");
  const head = state.spaces.get(spaceId)?.headCheckpointId;
  await assert.rejects(save("conflict"), /head moved/);
  assert.equal(state.spaces.get(spaceId)?.headCheckpointId, head);
  state.headMoved = false;
});

test("a task retried after its worker died finishes the committed checkpoint instead of saving again", async () => {
  const latest = join(root, "cache", spaceId, "latest");
  await writeFile(join(workspace, "src/resume.txt"), "resume\n");
  state.crashAfterCommit = true;
  await assert.rejects(saveCheckpointForSpace({ spaceId, description: "crash", sourceTaskRunId: "run-crash" }), /simulated crash/);
  state.crashAfterCommit = false;
  const rows = state.checkpoints.size;

  const resumed = await saveCheckpointForSpace({ spaceId, description: "crash", sourceTaskRunId: "run-crash" });
  assert.equal(resumed.resumed, true);
  assert.equal(state.checkpoints.size, rows);
  assert.equal(await readFile(join(latest, "src/resume.txt"), "utf8"), "resume\n");

  // The resumed run wrote no stat index; the next save reuses the ancestor's instead of hashing everything.
  await writeFile(join(workspace, "src/after.txt"), "after\n");
  const next = await save("after resume");
  assert.ok(next.stats.hashedFileCount <= 5, `hashed ${next.stats.hashedFileCount} of ${next.stats.fileCount}`);
  assert.ok(next.stats.fileCount > 10);
  assert.equal(await readFile(join(latest, "src/after.txt"), "utf8"), "after\n");
});

test("compaction covers fold into later manifests and keep the closure", async () => {
  let last = null as Awaited<ReturnType<typeof save>> | null;
  for (let index = 0; index < 17; index += 1) {
    await writeFile(join(workspace, `step-${index}.txt`), `${index}\n`);
    last = await save(`step ${index}`);
  }
  const at16 = compactions.find((entry) => entry.seq === 16);
  assert.ok(at16);
  // Hydrating a long manifest leaves a bounded number of packs in the cache.
  const listed = (await manifestOf(last?.commitHash as string)).packs.length;
  const hydrated = await fromStorage(last?.commitHash as string);
  const cachePacks = (await readdir(join(hydrated, ".git", "objects", "pack"))).filter((name) => name.endsWith(".pack")).length;
  assert.ok(listed > 16 && cachePacks <= 16, `${listed} packs listed, ${cachePacks} in the cache`);
  git(hydrated, "fsck", "--connectivity-only", "--no-dangling", last?.commitHash as string);
  await writeFile(join(workspace, "one-more.txt"), "1\n");
  const next = await save("one more");
  const { installed } = await ensureCheckpointCommits(store, hydrated, [next.commitHash]);
  assert.equal(installed, 1, "packs merged by a cache repack were downloaded again");
  {
    const built = await compactCheckpointCovers({ spaceId, ...at16 });
    assert.deepEqual(built.built, [1]);
    await writeFile(join(workspace, "after-cover.txt"), "z\n");
    const folded = await save("after cover");
    const manifest = await manifestOf(folded.commitHash);
    assert.ok(manifest.packs.some((pack: { first: number; last: number }) => pack.first === 1 && pack.last === 16));
    assert.equal(manifest.packs.length, 1 + 1 + (manifest.seq - 16));
    const fresh = join(root, "fresh-repo");
    await prepareCheckpointRepo({ sourceSpaceId: spaceId, targetRepoDir: fresh, commitHash: folded.commitHash });
    git(fresh, "fsck", "--connectivity-only", folded.commitHash);
  }
  assert.ok(last);
  assert.equal(await stat(join(repoDir, ".git")).then(() => true, () => false), false, "compaction must not fill the cache repository");
});

test("nested git repositories are stored as an incremental bundle chain", async () => {
  const nested = join(workspace, "nested");
  await mkdir(nested, { recursive: true });
  git(nested, "init", "-q", "-b", "main");
  git(nested, "-c", "user.email=a@b", "-c", "user.name=a", "commit", "-q", "--allow-empty", "-m", "one");
  await save("nested one");
  git(nested, "-c", "user.email=a@b", "-c", "user.name=a", "commit", "-q", "--allow-empty", "-m", "two");
  const second = await save("nested two");
  assert.equal(second.stats.bundledGitRepoCount, 1);
  const repos = JSON.parse(git(await fromStorage(second.commitHash), "show", `${second.commitHash}:.cohub/system/user-git-repos.v2.json`));
  assert.deepEqual(repos.repos[0].bundles.map((bundle: { level: number; base: string[] }) => [bundle.level, bundle.base.length]), [[4, 0], [0, 1]]);
  state.lookup = second.checkpointId;
  const target = join(root, "nested-restore");
  await mkdir(target, { recursive: true });
  await restoreWorkspaceFromCheckpoint({ checkpointId: second.checkpointId, targetWorkspaceDir: target, targetRepoDir: join(root, "system", "nested-restore", "repo"), restoreTmpDir: join(root, "nested-tmp") });
  assert.equal(git(join(target, "nested"), "log", "--format=%s", "main"), "two\none");
});

test("the first save after a pre-v3 parent uploads a baseline holding its history, with the parent diff", async () => {
  const legacySpace = "33333333-3333-4333-8333-333333333333";
  const legacyRepo = join(root, "system", legacySpace, "repo");
  await mkdir(join(legacyRepo, "docs"), { recursive: true });
  await writeFile(join(legacyRepo, "docs/old.md"), "old\n");
  git(legacyRepo, "init", "-q", "-b", "main");
  git(legacyRepo, "add", "-A");
  git(legacyRepo, "-c", "user.email=a@b", "-c", "user.name=a", "commit", "-q", "-m", "legacy");
  const legacyCommit = git(legacyRepo, "rev-parse", "HEAD");
  state.checkpoints.set("legacy", { id: "legacy", spaceId: legacySpace, commitHash: legacyCommit, rootCheckpointId: "legacy" });
  state.spaces.set(legacySpace, { id: legacySpace, headCheckpointId: "legacy", slug: null, userUuid: "user" });
  state.currentSpace = legacySpace;
  await mkdir(join(root, "storage", legacySpace, "workspace"), { recursive: true });
  await writeFile(join(root, "storage", legacySpace, "workspace", "new.md"), "new\n");

  const saved = await save("after upgrade");
  const manifest = await manifestOf(saved.commitHash);
  assert.equal(manifest.seq, 0);
  assert.equal(manifest.parent, legacyCommit);
  const fresh = await fromStorage(saved.commitHash);
  assert.equal(git(fresh, "show", `${saved.commitHash}:new.md`), "new");
  assert.equal(git(fresh, "show", `${saved.commitHash}^:docs/old.md`), "old");
  const meta = state.checkpoints.get(saved.checkpointId)?.meta as { stats: Record<string, number> };
  assert.equal(meta.stats.addedFileCount, 1);
  assert.equal(meta.stats.deletedFileCount, 1);
  state.currentSpace = spaceId;
});

test("restore refuses a symlink chain that escapes the workspace, whatever order the links come in", async () => {
  const craftedSpace = "44444444-4444-4444-8444-444444444444";
  const craftedRepo = join(root, "system", craftedSpace, "repo");
  await mkdir(join(craftedRepo, "d"), { recursive: true });
  await writeFile(join(craftedRepo, "kept.txt"), "kept");
  await symlink("..", join(craftedRepo, "d/up"));
  await symlink("d/up/..", join(craftedRepo, "chain"));
  git(craftedRepo, "init", "-q", "-b", "main");
  git(craftedRepo, "add", "-A");
  git(craftedRepo, "-c", "user.email=a@b", "-c", "user.name=a", "commit", "-q", "-m", "crafted");
  state.checkpoints.set("crafted", { id: "crafted", spaceId: craftedSpace, commitHash: git(craftedRepo, "rev-parse", "HEAD") });
  state.spaces.set(craftedSpace, { id: craftedSpace, headCheckpointId: "crafted", slug: null, userUuid: "user" });
  state.lookup = "crafted";
  const target = join(root, "crafted-restore");
  await mkdir(target, { recursive: true });
  await assert.rejects(
    restoreWorkspaceFromCheckpoint({ checkpointId: "crafted", targetWorkspaceDir: target, targetRepoDir: join(root, "system", "crafted-restore", "repo"), restoreTmpDir: join(root, "crafted-tmp") }),
    /escape the workspace while restoring: chain/,
  );
  assert.equal(await lstat(join(target, "chain")).then(() => true, () => false), false);
});

test("trees rebuilt from the index match the workspace, and the diff matches git, across random edits", async () => {
  const randomSpace = "55555555-5555-4555-8555-555555555555";
  const ws = join(root, "storage", randomSpace, "workspace");
  state.spaces.set(randomSpace, { id: randomSpace, headCheckpointId: null, slug: null, userUuid: "user" });
  state.currentSpace = randomSpace;
  state.lookup = "";
  let seed = 7;
  const rand = (n: number) => {
    seed = (seed * 1103515245 + 12345) % 2 ** 31;
    return seed % n;
  };
  const dirs = ["", "a", "a/b", "a/b/c", "d", "d/e"];
  const pathOf = () => `${dirs[rand(dirs.length)]}/f${rand(12)}`.replace(/^\//, "");
  let parent: string | null = null;
  for (let round = 0; round < 14; round += 1) {
    for (let op = 0; op < 6; op += 1) {
      const path = join(ws, pathOf());
      if (rand(4) === 0) await rm(path, { force: true, recursive: true });
      else await mkdir(dirname(path), { recursive: true }).then(() => writeFile(path, `${round}-${op}-${rand(1000)}\n`), () => undefined);
    }
    if (round === 7) await rm(join(ws, "a/b"), { recursive: true, force: true });
    if (round === 9) {
      await rm(join(ws, "d/e"), { recursive: true, force: true });
      await mkdir(join(ws, "d"), { recursive: true });
      await writeFile(join(ws, "d/e"), "now a file\n");
    }
    if (round === 11) {
      await rm(join(ws, "d/e"), { recursive: true, force: true });
      await mkdir(join(ws, "d/e/g"), { recursive: true });
      await writeFile(join(ws, "d/e/g/h"), "a directory again\n");
    }
    const saved = await save(`random ${round}`);
    const repo = await fromStorage(saved.commitHash);
    const stored = git(repo, "ls-tree", "-r", saved.commitHash).split("\n").filter((line) => !line.endsWith(".json") || !line.includes(".cohub/system/")).sort();
    const walk = async (dir: string): Promise<string[]> => (await Promise.all((await readdir(join(ws, dir), { withFileTypes: true })).map((entry) => {
      const rel = dir ? `${dir}/${entry.name}` : entry.name;
      return entry.isDirectory() ? walk(rel) : [rel];
    }))).flat();
    const listing = await walk("");
    const expected = listing.map((path) => `100644 blob ${execFileSync("git", ["hash-object", "--no-filters", join(ws, path)], { encoding: "utf8" }).trim()}\t${path}`).sort();
    assert.deepEqual(stored, expected, `round ${round}`);
    const meta = state.checkpoints.get(saved.checkpointId)?.meta as { diffs?: { parent?: { summary?: { files: Array<{ status: string; path: string }> } } } } | undefined;
    if (parent) {
      const gitDiff = git(repo, "diff-tree", "-r", "--no-renames", "--name-status", parent, saved.commitHash).split("\n").filter((line) => line && !line.includes(".cohub/system/")).sort();
      const ours = (meta?.diffs?.parent?.summary?.files ?? []).map((file) => `${file.status}\t${file.path}`).sort();
      assert.deepEqual(ours, gitDiff, `diff round ${round}`);
    }
    parent = saved.commitHash;
  }
  state.currentSpace = spaceId;
});

test("saves without a usable index or latest still precompute the parent diff git computes", async () => {
  const diffOf = (id: string) => ((state.checkpoints.get(id)?.meta as { diffs?: { parent?: { summary?: { files: Array<{ status: string; path: string }> } } } } | undefined)?.diffs?.parent?.summary?.files ?? [])
    .map((file) => `${file.status}\t${file.path}`).sort();
  const gitDiff = async (parent: string, commit: string) => {
    const fields = execFileSync("git", ["diff-tree", "-r", "-z", "--no-renames", "--name-status", parent, commit], { cwd: await fromStorage(commit), encoding: "utf8" }).split("\0");
    const lines: string[] = [];
    for (let index = 0; index + 1 < fields.length; index += 2) if (!fields[index + 1]?.startsWith(".cohub/system/")) lines.push(`${fields[index]}\t${fields[index + 1]}`);
    return lines.sort();
  };

  // A fork's first save: the fork has no stat index.
  const forkSpace = "66666666-6666-4666-8666-666666666666";
  const forkWs = join(root, "storage", forkSpace, "workspace");
  const source = [...state.checkpoints.values()].find((row) => row.spaceId === spaceId) as Row;
  state.checkpoints.set("fork-alias", { ...source, id: "fork-alias", spaceId: forkSpace });
  state.spaces.set(forkSpace, { id: forkSpace, headCheckpointId: "fork-alias", slug: null, userUuid: "user" });
  state.currentSpace = forkSpace;
  state.lookup = "";
  await mkdir(forkWs, { recursive: true });
  await writeFile(join(forkWs, "only.txt"), "fork\n");
  const forked = await save("fork first");
  assert.ok(diffOf(forked.checkpointId).length > 1);
  assert.deepEqual(diffOf(forked.checkpointId), await gitDiff(source.commitHash, forked.commitHash));

  // A stale latest that still names an older commit: it catches up through diff-tree, not a rebuild.
  const forkLatest = join(root, "cache", forkSpace, "latest");
  const metaPath = join(forkLatest, ".cohub/system/checkpoint-meta.v1.json");
  const staleMeta = await readFile(metaPath, "utf8");
  await writeFile(join(forkWs, "only.txt"), "fork 2\n");
  await save("advance");
  await writeFile(metaPath, staleMeta);
  await writeFile(join(forkLatest, "marker-not-in-workspace"), "untouched by an incremental update\n");
  await writeFile(join(forkWs, "second.txt"), "two\n");
  const stale = await save("stale latest");
  assert.deepEqual(diffOf(stale.checkpointId), ["A\tsecond.txt"]);
  assert.equal(await readFile(join(forkLatest, "only.txt"), "utf8"), "fork 2\n");
  assert.equal(await readFile(join(forkLatest, "second.txt"), "utf8"), "two\n");
  assert.equal(await readFile(join(forkLatest, "marker-not-in-workspace"), "utf8"), "untouched by an incremental update\n");
  state.currentSpace = spaceId;
});

test("compaction refuses a range that references an object stored nowhere", async () => {
  const badSpace = "77777777-7777-4777-8777-777777777777";
  const badWs = join(root, "storage", badSpace, "workspace");
  const systemDir = join(root, "system", badSpace);
  state.spaces.set(badSpace, { id: badSpace, headCheckpointId: null, slug: null, userUuid: "user" });
  state.currentSpace = badSpace;
  state.lookup = "";
  await mkdir(badWs, { recursive: true });
  await writeFile(join(badWs, "victim.txt"), "real\n");
  await settle();
  const first = await save("seed");
  // Simulate a stat index that names a blob no save ever stored; the next saves reuse it without reading the file.
  const index = await loadFileIndex(systemDir);
  assert.ok(index);
  const victim = index.entries.get("victim.txt");
  assert.ok(victim);
  index.entries.set("victim.txt", { ...victim, oid: "1".repeat(40) });
  await stageFileIndex(systemDir, index);
  await promoteFileIndex(systemDir, first.commitHash);
  const before = compactions.length;
  for (let step = 1; step <= 16; step += 1) {
    await writeFile(join(badWs, `step-${step}.txt`), `${step}\n`);
    await save(`bad ${step}`);
  }
  const at16 = compactions.slice(before).find((entry) => entry.seq === 16);
  assert.ok(at16);
  await assert.rejects(compactCheckpointCovers({ spaceId: badSpace, ...at16 }), /references 1 objects stored nowhere: 1{40}/);
  assert.equal(await stat(join(bucket, "checkpoint-covers", at16.commit, "L1.json")).then(() => true, () => false), false);
  state.currentSpace = spaceId;
});

test("diffs over 500 changes keep rename detection and full stats", async () => {
  const bigSpace = "88888888-8888-4888-8888-888888888888";
  const bigWs = join(root, "storage", bigSpace, "workspace");
  state.spaces.set(bigSpace, { id: bigSpace, headCheckpointId: null, slug: null, userUuid: "user" });
  state.currentSpace = bigSpace;
  state.lookup = "";
  await mkdir(join(bigWs, "old"), { recursive: true });
  for (let index = 0; index < 300; index += 1) await writeFile(join(bigWs, "old", `f${index}.txt`), `file ${index}\n${"x".repeat(200)}\n`);
  await settle();
  await save("seed");
  await rename(join(bigWs, "old"), join(bigWs, "moved"));
  await mkdir(join(bigWs, "fresh"), { recursive: true });
  for (let index = 0; index < 300; index += 1) await writeFile(join(bigWs, "fresh", `n${index}.txt`), `new ${index}\n`);
  const saved = await save("move and add");
  const meta = state.checkpoints.get(saved.checkpointId)?.meta as { stats: Record<string, number>; diffs: { parent: { summary?: { truncated: boolean; files: unknown[] }; truncated?: boolean } } };
  assert.equal(meta.stats.renamedFileCount, 300);
  assert.equal(meta.stats.addedFileCount, 300);
  assert.equal(meta.stats.changedFileCount, 600);
  assert.equal(meta.diffs.parent.summary?.truncated ?? meta.diffs.parent.truncated, true);
  state.currentSpace = spaceId;
});

test("a crash before latest refreshes keeps both indexes, so the retry updates latest incrementally", async () => {
  const crashSpace = "99999999-9999-4999-8999-999999999990";
  const ws = join(root, "storage", crashSpace, "workspace");
  const latest = join(root, "cache", crashSpace, "latest");
  state.spaces.set(crashSpace, { id: crashSpace, headCheckpointId: null, slug: null, userUuid: "user" });
  state.currentSpace = crashSpace;
  state.lookup = "";
  await mkdir(ws, { recursive: true });
  await writeFile(join(ws, "kept.txt"), "v1\n");
  await settle();
  await save("seed");
  await writeFile(join(ws, "kept.txt"), "v2\n");
  await settle();
  const crash = (progress: Record<string, unknown>) => {
    if (progress.stage === "materialize_latest") throw new Error("simulated crash before latest");
  };
  await assert.rejects(saveCheckpointForSpace({ spaceId: crashSpace, description: "crash", sourceTaskRunId: "run-latest", onProgress: crash }), /simulated crash/);
  await writeFile(join(ws, "after-commit.txt"), "not in the checkpoint\n");
  const resumed = await saveCheckpointForSpace({ spaceId: crashSpace, description: "crash", sourceTaskRunId: "run-latest" });
  assert.equal(resumed.resumed, true);
  assert.equal(await readFile(join(latest, "kept.txt"), "utf8"), "v2\n");
  assert.equal(await stat(join(latest, "after-commit.txt")).then(() => true, () => false), false);
  const next = await save("next");
  assert.equal(next.stats.hashedFileCount, 1);
  state.currentSpace = spaceId;
});
