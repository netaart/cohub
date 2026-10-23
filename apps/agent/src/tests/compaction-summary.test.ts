import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_COMPACTION_SETTINGS, type AgentMessage } from "@earendil-works/pi-agent-core";
import type { Models } from "@earendil-works/pi-ai";
import { projectForSummary, summarizeForCompaction } from "../runtime/compaction-summary.js";
import { parseOverflowTokens, resetTokenRatios } from "../runtime/token-calibration.js";

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

function fakeModels(limit: number, charsPerToken: number, reportCount = true) {
  const requests: number[] = [];
  const models = {
    async completeSimple(_model: unknown, ctx: { systemPrompt?: string; messages: Array<{ content: Array<{ text?: string }> }> }, options: { maxTokens?: number }) {
      const chars = (ctx.systemPrompt?.length ?? 0) + ctx.messages.flatMap((m) => m.content).reduce((n, b) => n + (b.text?.length ?? 0), 0);
      const tokens = Math.ceil(chars / charsPerToken);
      requests.push(tokens);
      const base = { role: "assistant", api: "anthropic-messages", provider: "test", model: "m", timestamp: 0 };
      if (tokens + (options.maxTokens ?? 0) > limit) {
        const errorMessage = reportCount ? `400 prompt is too long: ${tokens} tokens \\u003e ${limit} maximum` : "400 prompt is too long";
        return { ...base, content: [], usage: zeroUsage, stopReason: "error", errorMessage };
      }
      return { ...base, content: [{ type: "text", text: `summary ${requests.length}` }], usage: { ...zeroUsage, input: tokens }, stopReason: "stop" };
    },
  };
  return { models: models as unknown as Models, requests };
}

function preparation(messages: AgentMessage[]) {
  return {
    messagesToSummarize: messages,
    turnPrefixMessages: [],
    retainedTail: [],
    isSplitTurn: false,
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
