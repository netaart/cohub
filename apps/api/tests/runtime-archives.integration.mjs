import assert from "node:assert/strict";
import { test, mock, after } from "node:test";
import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { getTableConfig } from "drizzle-orm/pg-core";
import { sessionTurns, spaceSessions } from "@cohub/db";

const home = process.env.RUNTIME_TEST_DB_HOME;
if (!home) throw new Error("RUNTIME_TEST_DB_HOME must point to an isolated PGlite installation");
const { PGlite } = await import(`${home}/node_modules/@electric-sql/pglite/dist/index.js`);
const { drizzle } = await import(`${home}/node_modules/drizzle-orm/pglite/index.js`);
const engine = new PGlite();
const database = drizzle(engine);
await engine.exec("create schema v2");
for (const table of [sessionTurns, spaceSessions]) {
  const config = getTableConfig(table);
  const columns = config.columns.map((column) => `"${column.name}" ${column.getSQLType()}${column.name === "id" ? " primary key" : ""}`);
  await engine.exec(`create table v2."${config.name}" (${columns.join(",")})`);
}
const tickets = new Map(), objects = new Map();
mock.module("../src/db/index.js", { exports: { db: database } });
mock.module("../src/config.js", { exports: { config: { env: "test", turnObjectS3Endpoint: "https://oss-us-west-1.aliyuncs.com", turnObjectS3Region: "us-west-1", turnObjectS3Bucket: "test", turnObjectS3AccessKeyId: "access", turnObjectS3SecretAccessKey: "secret" } } });
mock.module("../src/lib/middleware.js", { exports: {
  useAuth: (c) => ({ uuid: c.req.header("x-user") ?? "owner" }), requireValidId: (id) => /^[a-f0-9-]{36}$/.test(id), authzDenied: (c) => c.json({ message: "forbidden" }, 403),
} });
mock.module("../src/permissions.js", { exports: { hasPermission: async (user) => user.uuid !== "denied" } });
mock.module("../src/redis.js", { exports: { redisCommandClient: { set: async (key, value) => tickets.set(key, value), get: async (key) => tickets.get(key) } } });
mock.module("../src/space-upload-storage.js", { exports: {} });
mock.module("../src/upload-quota.js", { exports: { consumeUploadQuota: async () => {}, UploadRateLimitError: class extends Error {} } });
mock.module("../src/turn-object-storage.js", { exports: { headTurnObject: async (key) => objects.get(key) ?? {} } });
mock.module("../src/session-output.js", { exports: { dispatchTurnUpdated: async () => {} } });
mock.module("../src/session-turns.js", { exports: { getSessionTurnById: async () => null } });
const { default: route } = await import("../src/routes/spaces/runtime-archives.route.js");
const app = new Hono().route("/:id/runtime/archives", route);
after(() => engine.close());
async function setup(parentTurnId = null) {
  const spaceId = crypto.randomUUID(), sessionId = crypto.randomUUID(), turnId = crypto.randomUUID();
  await database.insert(spaceSessions).values({ id: sessionId, spaceId });
  await database.insert(sessionTurns).values({ id: turnId, sessionId, sequence: 1, status: "completed", meta: { harness: "pi", runtimeRecovery: { state: "executing", ownerUserId: "owner" } } });
  const index = { version: 1, sessionId, turnId, harness: "pi", nativeFormat: "pi.jsonl", nativeSessionId: "native", parentTurnId,
    sizeBytes: 3, sha256: "a".repeat(64), segments: [{ offset: 0, sizeBytes: 3, sha256: "a".repeat(64), md5: "b".repeat(32) }] };
  return { spaceId, index };
}
const request = (spaceId, action, index, user = "owner") => app.request(`/${spaceId}/runtime/archives/${action}`, { method: "POST", headers: { "Content-Type": "application/json", "x-user": user }, body: JSON.stringify(index) });

