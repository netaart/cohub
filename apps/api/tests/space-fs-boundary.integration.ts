import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, readlink, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { resolve } from "node:path";
import { after, before, test } from "node:test";
import { setTimeout } from "node:timers/promises";
import { CreateBucketCommand, GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { FS_CDN_WARM_FILE_JOB } from "../src/space-fs-cdn-constants.js";

// 使用本机 Redis 与 S3 服务进程；通过环境变量指定 redis-server 和 rustfs 可执行文件。
const processes: ChildProcess[] = [];
let base: string;
let root: string;
let outside: string;
let api: typeof import("../src/space-fs.js");
let redis: typeof import("../src/redis.js");
let workerRedis: typeof import("../../worker/src/redis.js");
let queue: typeof import("../src/space-fs-cdn-queue.js");
let registry: typeof import("../../worker/src/system/registry.js");
let s3: S3Client;
const spaceId = randomUUID();
const bucket = `fs-boundary-${randomUUID()}`;

async function availablePort() {
  const server = createServer();
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  await new Promise<void>((done, reject) => server.close((error) => error ? reject(error) : done()));
  return address.port;
}

function startProcess(binary: string, args: string[], name: string, env = process.env) {
  const child = spawn(binary, args, { env, stdio: ["ignore", "pipe", "pipe"] });
  const log = createWriteStream(`${base}/${name}.log`);
  child.stdout?.pipe(log, { end: false });
  child.stderr?.pipe(log, { end: false });
  child.once("close", () => log.end());
  processes.push(child);
  return child;
}

before(async () => {
  const redisBin = process.env.FS_BOUNDARY_REDIS_BIN;
  const s3Bin = process.env.FS_BOUNDARY_S3_BIN;
  assert.ok(redisBin && s3Bin, "FS_BOUNDARY_REDIS_BIN and FS_BOUNDARY_S3_BIN are required");
  const output = resolve("output");
  await mkdir(output, { recursive: true });
  base = await mkdtemp(`${output}/fs-boundary-integration-`);
  root = `${base}/storage/${spaceId}/workspace`;
  outside = `${base}/outside`;
  await mkdir(`${root}/docs`, { recursive: true });
  await mkdir(outside);
  await writeFile(`${root}/docs/file.txt`, "workspace");
  await writeFile(`${outside}/file.txt`, "outside");
  await symlink("docs", `${root}/alias`);
  const redisPort = await availablePort();
  const s3Port = await availablePort();
  const redisUrl = `redis://127.0.0.1:${redisPort}`;
  const endpoint = `http://127.0.0.1:${s3Port}`;
  const accessKeyId = randomUUID();
  const secretAccessKey = randomUUID();
  Object.assign(process.env, {
    ENV: "dev", REDIS_URL: redisUrl, BULLMQ_REDIS_URL: redisUrl,
    SPACE_STORAGE_ROOT: `${base}/storage`, TURN_OBJECT_S3_ENDPOINT: endpoint,
    TURN_OBJECT_S3_ACCESS_KEY_ID: accessKeyId, TURN_OBJECT_S3_SECRET_ACCESS_KEY: secretAccessKey,
    TURN_OBJECT_S3_BUCKET: bucket, TURN_OBJECT_S3_REGION: "us-east-1", TURN_OBJECT_CDN_BASE_URL: endpoint,
  });
  startProcess(redisBin, ["--bind", "127.0.0.1", "--port", String(redisPort), "--save", "", "--appendonly", "no", "--dir", base], "redis");
  await mkdir(`${base}/objects`);
  const objectServer = startProcess(s3Bin, ["server", "--address", `127.0.0.1:${s3Port}`, `${base}/objects`], "s3", {
    ...process.env, RUSTFS_ACCESS_KEY: accessKeyId, RUSTFS_SECRET_KEY: secretAccessKey,
    RUSTFS_REGION: "us-east-1", TMPDIR: base,
  });
  const deadline = Date.now() + 30_000;
  while (true) {
    assert.equal(objectServer.exitCode, null, "S3 server exited during startup");
    try {
      const response = await fetch(`${endpoint}/health`, { signal: AbortSignal.timeout(1000) });
      await response.arrayBuffer();
      break;
    } catch (error) {
      if (Date.now() > deadline) throw error;
      await setTimeout(100);
    }
  }
  s3 = new S3Client({ endpoint, region: "us-east-1", forcePathStyle: true, credentials: { accessKeyId, secretAccessKey } });
  await s3.send(new CreateBucketCommand({ Bucket: bucket }));
  api = await import("../src/space-fs.js");
  redis = await import("../src/redis.js");
  queue = await import("../src/space-fs-cdn-queue.js");
  workerRedis = await import("../../worker/src/redis.js");
  registry = await import("../../worker/src/system/registry.js");
  await import("../../worker/src/system/jobs/fs-cdn-cache/index.js");
  assert.equal(await redis.redisCommandClient.ping(), "PONG");
}, { timeout: 60_000 });

after(async () => {
  await queue?.fsCdnQueue.close();
  redis?.redisCommandClient.disconnect();
  redis?.redisBestEffortCommandClient.disconnect();
  workerRedis?.redisCommandClient.disconnect();
  s3?.destroy();
  for (const child of processes) {
    if (child.exitCode !== null || child.signalCode !== null) continue;
    await new Promise<void>((done) => {
      child.once("close", done);
      child.kill("SIGTERM");
    });
  }
  if (base) await rm(base, { recursive: true, force: true });
});

test("API preserves internal directory aliases for listing, batch reads and writes", async () => {
  const file = await api.readSpaceFile(spaceId, "alias/file.txt");
  assert.ok("content" in file);
  assert.equal(file.content, "workspace");
  const result = await api.writeSpaceFile(spaceId, { path: "alias/new/created.txt", content: "created", encoding: "utf-8" });
  assert.equal(result.created, true);
  assert.deepEqual(result.createdDirs, ["alias/new"]);
  assert.equal(await readFile(`${root}/docs/new/created.txt`, "utf8"), "created");
  const tree = await api.listSpaceDirectory(spaceId, "alias/new");
  assert.deepEqual(tree.entries.map((entry) => entry.path), ["alias/new/created.txt"]);
  const batch = await api.readSpaceFiles(spaceId, ["alias/file.txt", "alias/new/created.txt"]);
  assert.deepEqual(batch.files.map((entry) => entry.content), ["workspace", "created"]);
  assert.deepEqual(batch.errors, []);
});

test("API rejects escaping aliases without modifying outside files", async () => {
  await symlink("../../../outside", `${root}/escape`);
  await symlink(outside, `${root}/absolute`);
  for (const name of ["escape", "absolute"]) {
    await assert.rejects(api.readSpaceFile(spaceId, `${name}/file.txt`), { name: "SpaceFsPathError" });
    await assert.rejects(api.writeSpaceFile(spaceId, { path: `${name}/file.txt`, content: "overwrite", encoding: "utf-8" }));
    await assert.rejects(api.createSpaceDirectory(spaceId, `${name}/created`));
  }
  assert.equal(await readFile(`${outside}/file.txt`, "utf8"), "outside");
  assert.deepEqual(await readdir(outside), ["file.txt"]);
  const batch = await api.readSpaceFiles(spaceId, ["escape/file.txt"]);
  assert.equal(batch.errors[0]?.code, "path_invalid");
  assert.equal(batch.errors[0]?.status, 400);
});

test("API keeps version conflicts, exclusive creation and missing version results", async () => {
  const expected = await api.statSpaceFileVersion(spaceId, "alias/file.txt");
  assert.ok(expected.exists);
  const updated = await api.writeSpaceFile(spaceId, { path: "alias/file.txt", content: "updated file", encoding: "utf-8", expected });
  assert.equal(updated.created, false);
  await assert.rejects(api.writeSpaceFile(spaceId, { path: "alias/file.txt", content: "lost", encoding: "utf-8", expected }), { code: "file_conflict" });
  await assert.rejects(api.writeSpaceFile(spaceId, { path: "missing/file.txt", content: "lost", encoding: "utf-8", expected }), { code: "file_conflict" });
  await assert.rejects(api.createSpaceFileExclusive(spaceId, { path: "alias/file.txt", content: "lost", encoding: "utf-8" }), { code: "path_exists" });
  assert.equal(await readFile(`${root}/docs/file.txt`, "utf8"), "updated file");
  assert.deepEqual(await api.statSpaceFileVersion(spaceId, "missing/file.txt"), { exists: false });
});

test("API preserves leaf error codes and allows moving and deleting link entries", async () => {
  await symlink(`${outside}/file.txt`, `${root}/leaf`);
  await assert.rejects(api.readSpaceFile(spaceId, "leaf"), { code: "symlink_not_supported" });
  await assert.rejects(api.streamSpaceFile(spaceId, "leaf"), { code: "not_a_file" });
  await assert.rejects(api.createSpaceDirectory(spaceId, "leaf"), { name: "SpaceFsPathError" });
  await assert.rejects(api.createSpaceDirectory(spaceId, "alias/file.txt"), { code: "not_a_directory" });
  await assert.rejects(api.writeSpaceFile(spaceId, { path: "alias/file.txt/child", content: "lost", encoding: "utf-8" }), { code: "not_a_directory" });
  await assert.rejects(api.createSpaceFileExclusive(spaceId, { path: "leaf", content: "lost", encoding: "utf-8" }), { code: "path_exists" });
  const moved = await api.moveSpaceNode(spaceId, { fromPath: "leaf", toPath: "alias/moved" });
  assert.equal(moved.nodeType, "symlink");
  assert.equal((await api.deleteSpaceNode(spaceId, "alias/moved")).nodeType, "symlink");
  assert.equal(await readFile(`${outside}/file.txt`, "utf8"), "outside");
});

test("API uploads and recursive deletion use the resolved directory", async () => {
  const result = await api.uploadSpaceFiles(spaceId, [new File(["uploaded"], "upload.txt")], "alias/uploads");
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.createdDirs, ["alias/uploads"]);
  assert.equal(await readFile(`${root}/docs/uploads/upload.txt`, "utf8"), "uploaded");
  await symlink(outside, `${root}/docs/uploads/outside`);
  await api.deleteSpaceNode(spaceId, "alias/uploads", true);
  assert.equal(await readFile(`${outside}/file.txt`, "utf8"), "outside");
});

