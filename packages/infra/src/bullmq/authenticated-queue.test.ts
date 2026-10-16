import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test } from "node:test";
import { AuthenticatedQueue, readQueueSigningKey } from "./authenticated-queue.js";

test("queue signing configuration fails before connecting to Redis", () => {
  const previous = process.env.BULLMQ_SIGNING_KEY;
  try {
    for (const value of [undefined, "", "short", "x".repeat(64), "00".repeat(31), "00".repeat(33)]) {
      if (value === undefined) delete process.env.BULLMQ_SIGNING_KEY;
      else process.env.BULLMQ_SIGNING_KEY = value;
      assert.throws(() => readQueueSigningKey(), /BULLMQ_SIGNING_KEY/);
      assert.throws(() => new AuthenticatedQueue("configuration-check", { connection: { host: "127.0.0.1" } }), /BULLMQ_SIGNING_KEY/);
    }
    const key = randomBytes(32);
    process.env.BULLMQ_SIGNING_KEY = key.toString("hex").toUpperCase();
    assert.deepEqual(readQueueSigningKey(), key);
  } finally {
    if (previous === undefined) delete process.env.BULLMQ_SIGNING_KEY;
    else process.env.BULLMQ_SIGNING_KEY = previous;
  }
});
