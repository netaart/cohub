import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_COMPACTION_SETTINGS, type AgentMessage } from "@earendil-works/pi-agent-core";
import type { Models } from "@earendil-works/pi-ai";
import { outlineOmittedMessages, projectForSummary, summarizeForCompaction } from "../runtime/compaction-summary.js";
import { getContextTokenBudget, parseOverflowTokens, resetTokenRatios } from "../runtime/token-calibration.js";

const zeroUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };

function transcript(turns: number): AgentMessage[] {
  return Array.from({ length: turns }, (_, i) => [
    { role: "user", content: [{ type: "text", text: `request ${i} ${"u".repeat(2_000)}` }], timestamp: i },
    {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "t".repeat(20_000) },
        { type: "toolCall", id: `c${i}`, name: "bash", arguments: { command: "x".repeat(10_000) } },
      ],
      api: "anthropic-messages", provider: "test", model: "m", usage: zeroUsage, stopReason: "toolUse", timestamp: i,
    },
    { role: "toolResult", toolCallId: `c${i}`, toolName: "bash", content: [{ type: "text", text: "r".repeat(30_000) }], isError: false, timestamp: i },
  ]).flat() as AgentMessage[];
}

function fakeModels(limit: number, charsPerToken: number, reportCount = true, failOnce?: (text: string) => boolean, fullOutput = false) {
  const requests: number[] = [];
  let failed = false;
  const models = {
    async completeSimple(_model: unknown, ctx: { systemPrompt?: string; messages: Array<{ content: Array<{ text?: string }> }> }, options: { maxTokens?: number }) {
      const chars = (ctx.systemPrompt?.length ?? 0) + ctx.messages.flatMap((m) => m.content).reduce((n, b) => n + (b.text?.length ?? 0), 0);
      const tokens = Math.ceil(chars / charsPerToken);
      requests.push(tokens);
      const base = { role: "assistant", api: "anthropic-messages", provider: "test", model: "m", timestamp: 0 };
      const text = ctx.messages.flatMap((m) => m.content).map((b) => b.text ?? "").join("");
      if (!failed && failOnce?.(text)) {
        failed = true;
        return { ...base, content: [], usage: zeroUsage, stopReason: "error", errorMessage: "503 service unavailable" };
      }
      if (tokens + (options.maxTokens ?? 0) > limit) {
        const errorMessage = reportCount ? `400 prompt is too long: ${tokens} tokens \\u003e ${limit} maximum` : "400 prompt is too long";
        return { ...base, content: [], usage: zeroUsage, stopReason: "error", errorMessage };
      }
      const summary = fullOutput ? "w".repeat((options.maxTokens ?? 0) * 4) : `summary ${requests.length}`;
      return { ...base, content: [{ type: "text", text: summary }], usage: { ...zeroUsage, input: tokens }, stopReason: "stop" };
    },
  };
  return { models: models as unknown as Models, requests };
}

function preparation(messages: AgentMessage[], extra: { turnPrefixMessages?: AgentMessage[]; previousSummary?: string } = {}) {
  return {
    messagesToSummarize: messages,
    turnPrefixMessages: extra.turnPrefixMessages ?? [],
    retainedTail: [],
    isSplitTurn: Boolean(extra.turnPrefixMessages?.length),
    previousSummary: extra.previousSummary,
    tokensBefore: 0,
    fileOps: { read: new Set<string>(), written: new Set<string>(), edited: new Set<string>() },
    settings: { ...DEFAULT_COMPACTION_SETTINGS, reserveTokens: 4_096 },
  };
}

const model = (contextWindow: number) => ({ provider: "test", id: "m", api: "anthropic-messages", contextWindow, maxTokens: 8_192, reasoning: false }) as never;

test.beforeEach(() => resetTokenRatios());

test("summary projection drops thinking and bounds tool payloads", () => {
  const projected = JSON.stringify(projectForSummary(transcript(1)));
  assert.ok(!projected.includes("t".repeat(100)));
  assert.ok(projected.length < 8_000);
});

test("parses nested overflow errors", () => {
  const message = String.raw`400 {"error":{"message":"{\"error\":{\"message\":\"prompt is too long: 1106472 tokens \\u003e 1000000 maximum (request id: 2026)\"}}"}}`;
  assert.deepEqual(parseOverflowTokens(message), { actual: 1_106_472, limit: 1_000_000 });
  assert.deepEqual(parseOverflowTokens("输入Tokens数量(320000)超过系统限制(262144)"), { actual: 320_000, limit: 262_144 });
});

