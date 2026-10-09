import assert from "node:assert/strict";
import { test } from "node:test";
import type { ContentBlock } from "./src/core/content.js";
import {
  collectImageToTextTiming, collectToolMetrics, emptyExecutionStats, mergeExecutionStats, readSessionStats,
  readStatsUsage, readTurnMetrics, readTurnStats, sumStatsUsage,
  type RequestMetric, type SessionStats, type StatsTurn,
} from "./src/model/metrics.js";

const usage = { input: 100, output: 20, cacheRead: 30, cacheWrite: 10, totalTokens: 160, cost: { total: 0.01 } };
const request = (patch: Partial<RequestMetric> = {}): RequestMetric => ({ id: "r1", provider: "p", model: "m", startedAt: 1000, completedAt: 2000, durationMs: 1000, firstTokenMs: 100, outputDurationMs: 900, status: "completed", usage, ...patch });
const turn = (patch: Partial<StatsTurn> = {}): StatsTurn => ({ status: "completed", totalUsage: usage, durationMs: 5000, meta: { metrics: { version: 1, requests: { r1: request() } } }, ...patch });

test("rates retain additive numerators and matched samples", () => {
  const a = readTurnStats(turn());
  const b = readTurnStats(turn({ meta: { metrics: { version: 1, requests: { r2: request({ id: "r2", firstTokenMs: 900, outputDurationMs: 100, usage: { output: 80 } }) } } } }));
  const total = mergeExecutionStats(a, b);
  assert.equal(total.ttftMs / total.ttftSamples, 500);
  assert.equal(total.timedOutputTokens / total.outputMs * 1000, 100);
  assert.equal(total.calls, 2);
});

test("legacy usage survives missing metrics; message count is not invented as call count", () => {
  const result = readTurnStats(turn({ meta: {}, intermediateSummary: { messageCount: 10, toolCallCount: 4 } }));
  assert.equal(result.calls, null);
  assert.equal(result.toolCalls, 4);
  assert.equal(result.usage?.totalTokens, 160);
  assert.equal(result.partial, true);
  assert.equal(result.ttftSamples, 0);
});

test("direct shell execution is not reported as a missing model call", () => {
  const result = readTurnStats(turn({ totalUsage: null, meta: { llm: false, metrics: { version: 1, tools: { calls: 1, errors: 0, timedCalls: 1, activeMs: 500 } } } }));
  assert.equal(result.calls, 0);
  assert.equal(result.usage, null);
  assert.equal(result.partial, false);
});

test("running, merged and cancelled turns contribute no completed execution", () => {
  for (const status of ["running", "queued", "abort_requested", "merged", "cancelled"]) {
    assert.deepEqual(readTurnStats(turn({ status })), emptyExecutionStats());
  }
});

test("failed and interrupted turns retain actual reported usage", () => {
  for (const status of ["failed", "interrupted"]) assert.equal(readTurnStats(turn({ status })).usage?.totalTokens, 160);
});

test("omitted retry consumption is included exactly once, without changing source usage", () => {
  const original = structuredClone(usage);
  const result = readTurnStats(turn({ meta: { metrics: { version: 1, requests: { a: request({ id: "a", status: "failed", omitted: true }), b: request({ id: "b" }) }, retryCount: 1, retryWaitMs: 1200 } } }));
  assert.equal(result.usage?.totalTokens, 320);
  assert.equal(result.modelCostUsd, 0.02);
  assert.equal(result.failedCalls, 1);
  assert.equal(result.retryWaitMs, 1200);
  assert.deepEqual(usage, original);
});

test("image-description usage survives a discarded model attempt without duplication", () => {
  const result = readTurnStats(turn({ meta: { metrics: { version: 1, requests: { r1: request({ omitted: true, status: "failed", usage: null, imageToText: { calls: 1, durationMs: 400, usage: { totalTokens: 12 }, unknownUsageCalls: 0 } }) } } } }));
  assert.equal(result.usage?.totalTokens, 172);
  assert.equal(result.imageToTextCalls, 1);
  assert.equal(result.imageToTextMs, 400);
});

test("image-description timings preserve unknown values and include failed attempts", () => {
  assert.deepEqual(collectImageToTextTiming([{ imageToText: { calls: [{ durationMs: 12 }, { durationMs: 8, status: "failed" }, {}] } }]), { durationMs: 20, timedCalls: 2 });
  assert.deepEqual(collectImageToTextTiming([{}]), { durationMs: null, timedCalls: 0 });
});

test("fatal errors before the usage projection retain completed attempt consumption", () => {
  const result = readTurnStats(turn({ status: "failed", totalUsage: null }));
  assert.equal(result.usage?.totalTokens, 160);
  assert.equal(result.partial, true);
});

test("unknown and unfinished requests do not invent zero usage or decoding samples", () => {
  const result = readTurnStats(turn({ meta: { metrics: { version: 1, requests: { r1: { id: "r1", provider: "p", model: "m", startedAt: 0, status: "running" } } } } }));
  assert.equal(result.calls, 1);
  assert.equal(result.modelMs, null);
  assert.equal(result.outputMs, 0);
  assert.equal(result.unknownUsageCalls, 1);
  assert.equal(result.partial, true);
});

