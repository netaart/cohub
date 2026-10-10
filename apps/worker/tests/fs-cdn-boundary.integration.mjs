import assert from "node:assert/strict";
import { after, mock, test } from "node:test";
import { mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const storage = await realpath(await mkdtemp(join(tmpdir(), "cohub-cdn-boundary-")));
after(() => rm(storage, { recursive: true, force: true }));
let registered;
let onPut = async () => {};
let rejectPut = false;
const puts = [], deletes = [], redisWrites = [];
class PutObjectCommand { constructor(input) { this.input = input; } }
class DeleteObjectCommand { constructor(input) { this.input = input; } }
class S3Client {
  async send(command) {
    if (command instanceof DeleteObjectCommand) { deletes.push(command.input); return {}; }
    if (rejectPut) throw new Error("object storage unavailable");
    await onPut();
    const chunks = [];
    for await (const chunk of command.input.Body) chunks.push(Buffer.from(chunk));
    puts.push({ key: command.input.Key, body: Buffer.concat(chunks).toString() });
    return {};
  }
}
mock.module("@aws-sdk/client-s3", { exports: { PutObjectCommand, DeleteObjectCommand, S3Client } });
mock.module("@cohub/infra/logging", { exports: { createLogger: () => ({ info() {}, warn() {} }) } });
mock.module("../src/config.js", { exports: { config: {
  env: "dev", spaceStorageRoot: storage,
  turnObjectS3Bucket: "test", turnObjectS3Endpoint: "https://storage.invalid",
  turnObjectS3AccessKeyId: "test", turnObjectS3SecretAccessKey: "test",
  turnObjectS3Region: "test", turnObjectCdnBaseUrl: "https://cdn.invalid",
} } });
mock.module("../src/redis.js", { exports: { redisCommandClient: { set: async (...args) => redisWrites.push(args) } } });
mock.module("../src/system/registry.js", { exports: { registerSystemJob: (_name, handler) => { registered = handler; } } });
await import("../src/system/jobs/fs-cdn-cache/index.js");

async function fixture() {
  puts.length = deletes.length = redisWrites.length = 0;
  onPut = async () => {};
  rejectPut = false;
  const spaceId = crypto.randomUUID();
  const root = join(storage, spaceId, "workspace");
  const other = join(storage, crypto.randomUUID(), "workspace");
  await Promise.all([mkdir(root, { recursive: true }), mkdir(other, { recursive: true })]);
  await writeFile(join(root, "image.png"), "safe-image");
  await writeFile(join(other, "secret.png"), "tenant-secret");
  const info = await stat(join(root, "image.png"));
  const data = { spaceId, path: "image.png", size: info.size, mtimeMs: info.mtimeMs, mimeType: "image/png", reason: "read_miss" };
  return { root, other, data };
}

test("CDN warmup uses a safe descriptor and a new manifest/object namespace", async () => {
  const { data } = await fixture();
  const result = await registered({ data });
  assert.match(result.objectKey, /^dev\/fs-cache\/v2\//);
  assert.equal(puts[0].body, "safe-image");
  assert(redisWrites.some(([key]) => key.startsWith("space-fs-cdn:v2:")));
});

test("CDN worker rejects intermediate/leaf symlinks even for queued paths", async () => {
  const { root, other, data } = await fixture();
  await symlink(other, join(root, "escape"));
  await symlink(join(other, "secret.png"), join(root, "link.png"));
  for (const path of ["escape/secret.png", "link.png", "../secret.png"]) {
    await assert.rejects(registered({ data: { ...data, path } }));
  }
  assert.equal(puts.length, 0);
  assert.equal(await readFile(join(other, "secret.png"), "utf8"), "tenant-secret");
});

test("replacement between validation and CDN upload never uploads the redirected target", async () => {
  const { root, other, data } = await fixture();
  onPut = async () => {
    await rename(join(root, "image.png"), join(root, "original.png"));
    await symlink(join(other, "secret.png"), join(root, "image.png"));
  };
  await registered({ data });
  assert.equal(puts.length, 1);
  assert.equal(puts[0].body, "safe-image");
  assert.equal(puts.some((put) => put.body.includes("tenant-secret")), false);
});

test("CDN stale jobs and storage failure release the descriptor", async () => {
  const { data } = await fixture();
  const before = (await readdir("/proc/self/fd")).length;
  assert.equal((await registered({ data: { ...data, size: 99999 } })).reason, "stale_payload");
  assert.equal(puts.length, 0);
  rejectPut = true;
  await assert.rejects(registered({ data }), /object storage unavailable/);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal((await readdir("/proc/self/fd")).length, before);
});