test("history larger than the summarizer window is folded in bounded requests", async () => {
  const { models, requests } = fakeModels(60_000, 1.5);
  const outcome = await summarizeForCompaction({ preparation: preparation(transcript(40)), models, model: model(60_000) });
  assert.ok(outcome.result.ok);
  assert.ok(outcome.stats.chunks > 0);
  assert.equal(outcome.stats.omittedMessages, 0);
  assert.ok(requests.filter((tokens) => tokens + 3_276 > 60_000).length <= 1);
});

test("overflow without token counts still shrinks every retry", async () => {
  const { models, requests } = fakeModels(20_000, 1.5, false);
  const outcome = await summarizeForCompaction({ preparation: preparation(transcript(10)), models, model: model(1_000_000) });
  assert.ok(outcome.result.ok);
  const failed = requests.filter((tokens) => tokens + 3_276 > 20_000);
  for (let i = 1; i < failed.length; i++) assert.ok((failed[i] ?? 0) < (failed[i - 1] ?? 0));
});

test("long history is folded without omitting anything when every request fits", async () => {
  const { models } = fakeModels(20_000, 1.5);
  const outcome = await summarizeForCompaction({ preparation: preparation(transcript(80)), models, model: model(20_000) });
  assert.ok(outcome.result.ok);
  assert.ok(outcome.stats.chunks > 8);
  assert.equal(outcome.stats.omittedMessages, 0);
});

test("a previous summary that crowds out history is folded in full, not cut", async () => {
  const seen: string[] = [];
  const { models } = fakeModels(32_000, 4, true, (text) => {
    seen.push(text);
    return false;
  });
  const previousSummary = `${"s".repeat(75_000)}\nCRITICAL-REQUIREMENT\n${"s".repeat(75_000)}`;
  const outcome = await summarizeForCompaction({ preparation: preparation(transcript(1), { previousSummary }), models, model: model(32_000) });
  assert.ok(outcome.result.ok);
  assert.equal(outcome.stats.previousSummary, "folded");
  assert.equal(outcome.stats.omittedMessages, 0);
  assert.ok(seen.some((text) => text.includes("CRITICAL-REQUIREMENT")));
});

test("a previous summary that fits keeps the single compact request", async () => {
  const { models, requests } = fakeModels(60_000, 4);
  const prep = preparation(transcript(1), { previousSummary: "s".repeat(80_000) });
  const outcome = await summarizeForCompaction({ preparation: prep, models, model: model(60_000) });
  assert.ok(outcome.result.ok);
  assert.equal(requests.length, 1);
});

test("non-context errors while folding a previous summary keep the error flow", async () => {
  const failing = {
    async completeSimple() {
      return { role: "assistant", content: [], api: "x", provider: "test", model: "m", usage: zeroUsage, stopReason: "error", errorMessage: "401 invalid API key", timestamp: 0 };
    },
  } as unknown as Models;
  const prep = preparation(transcript(1), { previousSummary: "s".repeat(150_000) });
  const outcome = await summarizeForCompaction({ preparation: prep, models: failing, model: model(32_000) });
  assert.equal(outcome.result.ok, false);
});

test("unknown-size overflow on a tiny window ends in the omission fallback", async () => {
  const { models } = fakeModels(8_000, 1, false);
  const message = [{ role: "user", content: [{ type: "text", text: "x".repeat(20_000) }], timestamp: 0 }] as AgentMessage[];
  const prep = { ...preparation(message), settings: { ...DEFAULT_COMPACTION_SETTINGS, reserveTokens: 2_000 } };
  prep.fileOps.read.add("/workspace/a.ts");
  const outcome = await summarizeForCompaction({ preparation: prep, models, model: model(8_000) });
  assert.ok(outcome.result.ok);
  assert.ok(outcome.result.value.summary.includes("## Omitted History"));
  assert.ok(outcome.result.value.summary.includes("<read-files>\n/workspace/a.ts\n</read-files>"));
});

