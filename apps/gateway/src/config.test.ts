import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveBullmqRedisUrl } from "./config.js";

test("resolveBullmqRedisUrl requires an explicit queue Redis URL", () => {
  assert.throws(
    () => resolveBullmqRedisUrl({ REDIS_URL: "redis://localhost:6379/2" }),
    /Missing required env: BULLMQ_REDIS_URL/,
  );
});

test("resolveBullmqRedisUrl returns the configured queue Redis URL", () => {
  assert.equal(
    resolveBullmqRedisUrl({
      ENV: "prod",
      REDIS_URL: "redis://localhost:6379/2",
      BULLMQ_REDIS_URL: " redis://localhost:6379/4 ",
    }),
    "redis://localhost:6379/4",
  );
});
