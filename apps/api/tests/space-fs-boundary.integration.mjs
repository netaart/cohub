import assert from "node:assert/strict";
import { after, mock, test } from "node:test";
import { mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, symlink, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { trace } from "@opentelemetry/api";
import { createPreviewRouter } from "../src/routes/preview-router.js";

const storage = await realpath(await mkdtemp(join(tmpdir(), "cohub-shared-fs-api-")));
after(() => rm(storage, { recursive: true, force: true }));
mock.module("../src/config.js", { exports: { config: { spaceStorageRoot: storage } } });
mock.module("@cohub/infra/logging", { exports: {
  createLogger: () => ({ isInfoEnabled: () => false, debug() {}, info() {}, warn() {}, error() {} }),
} });
mock.module("@cohub/infra/tracing/propagator", { exports: { getTracer: () => trace.getTracer("fs-test") } });
// Only external CDN/Redis behavior is faked. All filesystem operations are real,
// isolated under storage, and executed with the repository's no-network guard.
mock.module("../src/space-fs-cdn-cache.js", { exports: {
  shouldUseFsCdnForMeta: (meta) => meta.path.endsWith(".png"),
  buildPreparingFile: (meta) => ({ path: meta.path, status: "preparing" }),
  buildUrlFileResponse: (meta, manifest) => ({ path: meta.path, delivery: "url", url: manifest.url }),
  ensureFsCdnManifest: async (meta) => {
    if (meta.path === "cdn-error.png") throw new Error("manifest unavailable");
    return null;
  },
  enqueueFsCdnWarmForMeta: async (meta) => {
    if (meta.path === "queue-error.png") throw new Error("queue unavailable");
  },
  getFreshFsCdnManifests: async (metas) => new Map(metas
    .filter((meta) => meta.path === "cached.png")
    .map((meta) => [meta.path, { url: "https://cdn.invalid/cached.png" }])),
  waitForFsCdnManifests: async (metas) => ({ ready: new Map(), pending: metas }),
} });
const fs = await import("../src/space-fs.js");

async function spaces() {
  const spaceId = crypto.randomUUID();
  const victimId = crypto.randomUUID();
  const root = join(storage, spaceId, "workspace");
  const victim = join(storage, victimId, "workspace");
  await Promise.all([mkdir(root, { recursive: true }), mkdir(victim, { recursive: true })]);
  await writeFile(join(root, "own.txt"), "owned-content");
  await writeFile(join(victim, "secret.txt"), "other-tenant-secret");
  await symlink(victim, join(root, "escape"));
  return { spaceId, root, victim };
}

const rejected = (error) => [400, 404].includes(fs.spaceFsJsonError(error).status);

test("shared API file, tree, batch and stream paths reject intermediate symlinks", async () => {
  const { spaceId } = await spaces();
  for (const action of [
    () => fs.readSpaceFile(spaceId, "escape/secret.txt"),
    () => fs.listSpaceDirectory(spaceId, "escape"),
    () => fs.streamSpaceFile(spaceId, "escape/secret.txt"),
  ]) await assert.rejects(action(), rejected);
  const batch = await fs.readSpaceFiles(spaceId, ["own.txt", "escape/secret.txt"]);
  assert.equal(batch.files.length, 1);
  assert.equal(batch.files[0].content, "owned-content");
  assert.equal(batch.errors[0].code, "path_invalid");
  assert.equal(batch.errors[0].status, 400);
  assert((await fs.listSpaceDirectory(spaceId)).entries.some((entry) => entry.name === "escape" && entry.type === "symlink"));
});

test("shared API writes, uploads, mkdir, move and deletion cannot touch another space", async () => {
  const { spaceId, victim } = await spaces();
  const content = { path: "escape/secret.txt", content: "bad", encoding: "utf8" };
  for (const action of [
    () => fs.writeSpaceFile(spaceId, content),
    () => fs.createSpaceFileExclusive(spaceId, { ...content, path: "escape/new.txt" }),
    () => fs.createSpaceDirectory(spaceId, "escape/new"),
    () => fs.moveSpaceNode(spaceId, { fromPath: "own.txt", toPath: "escape/new.txt" }),
    () => fs.deleteSpaceNode(spaceId, "escape/secret.txt", true),
    () => fs.statSpaceFileVersion(spaceId, "escape/secret.txt"),
  ]) await assert.rejects(action(), rejected);
  const result = await fs.uploadSpaceFiles(spaceId, [new File(["bad"], "secret.txt")], "escape");
  assert.equal(result.uploaded.length, 0);
  assert.equal(result.errors.length, 1);
  assert.equal(await readFile(join(victim, "secret.txt"), "utf8"), "other-tenant-secret");
  assert.deepEqual(await readdir(victim), ["secret.txt"]);
});

test("normal read, upload, nested directories and version conflict still work", async () => {
  const { spaceId, root } = await spaces();
  const first = await fs.readSpaceFile(spaceId, "own.txt");
  assert.equal(first.content, "owned-content");
  const upload = await fs.uploadSpaceFiles(spaceId, [new File(["new"], "new.txt")], "a/b");
  assert.deepEqual(upload.createdDirs, ["a", "a/b"]);
  assert.equal(upload.uploaded[0].path, "a/b/new.txt");
  await assert.rejects(fs.writeSpaceFile(spaceId, {
    path: "own.txt", content: "bad", expected: { size: 99999, mtimeMs: 0 },
  }), (error) => error.code === "file_conflict");
  assert.equal(await readFile(join(root, "own.txt"), "utf8"), "owned-content");
  assert.deepEqual(await fs.statSpaceFileVersion(spaceId, "does/not/exist"), { exists: false });
});

test("filtered reads do not follow .gitignore symlinks even after a filter is cached", async () => {
  const { spaceId, root, victim } = await spaces();
  await writeFile(join(root, ".gitignore"), "hidden.txt\n");
  await writeFile(join(root, "hidden.txt"), "hidden");
  await assert.rejects(fs.readSpaceFile(spaceId, "hidden.txt", { visibility: "filtered" }), (error) => error.status === 404);
  await rm(join(root, ".gitignore"));
  await symlink(join(victim, "secret.txt"), join(root, ".gitignore"));
  await assert.rejects(fs.readSpaceFile(spaceId, "own.txt", { visibility: "filtered" }), rejected);
});

function preview(spaceId, streamSpaceFile) {
  const principal = { type: "preview_session", spaceId, scopes: ["file.view"] };
  return new Hono().route("/", createPreviewRouter({
    previewHostnames: () => ["preview.test"], previewSessionTtlSeconds: 600,
    getPreviewSessionPrincipal: () => principal,
    hasPreviewSessionPermission: (token, _permission, id) => token.spaceId === id,
    requireValidId: () => true,
    resolveSpaceFileDownload: async () => ({ kind: "cloud" }),
    streamSpaceFile, spaceFsJsonError: fs.spaceFsJsonError,
    verifyPreviewSessionToken: () => null,
  }));
}

test("preview range reads keep the validated descriptor after path replacement", async () => {
  const { spaceId, root, victim } = await spaces();
  let handle;
  const app = preview(spaceId, async (...args) => {
    const info = await fs.streamSpaceFile(...args);
    handle = info.file;
    await rename(join(root, "own.txt"), join(root, "old.txt"));
    await symlink(join(victim, "secret.txt"), join(root, "own.txt"));
    return info;
  });
  const response = await app.request(`/s/${spaceId}/own.txt`, { headers: { host: "preview.test", range: "bytes=0-4" } });
  assert.equal(response.status, 206);
  assert.equal(await response.text(), "owned");
  assert.equal(handle.fd, -1);
});

test("preview invalid ranges and cancelled streams release the owned descriptor", async () => {
  const { spaceId } = await spaces();
  let handle;
  const app = preview(spaceId, async (...args) => {
    const info = await fs.streamSpaceFile(...args);
    handle = info.file;
    return info;
  });
  const invalid = await app.request(`/s/${spaceId}/own.txt`, { headers: { host: "preview.test", range: "bytes=999-1000" } });
  assert.equal(invalid.status, 416);
  assert.equal(handle.fd, -1);
  const response = await app.request(`/s/${spaceId}/own.txt`, { headers: { host: "preview.test" } });
  assert.equal(response.status, 200);
  await response.body.cancel();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(handle.fd, -1);
});

test("directory listings and recursive deletion accept native entry names", async () => {
  const { spaceId, root } = await spaces();
  await mkdir(join(root, "tree"));
  const name = "literal\\name.txt";
  await writeFile(join(root, "tree", name), "owned");
  assert.deepEqual((await fs.listSpaceDirectory(spaceId, "tree")).entries.map((entry) => entry.name), [name]);
  await fs.deleteSpaceNode(spaceId, "tree", true);
  assert(!(await readdir(root)).includes("tree"));
});

test("normalized trailing slashes retain existing file and directory behavior", async () => {
  const { spaceId } = await spaces();
  await fs.createSpaceDirectory(spaceId, "empty/");
  assert.deepEqual((await fs.listSpaceDirectory(spaceId, "empty/")).entries, []);
  assert.equal((await fs.readSpaceFile(spaceId, "own.txt/")).content, "owned-content");
  await fs.deleteSpaceNode(spaceId, "empty/", true);
});

test("CDN hits, pending files and queue failures release batch and single-file handles", async () => {
  const { spaceId, root } = await spaces();
  const paths = ["cached.png", "pending.png", "queue-error.png", "cdn-error.png"];
  await Promise.all(paths.map((path) => writeFile(join(root, path), "image")));
  const before = (await readdir("/proc/self/fd")).length;
  const result = await fs.readSpaceFiles(spaceId, ["own.txt", ...paths.slice(0, 3)]);
  assert.deepEqual(result.files.map((file) => file.path).sort(), ["cached.png", "own.txt"]);
  assert.deepEqual(result.preparing.map((file) => file.path), ["pending.png"]);
  assert.deepEqual(result.errors.map((error) => error.path), ["queue-error.png"]);
  assert.equal((await fs.readSpaceFile(spaceId, "pending.png")).status, "preparing");
  await assert.rejects(fs.readSpaceFile(spaceId, "cdn-error.png"), /manifest unavailable/);
  assert.equal((await readdir("/proc/self/fd")).length, before);
});

test("batch size rejection closes files already opened for metadata", async () => {
  const { spaceId, root } = await spaces();
  await truncate(join(root, "own.txt"), 21 * 1024 * 1024);
  const before = (await readdir("/proc/self/fd")).length;
  await assert.rejects(fs.readSpaceFiles(spaceId, ["own.txt"]), (error) => error.code === "batch_too_large");
  assert.equal((await readdir("/proc/self/fd")).length, before);
});

test("batch failures and early exits do not leave shared-file descriptors open", async () => {
  const { spaceId } = await spaces();
  const before = (await readdir("/proc/self/fd")).length;
  for (let i = 0; i < 20; i++) await fs.readSpaceFiles(spaceId, ["own.txt", "escape/secret.txt"]);
  assert.equal((await readdir("/proc/self/fd")).length, before);
});