test("presign reuses storage policy without ACL headers; confirmation is verified and idempotent", async () => {
  const { spaceId, index } = await setup();
  assert.equal((await request(spaceId, "commit", index)).status, 409);
  const plan = await request(spaceId, "prepare", index);
  assert.equal(plan.status, 200);
  const { uploads } = await plan.json();
  assert.equal(uploads[0].headers["content-length"], "3");
  assert.equal(uploads[0].headers["x-oss-object-acl"], undefined);
  assert.equal(uploads[0].headers["x-amz-acl"], undefined);
  assert.equal(uploads[0].headers["x-oss-forbid-overwrite"], "true");
  const key = new URL(uploads[0].uploadUrl).pathname.slice(1);
  assert(key.includes(`/sessions/${index.sessionId}/native/pi/`));
  assert.equal((await request(spaceId, "commit", index)).status, 409);
  objects.set(key, { ContentLength: 3, ETag: `"${"c".repeat(32)}"` });
  assert.equal((await request(spaceId, "commit", index)).status, 409);
  objects.set(key, { ContentLength: 3, ETag: `"${"b".repeat(32)}"` });
  const confirmations = await Promise.all([request(spaceId, "commit", index), request(spaceId, "commit", index)]);
  assert.deepEqual(confirmations.map((response) => response.status), [200, 200]);
  assert.deepEqual((await (await request(spaceId, "prepare", index)).json()).uploads, []);
  const download = await app.request(`/${spaceId}/runtime/archives/${index.sessionId}/${index.turnId}`);
  assert.equal(download.status, 200);
  const page = await download.json();
  assert.equal(page.index.turnId, index.turnId);
  assert(page.segments[0].downloadUrl.includes("X-Amz-Signature"));
  assert.equal("data" in page, false);
});

test("archive versions append only to ready earlier turns in the same session", async () => {
  const { spaceId, index: parent } = await setup();
  const turnId = crypto.randomUUID();
  await database.insert(sessionTurns).values({ id: turnId, sessionId: parent.sessionId, sequence: 2, status: "completed", meta: { harness: "pi", runtimeRecovery: { state: "executing", ownerUserId: "owner" } } });
  const child = { ...parent, turnId, parentTurnId: parent.turnId, sizeBytes: 5, sha256: "e".repeat(64), segments: [{ offset: 3, sizeBytes: 2, sha256: "c".repeat(64), md5: "d".repeat(32) }] };
  assert.equal((await request(spaceId, "prepare", child)).status, 409);
  for (const index of [parent, child]) {
    const response = await request(spaceId, "prepare", index);
    assert.equal(response.status, 200);
    const { uploads } = await response.json();
    for (const { segment, uploadUrl } of uploads) objects.set(new URL(uploadUrl).pathname.slice(1), { ContentLength: segment.sizeBytes, ETag: `"${segment.md5}"` });
    assert.equal((await request(spaceId, "commit", index)).status, 200);
  }
  const response = await app.request(`/${spaceId}/runtime/archives/${parent.sessionId}/${turnId}`);
  const page = await response.json();
  assert.equal(page.index.parentTurnId, parent.turnId);
  assert.equal(page.segments.length, 1);
  assert.equal(page.segments[0].segment.offset, 3);
});

test("invalid persisted archive indexes are unavailable rather than internal errors", async () => {
  const { spaceId, index } = await setup();
  const meta = { harness: "pi", runtimeArchiveStatus: "ready", runtimeRecovery: { state: "executing", ownerUserId: "owner" } };
  for (const invalid of [{ objectKey: "legacy.json", harness: "pi", nativeFormat: "pi.jsonl" }, { ...index, sessionId: crypto.randomUUID() }, { ...index, turnId: crypto.randomUUID() }]) {
    await database.update(sessionTurns).set({ meta, harnessIndex: invalid }).where(eq(sessionTurns.id, index.turnId));
    assert.equal((await app.request(`/${spaceId}/runtime/archives/${index.sessionId}/${index.turnId}`)).status, 409);
    assert.equal((await request(spaceId, "prepare", index)).status, 409);
    assert.equal((await request(spaceId, "commit", index)).status, 409);
  }
  for (const status of ["pending", "failed"]) {
    await database.update(sessionTurns).set({ meta: { ...meta, runtimeArchiveStatus: status }, harnessIndex: index }).where(eq(sessionTurns.id, index.turnId));
    assert.equal((await app.request(`/${spaceId}/runtime/archives/${index.sessionId}/${index.turnId}`)).status, 409);
  }
});

test("wrong owner, cross-space access, malformed chains and late confirmed-stop submissions are rejected", async () => {
  const { spaceId, index } = await setup();
  assert.equal((await request(spaceId, "prepare", index, "other")).status, 403);
  assert.equal((await request(spaceId, "prepare", index, "denied")).status, 403);
  assert.equal((await request(crypto.randomUUID(), "prepare", index)).status, 404);
  assert.equal((await request(spaceId, "prepare", { ...index, segments: [{ ...index.segments[0], offset: 1 }] })).status, 400);
  assert.equal((await request(spaceId, "prepare", index)).status, 200);
  await database.update(sessionTurns).set({ meta: { harness: "pi", runtimeRecovery: { state: "confirmed_stopped", ownerUserId: "owner" } } }).where(eq(sessionTurns.id, index.turnId));
  assert.equal((await request(spaceId, "commit", index)).status, 409);
  assert.equal((await app.request(`/${spaceId}/runtime/archives/${index.sessionId}/${index.turnId}`)).status, 409);
});
