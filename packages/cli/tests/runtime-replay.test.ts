import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import type { RuntimeExecutionEvent, RuntimeMessage } from "@neta-art/cohub";
import type { JsonRecord } from "../src/runtime/json-rpc.js";
import { streamJsonTranslator } from "../src/runtime/harnesses/stream-json.js";

/** Frames a real Claude Code printed for each scenario (`pnpm --filter @neta-art/cohub-cli record:claude-replay`). */
const recorded = new Map<string, JsonRecord[]>();
for (const line of (await readFile(new URL("./fixtures/replay/claude.ndjson", import.meta.url), "utf8")).trim().split("\n")) {
  const { scenario, frame } = JSON.parse(line) as { scenario: string; frame: JsonRecord };
  recorded.set(scenario, [...recorded.get(scenario) ?? [], frame]);
}

function replay(scenario: string) {
  const turns: Array<{ events: RuntimeExecutionEvent[]; result: RuntimeMessage | null }> = [];
  let events: RuntimeExecutionEvent[] = [];
  let spent = 0;
  let translator = streamJsonTranslator((event) => events.push(event), { provider: "anthropic", model: null });
  for (const frame of recorded.get(scenario) ?? []) {
    if (!translator.push(frame)) continue;
    turns.push({ events, result: translator.result() });
    if (typeof frame.total_cost_usd === "number") spent = frame.total_cost_usd;
    events = [];
    translator = streamJsonTranslator((event) => events.push(event), { provider: "anthropic", model: null }, spent);
  }
  return turns;
}

const texts = (message: RuntimeMessage | null) => (message?.content ?? []).flatMap((block) => block.type === "text" ? [block.text] : []);

test("a recorded reply streams and ends with its text and usage", () => {
  const [turn, extra] = replay("text");
  assert.equal(extra, undefined);
  assert.deepEqual(texts(turn?.result ?? null), ["Hello from the fixture."]);
  assert.equal(turn?.result?.stopReason, "stop");
  assert.equal(turn?.result?.usage?.input, 10);
  assert(turn?.events.some((event) => event.type === "text.delta"));
});

test("one process answers Turns one after another, each charged only its own cost", () => {
  const turns = replay("turns");
  assert.deepEqual(turns.map((turn) => texts(turn.result)), [["First answer."], ["Second answer."]]);
  const [first, second] = turns.map((turn) => turn.result?.usage?.cost?.total ?? 0);
  assert(first && second && Math.abs(first - second) < 1e-12, "the second Turn is charged what it cost, not the process total");
});

test("a recorded usage limit fails the Turn as a usage limit", () => {
  const [turn] = replay("usage_limit");
  assert.equal(turn?.result?.stopReason, "error");
  assert.match(turn?.result?.errorMessage ?? "", /429/);
  assert.deepEqual(turn?.result?.usageLimit, { resetAt: null });
});