test("an oversized assistant message keeps its role when shrunk", async () => {
  const seen: string[] = [];
  const { models } = fakeModels(1_000_000, 4, true, (text) => {
    seen.push(text);
    return false;
  });
  const calls = Array.from({ length: 200 }, (_, i) => ({ type: "toolCall", id: `c${i}`, name: "bash", arguments: { command: "x".repeat(2_000) } }));
  const message = [{ role: "assistant", content: calls, api: "x", provider: "test", model: "m", usage: zeroUsage, stopReason: "toolUse", timestamp: 0 }] as AgentMessage[];
  const outcome = await summarizeForCompaction({ preparation: preparation(message), models, model: model(40_000) });
  assert.ok(outcome.result.ok);
  assert.ok(seen.some((text) => text.includes("[Assistant")));
  assert.ok(!seen.some((text) => text.includes("[User]: [Assistant")));
});

test("an overflowing split-turn prefix is never resent unchanged", async () => {
  const { models, requests } = fakeModels(20_000, 1.5, false);
  const prefix = [0, 1].map((i) => ({ role: "user", content: [{ type: "text", text: `${i}${"p".repeat(20_000)}` }], timestamp: i })) as AgentMessage[];
  const prep = preparation(transcript(4), { turnPrefixMessages: prefix });
  const outcome = await summarizeForCompaction({ preparation: prep, models, model: model(1_000_000) });
  assert.ok(outcome.result.ok);
  const failed = requests.filter((tokens) => tokens + 3_276 > 20_000);
  assert.ok(failed.length > 0);
  assert.equal(new Set(failed).size, failed.length);
});

test("a transient prefix failure retries only that call", async () => {
  const { models, requests } = fakeModels(1_000_000, 4, true, (text) => text.includes("PREFIX of a turn"));
  const prep = preparation(transcript(1), { turnPrefixMessages: transcript(1) });
  const outcome = await summarizeForCompaction({ preparation: prep, models, model: model(1_000_000) });
  assert.ok(outcome.result.ok);
  assert.equal(requests.length, 3);
});

test("the omission outline keeps every turn by grouping instead of cutting", () => {
  const messages = Array.from({ length: 400 }, (_, i) => [
    { role: "user", content: [{ type: "text", text: `turn ${i} ${"h".repeat(300)}` }], timestamp: i },
    { role: "assistant", content: [{ type: "toolCall", id: `c${i}`, name: `tool${i}`, arguments: {} }], api: "x", provider: "test", model: "m", usage: zeroUsage, stopReason: "toolUse", timestamp: i },
  ]).flat() as never;
  const outline = outlineOmittedMessages(messages);
  assert.ok(outline.length < 12_000);
  assert.ok(outline.includes("tool0") && outline.includes("tool399"));
  assert.ok(!outline.includes("characters omitted"));
});

test("trailing messages use the ratio learned in the same check", () => {
  const assistant = { role: "assistant", content: [{ type: "text", text: "a".repeat(160_000) }], provider: "test", model: "m", usage: { ...zeroUsage, totalTokens: 80_000 }, stopReason: "stop", timestamp: 1 };
  const trailing = { role: "user", content: [{ type: "text", text: "b".repeat(120_000) }], timestamp: 2 };
  const messages = [assistant, trailing] as never;
  const budget = getContextTokenBudget(messages, { provider: "test", id: "m" }, 1, 70_000);
  assert.equal(budget?.estimatedTokens, 80_000 + Math.ceil(30_000 * (80_000 / 40_000)));
});

test("a large previous summary on a small window is folded to the end", async () => {
  const { models } = fakeModels(8_000, 4);
  const prep = { ...preparation(transcript(1), { previousSummary: "s".repeat(150_000) }), settings: { ...DEFAULT_COMPACTION_SETTINGS, reserveTokens: 2_000 } };
  const outcome = await summarizeForCompaction({ preparation: prep, models, model: model(8_000) });
  assert.ok(outcome.result.ok);
  assert.equal(outcome.stats.omittedMessages, 0);
});

test("full-length fold summaries still leave room for the remaining history", async () => {
  const { models } = fakeModels(32_000, 1.5, true, undefined, true);
  const prep = { ...preparation(transcript(30)), settings: { ...DEFAULT_COMPACTION_SETTINGS, reserveTokens: 8_192 } };
  const outcome = await summarizeForCompaction({ preparation: prep, models, model: model(32_000) });
  assert.ok(outcome.result.ok);
  assert.equal(outcome.stats.omittedMessages, 0);
});