test("API streams keep their opened file when paths are replaced", async () => {
  await writeFile(`${root}/docs/stream.txt`, "stream contents");
  const info = await api.streamSpaceFile(spaceId, "alias/stream.txt");
  await using file = info.file;
  await rename(`${root}/docs/stream.txt`, `${root}/docs/saved.txt`);
  await symlink(`${outside}/file.txt`, `${root}/docs/stream.txt`);
  assert.equal(await file.readFile("utf8"), "stream contents");
});

test("API releases opened files on batch limits and visibility errors", async () => {
  const paths = ["large-a.txt", "large-b.txt", "large-c.txt"];
  const content = Buffer.alloc(8 * 1024 * 1024, "a");
  for (const path of paths) await writeFile(`${root}/${path}`, content);
  await assert.rejects(api.readSpaceFiles(spaceId, paths), { code: "batch_too_large" });
  await assert.rejects(api.readSpaceFile(spaceId, "docs"), { code: "not_a_file" });
  await writeFile(`${root}/.gitignore`, "docs/file.txt\n");
  await assert.rejects(api.readSpaceFile(spaceId, "docs/file.txt", { visibility: "filtered" }), { code: "path_not_found" });
  await rm(`${root}/.gitignore`);
  const openFiles = await Promise.all((await readdir("/proc/self/fd")).map(async (fd) => {
    try {
      return await readlink(`/proc/self/fd/${fd}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
      throw error;
    }
  }));
  assert.deepEqual(openFiles.filter((path) => path.startsWith(root)), []);
});

test("CDN worker uploads through an internal alias using real Redis and S3", async () => {
  await writeFile(`${root}/docs/image.png`, Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  const info = await stat(`${root}/docs/image.png`);
  const job = await queue.enqueueFsCdnWarmFile({ spaceId, path: "alias/image.png", size: info.size, mtimeMs: info.mtimeMs, mimeType: "image/png", requestedAt: Date.now(), reason: "read_miss" });
  const handler = registry.getSystemJobHandler(FS_CDN_WARM_FILE_JOB);
  assert.ok(handler);
  const result = await handler(job);
  assert.ok(result && typeof result.objectKey === "string");
  const object = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: result.objectKey }));
  assert.ok(object.Body);
  assert.deepEqual(Buffer.from(await object.Body.transformToByteArray()), await readFile(`${root}/docs/image.png`));
});

test("CDN worker rejects an outside alias and skips stale metadata", async () => {
  const handler = registry.getSystemJobHandler(FS_CDN_WARM_FILE_JOB);
  assert.ok(handler);
  const payload = { spaceId, path: "absolute/file.txt", size: 7, mtimeMs: 0, mimeType: "image/png", requestedAt: Date.now(), reason: "read_miss" as const };
  const escaped = await queue.enqueueFsCdnWarmFile(payload);
  await assert.rejects(handler(escaped), { name: "SpaceFsPathError" });
  const stale = await queue.enqueueFsCdnWarmFile({ ...payload, path: "alias/image.png" });
  assert.deepEqual(await handler(stale), { skipped: true, reason: "stale_payload" });
});
