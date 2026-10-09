import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { Redis } from "ioredis";
import { MARK_USAGE_SCRIPT, RECONCILE_USAGE_SCRIPT, USAGE_CLEAN_RECALIBRATION_MS, USAGE_MIN_SCAN_INTERVAL_MS, USAGE_QUIET_MS } from "@cohub/infra/workspace-usage";
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
  const reconcile = (id: string, signature = "stopped", running = "0", provider = "cloud") =>
    redis.eval(RECONCILE_USAGE_SCRIPT, 2, key(id), due, id, signature, running, now, randomUUID(), provider, USAGE_QUIET_MS, USAGE_MIN_SCAN_INTERVAL_MS, USAGE_CLEAN_RECALIBRATION_MS);
  const claim = async (id: string, token: string, at = scanAt) => {
    const result = await redis.eval(CLAIM_SCAN, 3, key(id), due, slots, id, token, at, 90_000, 1, USAGE_MIN_SCAN_INTERVAL_MS) as string[];
    return result[0] === "claimed" ? result[1] : null;
  };
  const finish = (id: string, token: string, revision: unknown, error = "", at = scanAt + 1000) =>
    redis.eval(FINISH_SCAN, 3, key(id), due, slots, id, token, String(revision), at, 4096, error, USAGE_MIN_SCAN_INTERVAL_MS, USAGE_QUIET_MS);
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
      await redis.eval(MARK_USAGE_SCRIPT, 2, key("write"), due, "write", "r2", scanAt, 1, "", USAGE_QUIET_MS, USAGE_MIN_SCAN_INTERVAL_MS);
      await redis.eval(MARK_USAGE_SCRIPT, 2, key("write"), due, "write", "r3", scanAt, -1, "", USAGE_QUIET_MS, USAGE_MIN_SCAN_INTERVAL_MS);
      await finish("write", "b", revision);
      assert.equal(await redis.hget(key("write"), "dirty"), "1");
      assert.equal(await redis.zscore(due, "write"), String(scanAt + USAGE_MIN_SCAN_INTERVAL_MS));
      assert.equal(await claim("write", "too-soon", scanAt + USAGE_MIN_SCAN_INTERVAL_MS - 1), null);
      const nextRevision = await claim("write", "c", scanAt + USAGE_MIN_SCAN_INTERVAL_MS);
      assert.ok(nextRevision);
      await finish("write", "c", nextRevision, "", scanAt + USAGE_MIN_SCAN_INTERVAL_MS + 1000);
      assert.equal(await redis.hget(key("write"), "dirty"), "0");
    });
    await t.test("scan errors preserve last valid bytes and retry later", async () => {
      await redis.hset(key("failed"), "bytes", "4096", "measuredAt", scanAt - USAGE_MIN_SCAN_INTERVAL_MS - 1000);
      await reconcile("failed");
      const before = await redis.hget(key("failed"), "measuredAt");
      const revision = await claim("failed", "d");
      assert.ok(revision);
      await finish("failed", "d", revision, "scan_failed");
      assert.equal(await redis.hget(key("failed"), "bytes"), "4096");
      assert.equal(await redis.hget(key("failed"), "measuredAt"), before);
      assert.equal(await redis.hget(key("failed"), "dirty"), "1");
      assert.equal(await redis.zscore(due, "failed"), String(scanAt + USAGE_MIN_SCAN_INTERVAL_MS));
      assert.equal(await claim("failed", "too-soon", scanAt + USAGE_MIN_SCAN_INTERVAL_MS - 1), null);
    });
    await t.test("stopped writes wait for both the cooldown and quiet window", async () => {
      await reconcile("stopped-write");
      const revision = await claim("stopped-write", "quiet");
      assert.ok(revision);
      await finish("stopped-write", "quiet", revision);
      const writeAt = scanAt + USAGE_MIN_SCAN_INTERVAL_MS - 60_000;
      await redis.eval(MARK_USAGE_SCRIPT, 2, key("stopped-write"), due, "stopped-write", "write-start", writeAt, 1, "", USAGE_QUIET_MS, USAGE_MIN_SCAN_INTERVAL_MS);
      await redis.eval(MARK_USAGE_SCRIPT, 2, key("stopped-write"), due, "stopped-write", "write-end", writeAt, -1, "", USAGE_QUIET_MS, USAGE_MIN_SCAN_INTERVAL_MS);
      assert.equal(await redis.zscore(due, "stopped-write"), String(scanAt + USAGE_MIN_SCAN_INTERVAL_MS + 240_000));
      assert.equal(await claim("stopped-write", "too-soon", scanAt + USAGE_MIN_SCAN_INTERVAL_MS), null);
    });
    await t.test("running sandbox and orphan writers never become clean", async () => {
      await reconcile("running", "running", "1");
      let revision = await claim("running", "e");
      assert.ok(revision);
      await finish("running", "e", revision);
      assert.equal(await redis.hget(key("running"), "dirty"), "1");
      assert.equal(await redis.zscore(due, "running"), String(scanAt + USAGE_MIN_SCAN_INTERVAL_MS));
      await reconcile("orphan");
      await redis.eval(MARK_USAGE_SCRIPT, 2, key("orphan"), due, "orphan", "writer", now, 1, "", USAGE_QUIET_MS, USAGE_MIN_SCAN_INTERVAL_MS);
      revision = await claim("orphan", "f");
      await finish("orphan", "f", revision);
      assert.equal(await redis.hget(key("orphan"), "dirty"), "1");
    });
    await t.test("live API writes do not force five-minute scans after a measurement", async () => {
      await redis.eval(MARK_USAGE_SCRIPT, 2, key("running"), due, "running", "live-write", scanAt + USAGE_MIN_SCAN_INTERVAL_MS - 60_000, 1, "", USAGE_QUIET_MS, USAGE_MIN_SCAN_INTERVAL_MS);
      assert.equal(await redis.zscore(due, "running"), String(scanAt + USAGE_MIN_SCAN_INTERVAL_MS));
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
    await t.test("a missing workspace backs off like a failed scan instead of retrying immediately", async () => {
      await reconcile("missing");
      const revision = await claim("missing", "path");
      assert.ok(revision);
      assert.equal(await redis.eval(FINISH_SCAN, 3, key("missing"), due, slots, "missing", "path", String(revision), scanAt + 1000, "", "scan_failed", USAGE_MIN_SCAN_INTERVAL_MS, USAGE_QUIET_MS), 1);
      assert.equal(await redis.hget(key("missing"), "error"), "scan_failed");
      assert.equal(await redis.hget(key("missing"), "dirty"), "1");
      assert.equal(await redis.zscore(due, "missing"), String(scanAt + USAGE_MIN_SCAN_INTERVAL_MS));
      assert.equal(await redis.hget(key("missing"), "bytes"), null);
    });

    await t.test("clean workspaces are recalibrated once their measurement ages out", async () => {
      await reconcile("aged");
      const revision = await claim("aged", "recal-1");
      assert.ok(revision);
      await finish("aged", "recal-1", revision);
      assert.equal(await redis.zscore(due, "aged"), null);
      const later = scanAt + USAGE_MIN_SCAN_INTERVAL_MS + 1;
      await redis.eval(RECONCILE_USAGE_SCRIPT, 2, key("aged"), due, "aged", "stopped", "0", later, randomUUID(), "cloud", USAGE_QUIET_MS, USAGE_MIN_SCAN_INTERVAL_MS, USAGE_CLEAN_RECALIBRATION_MS);
      assert.equal(await redis.zscore(due, "aged"), null);
      const aged = scanAt + USAGE_CLEAN_RECALIBRATION_MS + 1;
      await redis.eval(RECONCILE_USAGE_SCRIPT, 2, key("aged"), due, "aged", "stopped", "0", aged, randomUUID(), "cloud", USAGE_QUIET_MS, USAGE_MIN_SCAN_INTERVAL_MS, USAGE_CLEAN_RECALIBRATION_MS);
      assert.ok(await redis.zscore(due, "aged"));
      const agedRevision = await claim("aged", "recal-2", aged);
      assert.ok(agedRevision);
      await finish("aged", "recal-2", agedRevision, "", aged + 1000);
      assert.equal(await redis.hget(key("aged"), "dirty"), "0");
    });

    await t.test("pending window bounds queue growth and expires abandoned reservations", async () => {
      const windowDue = `${prefix}:window-due`;
      const pending = `${prefix}:pending`;
      keys.add(windowDue); keys.add(pending);
      await redis.zadd(windowDue, now, "one", now, "two", now, "three");
      const first = await redis.eval(RESERVE_DUE, 2, windowDue, pending, now, 2, 600_000, 300_000) as string[];
      assert.equal(first.length, 2);
      assert.deepEqual(await redis.eval(RESERVE_DUE, 2, windowDue, pending, now + 1, 2, 600_000, 300_000), []);
      const firstId = first[0];
      assert.ok(firstId);
      await redis.zrem(pending, firstId);
      assert.equal((await redis.eval(RESERVE_DUE, 2, windowDue, pending, now + 2, 2, 600_000, 300_000) as string[]).length, 1);
      assert.equal((await redis.eval(RESERVE_DUE, 2, windowDue, pending, now + 601_000, 2, 600_000, 300_000) as string[]).length, 2);
    });
  } finally {
    await redis.del(...keys);
    await redis.quit();
  }
});