test("compaction is a subset of usage, not an extra conversation or extra charge", () => {
  const between = readTurnStats(turn({ intent: "compact" }));
  assert.equal(between.turns, 0);
  assert.equal(between.compactions, 1);
  assert.equal(between.compactionUsage?.totalTokens, 160);
  const failed = readTurnStats(turn({ intent: "compact", status: "failed" }));
  assert.equal(failed.compactions, 0);
  assert.equal(failed.usage?.totalTokens, 160);
  const within = readTurnStats(turn({ intermediateSummary: { messageCount: 3, toolCallCount: 1, compaction: { count: 2, summarizedMessageCountTotal: 10, attemptCountTotal: 2, usage: { totalTokens: 50 }, durationMsTotal: 600, last: null } } }));
  assert.equal(within.turns, 1);
  assert.equal(within.usage?.totalTokens, 160);
  assert.equal(within.compactionUsage?.totalTokens, 50);
  assert.equal(within.elapsedMs, 5000);
  assert.equal(within.compactionMs, 600);
});

test("final image description summary includes calls absent from the intermediate summary", () => {
  const result = readTurnStats(turn({ meta: { imageToText: { summary: { callCount: 3 } } }, intermediateSummary: { messageCount: 1, toolCallCount: 0, imageToText: { callCount: 1, successCount: 1, errorCount: 0, sourceCount: 1, usage: null } } }));
  assert.equal(result.imageToTextCalls, 3);
});

test("new execution timestamps split pre-execution waiting without changing historical duration", () => {
  const result = readTurnStats(turn({ createdAt: new Date(1000), completedAt: new Date(10000), meta: { metrics: { version: 1, executionStartedAt: 3000 } } }));
  assert.equal(result.queueMs, 2000);
  assert.equal(result.elapsedMs, 7000);
  assert.equal(readTurnStats(turn({ meta: {} })).elapsedMs, 5000);
});

test("shared generation statistics expose only provider price, never private billing", () => {
  const result = readTurnStats(turn({ executionKind: "direct_generation", totalUsage: { cost: { total: 2 } }, meta: { generation: { officialCostUsd: 3, billing: { status: "recorded", amountUsd: 2 } } } }));
  assert.equal(result.chargedCostUsd, null);
  assert.equal(result.generationCostUsd, 3);
  assert.equal(result.usage, null);
  assert.equal(result.modelCostUsd, null);
  assert.equal(result.generations, 1);
  const pending = readTurnStats(turn({ executionKind: "direct_generation", meta: { generation: { billing: { status: "pending" } } } }));
  assert.equal(pending.chargedCostUsd, null);
  assert.equal(pending.partial, true);
  const free = readTurnStats(turn({ executionKind: "direct_generation", meta: { generation: { officialCostUsd: 3, billing: { status: "skipped", reason: "discounted_free", amountUsd: 0 } } } }));
  assert.equal(free.chargedCostUsd, null);
  assert.deepEqual(free, result, "private billing must not influence any shared statistic");
  assert.equal(free.generationCostUsd, 3);
  assert.equal(free.partial, false);
});

test("unknown fields remain absent and zero remains a valid observed value", () => {
  assert.equal(sumStatsUsage(null, null), null);
  assert.deepEqual(sumStatsUsage(null, { output: 0 }), { output: 0 });
  assert.deepEqual(sumStatsUsage({ input: 10 }, { output: 2 }), { input: 10, output: 2 });
  assert.equal(readStatsUsage({ input: Number.NaN }), null);
  assert.equal(readStatsUsage({ cost: { total: -1 } }), null);
});

const tool = (id: string, start?: number, end?: number): ContentBlock => ({ type: "tool_use", id, name: "bash", input: {}, _meta: { timing: { ...(start != null ? { startedAt: new Date(start).toISOString() } : {}), ...(end != null ? { completedAt: new Date(end).toISOString() } : {}) } } });
test("tool intervals union parallel and nested tools and deduplicate result blocks", () => {
  const metrics = collectToolMetrics([[tool("wrapper", 1000, 10000), tool("a", 2000, 5000), tool("b", 3000, 8000)], [{ type: "tool_result", tool_use_id: "a", content: "failed", is_error: true }, tool("c", 11000, 12000)]]);
  assert.deepEqual(metrics, { calls: 4, errors: 1, timedCalls: 4, activeMs: 10000 });
});

test("missing or reversed tool intervals are not treated as zero-duration observations", () => {
  assert.deepEqual(collectToolMetrics([[tool("a"), tool("b", 2000, 1000)]]), { calls: 2, errors: 0, timedCalls: 0, activeMs: null });
  assert.deepEqual(collectToolMetrics([]), { calls: 0, errors: 0, timedCalls: 0, activeMs: 0 });
});

test("summary readers reject corrupt and unsupported schemas", () => {
  assert.equal(readTurnMetrics({ metrics: { version: 99 } }), null);
  assert.equal(readTurnMetrics({ metrics: { version: 1, retryCount: -1 } }), null);
  assert.equal(readSessionStats({ stats: { version: 1 } }), null);
  const stats: SessionStats = { version: 1, updatedAt: "2026-09-30T00:00:00Z", revision: 1, own: emptyExecutionStats(), inherited: emptyExecutionStats(), auxiliaryUsage: null };
  assert.deepEqual(readSessionStats({ stats }), stats);
});
