import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, test } from "node:test";
import {
  canonicalRuntimeRoot,
  findContainingRuntimeSpaceBinding,
  findNearestRuntimeSpaceBinding,
  findRuntimeSpaceBinding,
  parseRuntimeSpaceBindings,
  resolveRuntimeSpace,
  withRuntimeSpaceBindingsLock,
} from "../src/runtime/space-binding.js";

const roots: string[] = [];

async function tempRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

test("canonical Runtime roots collapse symlink aliases", async () => {
  const root = await tempRoot("cohub-runtime-root-");
  const alias = `${root}-alias`;
  roots.push(alias);
  await symlink(root, alias);

  assert.equal(await canonicalRuntimeRoot(alias), await realpath(root));
});

test("Runtime Space bindings are scoped by identity and root", () => {
  const bindings = parseRuntimeSpaceBindings(JSON.stringify({
    version: 1,
    bindings: [
      { root: "/work/app", key: "prod:alice", spaceId: "space-a" },
      { root: "/work/app", key: "dev:alice", spaceId: "space-b" },
    ],
  }));

  assert.equal(findRuntimeSpaceBinding(bindings, { root: "/work/app", key: "prod:alice" })?.spaceId, "space-a");
  assert.equal(findRuntimeSpaceBinding(bindings, { root: "/work/app", key: "dev:alice" })?.spaceId, "space-b");
  assert.equal(findRuntimeSpaceBinding(bindings, { root: "/work/other", key: "prod:alice" }), null);
});

test("the first local Runtime resolution creates once and later reuses the binding", async () => {
  const root = await tempRoot("cohub-runtime-binding-");
  const path = join(root, "config", "runtime-spaces.json");
  let createCount = 0;
  const input = {
    root,
    identityKey: "prod:alice",
    path,
    createSpace: async () => {
      createCount += 1;
      return "space-a";
    },
  };

  assert.deepEqual(await resolveRuntimeSpace(input), { spaceId: "space-a", source: "created" });
  assert.deepEqual(await resolveRuntimeSpace({ ...input, createSpace: async () => { throw new Error("must not create"); } }), { spaceId: "space-a", source: "binding" });
  assert.equal(createCount, 1);
  assert.match(await readFile(path, "utf8"), /"spaceId": "space-a"/);
});

test("concurrent first starts share one Space creation", async () => {
  const root = await tempRoot("cohub-runtime-concurrent-");
  const path = join(root, "config", "runtime-spaces.json");
  let createCount = 0;
  const createSpace = async () => {
    createCount += 1;
    await delay(25);
    return "space-a";
  };
  const input = { root, identityKey: "prod:alice", path, createSpace };

  const results = await Promise.all([resolveRuntimeSpace(input), resolveRuntimeSpace(input)]);
  assert.deepEqual(results.map((result) => result.spaceId), ["space-a", "space-a"]);
  assert.deepEqual(new Set(results.map((result) => result.source)), new Set(["created", "binding"]));
  assert.equal(createCount, 1);
});

test("different bindings do not wait on each other's remote creation", async () => {
  const parent = await tempRoot("cohub-runtime-independent-");
  const firstRoot = join(parent, "first");
  const secondRoot = join(parent, "second");
  await mkdir(firstRoot, { recursive: true });
  await mkdir(secondRoot, { recursive: true });
  const path = join(parent, "runtime-spaces.json");
  let started!: () => void;
  let release!: () => void;
  const firstStarted = new Promise<void>((resolve) => { started = resolve; });
  const firstRelease = new Promise<void>((resolve) => { release = resolve; });
  const first = resolveRuntimeSpace({
    root: firstRoot,
    identityKey: "prod:alice",
    path,
    createSpace: async () => {
      started();
      await firstRelease;
      return "space-first";
    },
  });

  await firstStarted;
  try {
    const second = await Promise.race([
      resolveRuntimeSpace({ root: secondRoot, identityKey: "prod:alice", path, createSpace: async () => "space-second" }),
      delay(500).then(() => { throw new Error("independent binding waited on remote creation"); }),
    ]);
    assert.deepEqual(second, { spaceId: "space-second", source: "created" });
  } finally {
    release();
  }
  assert.deepEqual(await first, { spaceId: "space-first", source: "created" });
});

test("an explicit Space overrides and updates the current binding", async () => {
  const root = await tempRoot("cohub-runtime-explicit-");
  const path = join(root, "config", "runtime-spaces.json");
  const input = { root, identityKey: "prod:alice", path, createSpace: async () => "unused" };

  assert.deepEqual(await resolveRuntimeSpace({ ...input, explicitSpaceId: "space-a" }), { spaceId: "space-a", source: "explicit" });
  assert.deepEqual(await resolveRuntimeSpace(input), { spaceId: "space-a", source: "binding" });
  assert.deepEqual(await resolveRuntimeSpace({ ...input, explicitSpaceId: "space-b" }), { spaceId: "space-b", source: "explicit" });
  assert.deepEqual(await resolveRuntimeSpace(input), { spaceId: "space-b", source: "binding" });
});

