import assert from "node:assert/strict";
import test from "node:test";
import {
  aggregateUserModelRankings,
  InvalidUsageRangeError,
  resolveUserUsageRange,
  type GenerationUsageRow,
  type UsageRow,
} from "./usage-aggregation.js";

const now = new Date("2026-08-16T12:30:00.000Z");

function usageRow(overrides: Partial<UsageRow>): UsageRow {
  return {
    bucketStartAt: now,
    totalTokens: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    costInput: "0",
    costOutput: "0",
    costCacheRead: "0",
    costCacheWrite: "0",
    costTotal: "0",
    requestCount: 0,
    successCount: 0,
    errorCount: 0,
    harness: "cohub",
    provider: null,
    model: null,
    ...overrides,
  };
}

function generationRow(overrides: Partial<GenerationUsageRow>): GenerationUsageRow {
  return {
    bucketStartAt: now,
    costTotal: "0",
    requestCount: 0,
    successCount: 0,
    errorCount: 0,
    provider: "unknown",
    model: null,
    usageType: "image",
    ...overrides,
  };
}

test("model rankings reuse usage rows and aggregate matching models", () => {
  const rankings = aggregateUserModelRankings(
    [
      usageRow({
        provider: "openai",
        model: "gpt-5",
        totalTokens: 100,
        requestCount: 1,
        costTotal: "0.1",
      }),
      usageRow({
        provider: "openai",
        model: "gpt-5",
        totalTokens: 250,
        requestCount: 2,
        costTotal: "0.2",
      }),
      usageRow({ provider: "anthropic", model: "claude", totalTokens: 200, requestCount: 1 }),
    ],
    [
      generationRow({
        provider: "openai.images",
        model: "gpt-image",
        requestCount: 2,
        costTotal: "0.75",
      }),
      generationRow({
        provider: "openai.images",
        model: "gpt-image",
        requestCount: 3,
        costTotal: "0.5",
      }),
    ],
  );

  assert.deepEqual(rankings.llmModels[0], {
    harness: "cohub",
    provider: "openai",
    model: "gpt-5",
    totalTokens: 350,
    requestCount: 3,
    costTotal: 0.3,
  });
  assert.deepEqual(rankings.generationModels[0], {
    provider: "openai.images",
    model: "gpt-image",
    requestCount: 5,
    costTotal: 1.25,
  });
});

test("user usage range defaults to 30 rolling days", () => {
  const result = resolveUserUsageRange({}, now);
  assert.equal(result.days, 30);
  assert.equal(result.range.to, now.toISOString());
  assert.equal(result.startDate.toISOString(), "2026-07-17T12:00:00.000Z");
});

test("user usage range treats date-only to as an exclusive UTC boundary", () => {
  const result = resolveUserUsageRange({ from: "2026-08-01", to: "2026-08-08" }, now);
  assert.equal(result.days, 7);
  assert.equal(result.startDate.toISOString(), "2026-08-01T00:00:00.000Z");
  assert.equal(result.endDate.toISOString(), "2026-08-08T00:00:00.000Z");
});

test("user usage range rejects conflicting and unbounded inputs", () => {
  assert.throws(
    () => resolveUserUsageRange({ days: "30", from: "2026-08-01" }, now),
    InvalidUsageRangeError,
  );
  assert.throws(
    () => resolveUserUsageRange({ to: "2026-08-08" }, now),
    InvalidUsageRangeError,
  );
  assert.throws(
    () => resolveUserUsageRange({ from: "2026-02-30" }, now),
    InvalidUsageRangeError,
  );
  assert.throws(
    () => resolveUserUsageRange({ from: "2025-01-01", to: "2026-08-08" }, now),
    /cannot exceed 366 days/,
  );
});

test("user usage range accepts 366 days and rejects larger values", () => {
  assert.equal(resolveUserUsageRange({ days: "366" }, now).days, 366);
  assert.throws(
    () => resolveUserUsageRange({ days: "367" }, now),
    /between 1 and 366/,
  );
});
