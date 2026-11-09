import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cp, lstat, mkdir, mkdtemp, readFile, readdir, readlink, rm, stat, symlink, utimes, writeFile } from "node:fs/promises";
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

after(async () => {
  for (const item of mocks) item.restore();
  await rm(root, { recursive: true, force: true });
});

const workspace = join(root, "storage", spaceId, "workspace");
const repoDir = join(root, "system", spaceId, "repo");
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
  assert.equal(execFileSync("git", ["show", `${first.commitHash}:src/a.txt`], { cwd: repoDir, encoding: "utf8" }), "alpha\r\n");
  assert.match(git(repoDir, "show", `${first.commitHash}:big.bin`), /^version https:\/\/cohub.run\/spec\/asset-pointer\/v1/);
  assert.equal(git(repoDir, "ls-tree", first.commitHash, "run.sh").split(" ")[0], "100755");
  assert.equal(git(repoDir, "ls-tree", first.commitHash, "link").split(" ")[0], "120000");

  await writeFile(join(workspace, "src/b.txt"), "beta\n");
  await rm(join(workspace, "run.sh"));
  const second = await save("second");
  assert.equal(second.stats.hashedFileCount, 1);
  assert.equal(second.stats.addedFileCount, 1);
  assert.equal(second.stats.deletedFileCount, 1);
  const secondManifest = await manifestOf(second.commitHash);
  assert.equal(secondManifest.seq, 1);
  assert.equal(secondManifest.packs.length, 2);
  assert.equal(git(repoDir, "rev-parse", `${second.commitHash}^`), first.commitHash);
  assert.deepEqual(await readdir(repoDir), [".git"]);

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
  // A download killed mid-install (old naming) must not stall cache repacks; a live temp pair must survive them.
  const packDir = join(repoDir, ".git", "objects", "pack");
  const anyPack = (await readdir(packDir)).find((name) => name.endsWith(".pack")) as string;
  await cp(join(packDir, anyPack), join(packDir, "tmp_cohub_dead.pack"));
  await writeFile(join(packDir, "tmp_cohub_dead.idx"), "truncated");
  const stale = new Date(Date.now() - 2 * 60 * 60 * 1000);
  await Promise.all(["tmp_cohub_dead.pack", "tmp_cohub_dead.idx"].map((name) => utimes(join(packDir, name), stale, stale)));
  await writeFile(join(packDir, "tmp_cohub_live_pack"), "in flight");
  let last = null as Awaited<ReturnType<typeof save>> | null;
  for (let index = 0; index < 17; index += 1) {
    await writeFile(join(workspace, `step-${index}.txt`), `${index}\n`);
    last = await save(`step ${index}`);
  }
  const names = await readdir(packDir);
  const packs = names.filter((name) => name.endsWith(".pack")).length;
  assert.ok(packs <= 17, `cache holds ${packs} packs`);
  git(repoDir, "fsck", "--connectivity-only", "--no-dangling", "main");
  assert.deepEqual(names.filter((name) => name.startsWith("tmp_cohub_")), ["tmp_cohub_live_pack"]);
  const at16 = compactions.find((entry) => entry.seq === 16);
  assert.ok(at16);
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
  const repos = JSON.parse(git(join(root, "system", spaceId, "repo"), "show", `${second.commitHash}:.cohub/system/user-git-repos.v2.json`));
  assert.deepEqual(repos.repos[0].bundles.map((bundle: { level: number; base: string[] }) => [bundle.level, bundle.base.length]), [[4, 0], [0, 1]]);
  state.lookup = second.checkpointId;
  const target = join(root, "nested-restore");
  await mkdir(target, { recursive: true });
  await restoreWorkspaceFromCheckpoint({ checkpointId: second.checkpointId, targetWorkspaceDir: target, targetRepoDir: join(root, "system", "nested-restore", "repo"), restoreTmpDir: join(root, "nested-tmp") });
  assert.equal(git(join(target, "nested"), "log", "--format=%s", "main"), "two\none");
});

test("the first save on a pre-v3 repository uploads a baseline holding its history", async () => {
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
  assert.deepEqual(await readdir(legacyRepo), [".git"]);
  const fresh = join(root, "legacy-fresh");
  await prepareCheckpointRepo({ sourceSpaceId: legacySpace, targetRepoDir: fresh, commitHash: saved.commitHash });
  assert.equal(git(fresh, "show", `${saved.commitHash}^:docs/old.md`), "old");
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
