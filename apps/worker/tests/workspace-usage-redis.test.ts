import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { Redis } from "ioredis";
import { MARK_USAGE_SCRIPT, RECONCILE_USAGE_SCRIPT } from "../../../packages/infra/src/workspace-usage/index.js";
import { CLAIM_SCAN, RENEW_SCAN, FINISH_SCAN, RESERVE_DUE } from "../src/system/jobs/workspace-usage/scripts.js";

// Dedicated disposable Redis only; no production URL fallback.
test("workspace accounting state machine on Redis", { skip: !process.env.COHUB_TEST_USAGE_REDIS_URL }, async (t) => {
  const url = process.env.COHUB_TEST_USAGE_REDIS_URL;
  assert.ok(url);
  const redis = new Redis(url, { maxRetriesPerRequest: 1 });
  const prefix = `test:workspace-usage:${randomUUID()}`;
  const due = `${prefix}:due`;
  const slots = `${prefix}:slots`;
  const keys = new Set<string>([due, slots]);
  const key = (id: string) => { const result = `${prefix}:${id}`; keys.add(result); return result; };
  const now = Date.now();
  const scanAt = now + 300_001;
  const minScanInterval = 48 * 60 * 60_000;
  const reconcile = (id: string, signature = "stopped", running = "0", provider = "cloud") =>
    redis.eval(RECONCILE_USAGE_SCRIPT, 2, key(id), due, id, signature, running, now, randomUUID(), provider, 300_000, minScanInterval);
  const claim = async (id: string, token: string, at = scanAt) => {
    const result = await redis.eval(CLAIM_SCAN, 3, key(id), due, slots, id, token, at, 90_000, 1, minScanInterval) as string[];
    return result[0] === "claimed" ? result[1] : null;
  };
  const finish = (id: string, token: string, revision: unknown, error = "", at = scanAt + 1000) =>
    redis.eval(FINISH_SCAN, 3, key(id), due, slots, id, token, String(revision), at, 4096, error, minScanInterval, 300_000);
  try {
    await t.test("clean stopped spaces remain unscheduled across inventory rotations", async () => {
      await reconcile("clean");
      const revision = await claim("clean", "a");
      assert.ok(revision);
      assert.equal(await finish("clean", "a", revision), 1);
      assert.equal(await redis.zscore(due, "clean"), null);
      await reconcile("clean");
      assert.equal(await redis.zscore(due, "clean"), null);
      assert.equal(await redis.hget(key("clean"), "dirty"), "0");
    });
    await t.test("write during scan keeps dirty and writer begin/end are coalesced", async () => {
      await reconcile("write");
      const revision = await claim("write", "b");
      assert.ok(revision);
      await redis.eval(MARK_USAGE_SCRIPT, 2, key("write"), due, "write", "r2", scanAt, 1, "", 300_000);
      await redis.eval(MARK_USAGE_SCRIPT, 2, key("write"), due, "write", "r3", scanAt, -1, "", 300_000);
      await finish("write", "b", revision);
      assert.equal(await redis.hget(key("write"), "dirty"), "1");
      assert.equal(await redis.zscore(due, "write"), String(scanAt + minScanInterval));
      assert.equal(await claim("write", "too-soon", scanAt + minScanInterval - 1), null);
      const nextRevision = await claim("write", "c", scanAt + minScanInterval);
      assert.ok(nextRevision);
      await finish("write", "c", nextRevision, "", scanAt + minScanInterval + 1000);
      assert.equal(await redis.hget(key("write"), "dirty"), "0");
    });
    await t.test("scan errors preserve last valid bytes and retry later", async () => {
      await redis.hset(key("failed"), "bytes", "4096", "measuredAt", scanAt - minScanInterval - 1000);
      await reconcile("failed");
      const before = await redis.hget(key("failed"), "measuredAt");
      const revision = await claim("failed", "d");
      assert.ok(revision);
      await finish("failed", "d", revision, "scan_failed");
      assert.equal(await redis.hget(key("failed"), "bytes"), "4096");
      assert.equal(await redis.hget(key("failed"), "measuredAt"), before);
      assert.equal(await redis.hget(key("failed"), "dirty"), "1");
      assert.equal(await redis.zscore(due, "failed"), String(scanAt + minScanInterval));
      assert.equal(await claim("failed", "too-soon", scanAt + minScanInterval - 1), null);
    });
    await t.test("stopped writes wait for both the cooldown and quiet window", async () => {
      await reconcile("stopped-write");
      const revision = await claim("stopped-write", "quiet");
      assert.ok(revision);
      await finish("stopped-write", "quiet", revision);
      const writeAt = scanAt + minScanInterval - 60_000;
      await redis.eval(MARK_USAGE_SCRIPT, 2, key("stopped-write"), due, "stopped-write", "write-start", writeAt, 1, "", 300_000);
      await redis.eval(MARK_USAGE_SCRIPT, 2, key("stopped-write"), due, "stopped-write", "write-end", writeAt, -1, "", 300_000);
      assert.equal(await redis.zscore(due, "stopped-write"), String(scanAt + minScanInterval + 240_000));
      assert.equal(await claim("stopped-write", "too-soon", scanAt + minScanInterval), null);
    });
    await t.test("running sandbox and orphan writers never become clean", async () => {
      await reconcile("running", "running", "1");
      let revision = await claim("running", "e");
      assert.ok(revision);
      await finish("running", "e", revision);
      assert.equal(await redis.hget(key("running"), "dirty"), "1");
      assert.equal(await redis.zscore(due, "running"), String(scanAt + minScanInterval));
      await reconcile("orphan");
      await redis.eval(MARK_USAGE_SCRIPT, 2, key("orphan"), due, "orphan", "writer", now, 1, "", 300_000);
      revision = await claim("orphan", "f");
      await finish("orphan", "f", revision);
      assert.equal(await redis.hget(key("orphan"), "dirty"), "1");
    });
    await t.test("live API writes do not force five-minute scans after a measurement", async () => {
      await redis.eval(MARK_USAGE_SCRIPT, 2, key("running"), due, "running", "live-write", scanAt + minScanInterval - 60_000, 1, "", 300_000);
      assert.equal(await redis.zscore(due, "running"), String(scanAt + minScanInterval));
    });
    await t.test("global limit applies across spaces and lease expiry fences old results", async () => {
      await reconcile("lock1");
      await reconcile("lock2");
      const revision = await claim("lock1", "g");
      assert.ok(revision);
      assert.equal(await claim("lock2", "h"), null);
      assert.equal(await claim("lock1", "duplicate"), null);
      const nextRevision = await claim("lock2", "h", scanAt + 91_000);
      assert.ok(nextRevision);
      assert.equal(await finish("lock1", "g", revision, "", scanAt + 92_000), 0);
      assert.equal(await redis.eval(RENEW_SCAN, 2, key("lock1"), slots, "g", scanAt + 180_000, scanAt + 92_000), 0);
      assert.equal(await finish("lock2", "h", nextRevision, "", scanAt + 92_000), 1);
    });
    await t.test("evicted snapshots are rebuilt as unknown, local spaces are removed", async () => {
      await redis.del(key("clean"));
      await reconcile("clean");
      assert.equal(await redis.hget(key("clean"), "bytes"), null);
      assert.equal(await redis.hget(key("clean"), "dirty"), "1");
      assert.ok(await redis.zscore(due, "clean"));
      await reconcile("clean", "local", "0", "local");
      assert.equal(await redis.exists(key("clean")), 0);
      assert.equal(await redis.zscore(due, "clean"), null);
    });
    await t.test("pending window bounds queue growth and expires abandoned reservations", async () => {
      const windowDue = `${prefix}:window-due`;
      const pending = `${prefix}:pending`;
      keys.add(windowDue); keys.add(pending);
      await redis.zadd(windowDue, now, "one", now, "two", now, "three");
      const first = await redis.eval(RESERVE_DUE, 2, windowDue, pending, now, 2) as string[];
      assert.equal(first.length, 2);
      assert.deepEqual(await redis.eval(RESERVE_DUE, 2, windowDue, pending, now + 1, 2), []);
      const firstId = first[0];
      assert.ok(firstId);
      await redis.zrem(pending, firstId);
      assert.equal((await redis.eval(RESERVE_DUE, 2, windowDue, pending, now + 2, 2) as string[]).length, 1);
      assert.equal((await redis.eval(RESERVE_DUE, 2, windowDue, pending, now + 601_000, 2) as string[]).length, 2);
    });
  } finally {
    await redis.del(...keys);
    await redis.quit();
  }
});
