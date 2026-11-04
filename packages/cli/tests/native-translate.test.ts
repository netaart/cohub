import assert from "node:assert/strict";
import { test } from "node:test";
import { forwardedEvent } from "../src/runtime/native/pi-extension.js";
import { piTranslator } from "../src/runtime/native/translate.js";

test("Pi live translation drops tool results without a call", () => {
  const translator = piTranslator(() => undefined);
  const call = { type: "toolCall", id: "call", name: "bash", arguments: {} };
  translator.push({ type: "message_start", message: { role: "assistant" } });
  translator.push({ type: "message_end", message: { role: "assistant", content: [call, { ...call, id: "nameless", name: "" }] } });
  translator.push({ type: "turn_end", message: { role: "assistant", content: [call] }, toolResults: [{ toolCallId: "call", content: "ok" }, { toolCallId: "nameless", content: "orphan" }, { toolCallId: "", content: "empty" }] });
  assert.deepEqual(translator.last().content.map((block) => block.type), ["tool_use", "tool_result"]);
});

test("Pi events reach the Runtime without their context, translated the same", () => {
  const message = { role: "assistant", content: [{ type: "text", text: "done" }, { type: "toolCall", id: "call", name: "bash", arguments: { command: "ls" } }], stopReason: "toolUse", provider: "p", model: "m" };
  const context = { contextEntries: [message], contextMessages: [message], llmMessages: [message] };
  const events = [
    { type: "message_start", message },
    { type: "message_update", message, assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "done" } },
    { type: "message_end", message },
    { type: "tool_execution_start", toolCallId: "call", toolName: "bash", args: { command: "ls" } },
    { type: "tool_execution_end", toolCallId: "call", toolName: "bash", result: { content: [{ type: "text", text: "ok" }] }, isError: false },
    { type: "turn_end", message, toolResults: [{ toolCallId: "call", content: "ok" }], context, ...context, entries: [message] },
    { type: "agent_end", messages: [message], willRetry: false },
  ];
  const run = (input: Array<Record<string, unknown>>) => {
    const emitted: unknown[] = [];
    const translator = piTranslator((event) => emitted.push(event));
    const ended = input.map((event) => translator.push(event));
    return { emitted, ended, last: translator.last() };
  };
  const forwarded = events.map((event) => forwardedEvent(event.type, event));
  assert.deepEqual(Object.keys(forwarded[5] ?? {}).sort(), ["message", "toolResults", "type"]);
  assert.deepEqual(forwarded[6], { type: "agent_end", willRetry: false });
  assert.deepEqual(run(forwarded), run(events));
  assert.equal(run(forwarded).last.stopReason, "tool_use");
});
