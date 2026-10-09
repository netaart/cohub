import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { test } from "node:test";
import { Queue, Worker } from "bullmq";
import { AuthenticatedQueue, authenticateQueueJob } from "./authenticated-queue.js";

const url = process.env.BULLMQ_TEST_REDIS_URL;
if (!url || !["127.0.0.1", "localhost", "[::1]"].includes(new URL(url).hostname)) {
  throw new Error("BULLMQ_TEST_REDIS_URL must point to a dedicated loopback Redis instance");
}

await test("real Redis enforces queue authentication across producers and workers", async () => {
  const name = `auth-${randomUUID()}`;
  const key = randomBytes(32);
  const connection = { url, maxRetriesPerRequest: null };
  const queue = new AuthenticatedQueue<Record<string, unknown>>(name, { connection }, key);
  const raw = new Queue(name, { connection });
  const other = new Queue(`${name}-other`, { connection });
  const executed: string[] = [];
  const rejected: string[] = [];
  const retryAttempts: number[] = [];
  const worker = new Worker(name, async (job) => {
    authenticateQueueJob(job, key);
    assert.ok(job.id);
    if (job.id === "retry") {
      retryAttempts.push(job.attemptsMade);
      if (job.attemptsMade === 0) throw new Error("Retry this authorized request");
    }
    executed.push(job.id);
    return job.data.spaceId;
  }, { connection, autorun: false });
  const otherWorker = new Worker(other.name, async (job) => {
    authenticateQueueJob(job, key);
    throw new Error("Relocated job must never execute");
  }, { connection, autorun: false });
  worker.on("failed", (job) => { if (job?.id && job.id !== "retry") rejected.push(job.id); });
  otherWorker.on("failed", (job) => { if (job?.id) rejected.push(job.id); });
  try {
    await queue.add("run", { spaceId: "authorized", nested: { omitted: undefined, value: 1 } }, { jobId: "valid" });
    const automatic = await queue.add("run", { spaceId: "authorized" });
    assert.ok(automatic.id);
    await queue.add("run", { spaceId: "authorized" }, { jobId: "retry", attempts: 2 });
    await queue.addBulk([{ name: "run", data: { spaceId: "bulk" }, opts: { jobId: "bulk" } }]);
    const modified = await queue.add("run", { spaceId: "authorized" }, { jobId: "modified" });
    await modified.updateData({ ...modified.data, spaceId: "another-tenant" });
    await raw.add("run", { spaceId: "unauthorized" }, { jobId: "unsigned", attempts: 3 });
    const signed = await queue.add("run", { spaceId: "authorized" }, { jobId: "original" });
    await raw.add("run", signed.data, { jobId: "copied-id" });
    await other.add("run", signed.data, { jobId: "original" });
    const renamed = await queue.add("run", { spaceId: "authorized" }, { jobId: "renamed" });
    await renamed.remove();
    await raw.add("admin", renamed.data, { jobId: "renamed" });
    assert.throws(() => authenticateQueueJob(renamed, randomBytes(32)), /authentication failed/);
    await raw.add("run", { __cohubQueueAuth: { version: 1, binding: "invalid", signature: "0".repeat(64) } }, { jobId: "malformed" });
    const scheduled = await queue.upsertJobScheduler("schedule", { every: 100, limit: 2 }, { name: "run", data: { spaceId: "scheduled" } });
    await raw.upsertJobScheduler("copied-schedule", { every: 100, limit: 1 }, { name: "run", data: scheduled.data });
    const loops = [worker.run(), otherWorker.run()];
    const deadline = Date.now() + 15_000;
    while ((executed.length < 7 || rejected.length < 7) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.equal(executed.length, 7);
    assert.deepEqual(executed.filter((id) => !id.startsWith("repeat:")).sort(), [automatic.id, "bulk", "original", "retry", "valid"].sort());
    assert.deepEqual(retryAttempts, [0, 1]);
    assert.equal(executed.filter((id) => id.startsWith("repeat:schedule:")).length, 2);
    assert.equal(rejected.filter((id) => id.startsWith("repeat:copied-schedule:")).length, 1);
    assert.deepEqual(rejected.filter((id) => !id.startsWith("repeat:")).sort(), ["copied-id", "malformed", "modified", "original", "renamed", "unsigned"]);
    const unsigned = await raw.getJob("unsigned");
    assert.equal(unsigned?.attemptsMade, 1);
    assert.equal(await unsigned?.getState(), "failed");
    await Promise.all([worker.close(), otherWorker.close()]);
    await Promise.all(loops);
  } finally {
    await Promise.all([worker.close(), otherWorker.close()]);
    await queue.obliterate({ force: true });
    await other.obliterate({ force: true });
    await Promise.all([queue.close(), raw.close(), other.close()]);
  }
});
