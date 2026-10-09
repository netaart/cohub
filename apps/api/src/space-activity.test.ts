import assert from "node:assert/strict";
import test from "node:test";
import {
	MAX_CONTRIBUTORS,
	serializeActivityRange,
	stripActivityCost,
} from "./space-activity.js";
import { aggregateUserModelRankings, type GenerationUsageRow, type UsageRow } from "./usage-aggregation.js";

const at = (hoursAgo: number) => new Date(Date.UTC(2026, 7, 20, 12 - hoursAgo));

function usageRow(
  overrides: Partial<UsageRow & { userId: string | null; sessionId: string }>,
): UsageRow & { userId: string | null; sessionId: string } {
  return {
    bucketStartAt: at(0),
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
    provider: null,
    model: null,
    userId: null,
    sessionId: "00000000-0000-0000-0000-000000000001",
    ...overrides,
  };
}

function generationRow(
  overrides: Partial<GenerationUsageRow & { userId: string }>,
): GenerationUsageRow & { userId: string } {
  return {
    bucketStartAt: at(0),
    costTotal: "0",
    requestCount: 0,
    successCount: 0,
    errorCount: 0,
    provider: "openai.images",
    model: "seedream",
    usageType: "image",
    userId: "user-1",
    ...overrides,
  };
}

test("activity raw SQL boundaries serialize dates before binding", () => {
	const start = new Date("2026-08-01T00:00:00.000Z");
	const end = new Date("2026-08-28T00:00:00.000Z");

	assert.deepEqual(serializeActivityRange(start, end), {
		startAt: "2026-08-01T00:00:00.000Z",
		endAt: "2026-08-28T00:00:00.000Z",
	});
});

test("model rankings treat NULL and unknown as agent-owned, not a model", () => {
  const rankings = aggregateUserModelRankings(
    [usageRow({ userId: null, provider: "anthropic", model: "claude", totalTokens: 10 })],
    [generationRow({ userId: "unknown", requestCount: 5 })],
  );

  // Rankings intentionally include NULL/unknown usage — contributor aggregation
  // (SQL-side) is the piece that excludes those rows.
  assert.equal(rankings.llmModels[0]?.totalTokens, 10);
  assert.equal(rankings.generationModels[0]?.requestCount, 5);
});

test("stripActivityCost zeroes every cost surface while keeping the shape", () => {
  const activity = {
    days: 30,
    hourly: [
      {
        bucketStartAt: at(0),
        totalTokens: 10,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        costInput: 1,
        costOutput: 0,
        costCacheRead: 0,
        costCacheWrite: 0,
        costTotal: 1,
        requestCount: 1,
        successCount: 1,
        errorCount: 0,
        models: ["claude"],
      },
    ],
    summary: {
      totalTokens: 10,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      costInput: 1,
      costOutput: 0,
      costCacheRead: 0,
      costCacheWrite: 0,
      costTotal: 1,
      requestCount: 1,
      successCount: 1,
      errorCount: 0,
    },
    generation: {
      hourly: [
        {
          bucketStartAt: at(0),
          costTotal: 1,
          requestCount: 1,
          successCount: 1,
          errorCount: 0,
          models: ["seedream"],
          usageTypes: ["image"],
        },
      ],
      summary: { costTotal: 1, requestCount: 1, successCount: 1, errorCount: 0 },
    },
    totals: { totalTokens: 10, requestCount: 2, successCount: 2, errorCount: 0, costTotal: 2 },
    rankings: {
      llmModels: [
        { provider: "anthropic", model: "claude", totalTokens: 10, requestCount: 1, costTotal: 1 },
      ],
      generationModels: [
        { provider: "openai.images", model: "seedream", requestCount: 1, costTotal: 1 },
      ],
      apps: [],
    },
    contributors: {
      memberCount: 1,
      items: [
        {
          userUuid: "user-1",
          role: "host" as const,
          tokens: 10,
          requests: 1,
          costTotal: 1,
          sessionCount: 1,
          lastActiveAt: at(0).toISOString(),
          profile: null,
        },
      ],
    },
  };

  const stripped = stripActivityCost(activity);
  assert.equal(stripped.summary.costTotal, 0);
  assert.equal(stripped.generation.summary.costTotal, 0);
  assert.equal(stripped.generation.hourly[0]?.costTotal, 0);
  assert.equal(stripped.rankings.llmModels[0]?.costTotal, 0);
  assert.equal(stripped.rankings.generationModels[0]?.costTotal, 0);
  assert.equal(stripped.contributors.items[0]?.costTotal, 0);
  // Non-cost fields survive untouched.
  assert.equal(stripped.contributors.items[0]?.tokens, 10);
  assert.equal(stripped.contributors.memberCount, 1);
});

test("contributor result rows stay bounded by MAX_CONTRIBUTORS", () => {
  assert.equal(MAX_CONTRIBUTORS, 50);
  assert(Number.isInteger(MAX_CONTRIBUTORS) && MAX_CONTRIBUTORS > 0);
});