test("stale Runtime Space locks can be reclaimed", async () => {
  const root = await tempRoot("cohub-runtime-stale-lock-");
  const path = join(root, "runtime-spaces.json");
  const lockPath = join(root, "runtime-spaces.lock");
  await mkdir(lockPath, { recursive: true });
  const ownerPath = join(lockPath, "old-owner");
  await writeFile(ownerPath, "");
  await utimes(ownerPath, new Date(0), new Date(0));

  let called = false;
  await withRuntimeSpaceBindingsLock(async () => { called = true; }, { path, lockPath });
  assert.equal(called, true);
});

test("an old lock owner cannot remove a replacement lock", async () => {
  const root = await tempRoot("cohub-runtime-lock-");
  const path = join(root, "runtime-spaces.json");
  const lockPath = join(root, "runtime-spaces.lock");
  let entered!: () => void;
  const acquired = new Promise<void>((resolve) => { entered = resolve; });
  const running = withRuntimeSpaceBindingsLock(async () => {
    entered();
    await delay(25);
  }, { path, lockPath });

  await acquired;
  await rm(lockPath, { recursive: true, force: true });
  await mkdir(lockPath, { recursive: true });
  await writeFile(join(lockPath, "replacement-owner"), "");
  await running;
  assert.deepEqual(await readdir(lockPath), ["replacement-owner"]);
});

test("explicit Space bindings are written only after validation", async () => {
  const root = await tempRoot("cohub-runtime-validation-");
  const path = join(root, "config", "runtime-spaces.json");

  await assert.rejects(
    () => resolveRuntimeSpace({
      root,
      identityKey: "prod:alice",
      path,
      explicitSpaceId: "space-invalid",
      createSpace: async () => "unused",
      validateSpace: async () => { throw new Error("Space is not a local Runtime"); },
    }),
    /not a local Runtime/,
  );
  await assert.rejects(() => readFile(path, "utf8"), { code: "ENOENT" });
});

test("a corrupt binding file fails closed instead of creating another Space", async () => {
  const root = await tempRoot("cohub-runtime-corrupt-");
  const path = join(root, "config", "runtime-spaces.json");
  await mkdir(join(root, "config"), { recursive: true });
  await writeFile(path, "not-json\n");
  let created = false;

  await assert.rejects(
    () => resolveRuntimeSpace({
      root,
      identityKey: "prod:alice",
      path,
      createSpace: async () => {
        created = true;
        return "space-a";
      },
    }),
    /Runtime Space bindings are invalid/,
  );
  assert.equal(created, false);
});

test("containing binding walks ancestor directories, prefers deepest nested binding, and ignores sibling prefixes", () => {
  const bindings = parseRuntimeSpaceBindings(JSON.stringify({
    version: 1,
    bindings: [
      { root: "/work/app", key: "prod:alice", spaceId: "space-root" },
      { root: "/work/app/packages/web", key: "prod:alice", spaceId: "space-web" },
      { root: "/work/app", key: "dev:alice", spaceId: "space-dev" },
    ],
  }));

  assert.equal(findContainingRuntimeSpaceBinding(bindings, { cwd: "/work/app", key: "prod:alice" })?.spaceId, "space-root");
  assert.equal(findContainingRuntimeSpaceBinding(bindings, { cwd: "/work/app/packages/cli/src", key: "prod:alice" })?.spaceId, "space-root");
  assert.equal(findContainingRuntimeSpaceBinding(bindings, { cwd: "/work/app/packages/web/src/routes", key: "prod:alice" })?.spaceId, "space-web");
  assert.equal(findContainingRuntimeSpaceBinding(bindings, { cwd: "/work/app/packages/web/src", key: "dev:alice" })?.spaceId, "space-dev");
  assert.equal(findContainingRuntimeSpaceBinding(bindings, { cwd: "/work/app-2/src", key: "prod:alice" }), null);
  assert.equal(findContainingRuntimeSpaceBinding(bindings, { cwd: "/work/app/packages/web", key: "prod:bob" }), null);
});

test("findNearestRuntimeSpaceBinding resolves subdirectories and symlinked paths against canonical bound roots", async () => {
  const base = await tempRoot("cohub-runtime-ancestor-");
  const repo = join(base, "repo");
  const nested = join(repo, "packages", "cli", "src");
  const alias = join(base, "repo-link");
  const bindingsPath = join(base, "runtime-spaces.json");
  await mkdir(nested, { recursive: true });
  await symlink(repo, alias);

  await resolveRuntimeSpace({
    root: repo,
    identityKey: "prod:alice",
    path: bindingsPath,
    explicitSpaceId: "space-repo",
  });

  const fromSubdir = await findNearestRuntimeSpaceBinding(nested, "prod:alice", bindingsPath);
  const fromSymlinkSubdir = await findNearestRuntimeSpaceBinding(join(alias, "packages", "cli"), "prod:alice", bindingsPath);
  const fromOutside = await findNearestRuntimeSpaceBinding(base, "prod:alice", bindingsPath);

  assert.equal(fromSubdir?.spaceId, "space-repo");
  assert.equal(fromSubdir?.root, await realpath(repo));
  assert.equal(fromSymlinkSubdir?.spaceId, "space-repo");
  assert.equal(fromOutside, null);
});
