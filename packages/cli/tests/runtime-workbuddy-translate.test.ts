import assert from "node:assert/strict";
import { test } from "node:test";
import type { RuntimeExecutionEvent } from "@neta-art/cohub";
import { workbuddyTranslator } from "../src/runtime/native/workbuddy-translate.js";

test("WorkBuddy streams text and pairs tools without duplicating the final response", () => {
  const events: RuntimeExecutionEvent[] = [];
  const translator = workbuddyTranslator((event) => events.push(event));
  translator.push({ type: "system", subtype: "init", model: "example-model" });
  translator.push({ type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Checking" } } });
  translator.push({ type: "assistant", message: { content: [{ type: "text", text: "Checking" }, { type: "tool_use", id: "call-1", name: "Read", input: { path: "a.txt" } }] } });
  translator.push({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "call-1", content: "file contents" }] } });
  translator.push({ type: "assistant", message: { content: [{ type: "text", text: "Done" }] } });
  assert.equal(translator.push({ type: "result", subtype: "success", is_error: false, result: "Done", usage: { input_tokens: 4, output_tokens: 2, cache_read_input_tokens: 1 } }), true);
  assert.deepEqual(translator.last().content, [{ type: "text", text: "Done" }]);
  assert.equal(translator.last().model, "example-model");
  assert.equal(translator.last().ordinal, 1);
  assert.equal(translator.last().usage?.input, 4);
  const commits = events.filter((event) => event.type === "message.commit");
  assert.equal(commits.length, 1);
  assert.deepEqual(commits[0]?.message.content.at(-1), { type: "tool_result", tool_use_id: "call-1", content: "file contents", is_error: false });
  assert.ok(events.some((event) => event.type === "text.delta" && event.delta === "Checking"));
});

test("WorkBuddy accepts the native null optional cache counters", () => {
  const translator = workbuddyTranslator(() => {});
  translator.push({ type: "assistant", message: { content: [{ type: "text", text: "Done" }], usage: { input_tokens: 4, output_tokens: 2, cache_read_input_tokens: null, cache_creation_input_tokens: null } } });
  translator.push({ type: "result", subtype: "success", is_error: false, result: "Done", usage: { input_tokens: 4, output_tokens: 2, cache_read_input_tokens: null, cache_creation_input_tokens: null } });
  assert.deepEqual(translator.last().usage, { input: 4, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 6, cost: null });
  assert.throws(() => workbuddyTranslator(() => {}).push({ type: "result", subtype: "success", is_error: false, usage: { input_tokens: null } }), /Invalid WorkBuddy usage/);
});

test("WorkBuddy pairs parallel tool results with earlier messages and commits each once", () => {
  const events: RuntimeExecutionEvent[] = [];
  const translator = workbuddyTranslator((event) => events.push(event));
  for (const id of ["first", "second"]) translator.push({ type: "assistant", message: { content: [{ type: "tool_use", id, name: "Read", input: { path: id } }] } });
  assert.equal(events.filter((event) => event.type === "message.commit").length, 0);
  for (const id of ["second", "first"]) translator.push({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: id, content: id }] } });
  translator.push({ type: "assistant", message: { content: [{ type: "text", text: "Done" }] } });
  translator.push({ type: "result", subtype: "success", is_error: false, result: "Done" });
  const commits = events.filter((event) => event.type === "message.commit");
  assert.deepEqual(commits.map((event) => event.message.ordinal).sort(), [0, 1]);
  for (const event of commits) assert.equal(event.message.content.filter((block) => block.type === "tool_result").length, 1);
  assert.ok(events.some((event) => event.type === "content.replace" && event.ordinal === 0 && event.content.some((block) => block.type === "tool_result")));
});

test("WorkBuddy retains streamed text and reasoning when interrupted before the full message", () => {
  const translator = workbuddyTranslator(() => {});
  translator.push({ type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "First " } } });
  translator.push({ type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "thought" } } });
  translator.push({ type: "stream_event", event: { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "Partial answer" } } });
  assert.deepEqual(translator.last().content, [{ type: "thinking", thinking: "First thought" }, { type: "text", text: "Partial answer" }]);
});

test("WorkBuddy maps wire block indexes after a separately completed reasoning item", () => {
  const events: RuntimeExecutionEvent[] = [];
  const translator = workbuddyTranslator((event) => events.push(event));
  translator.push({ type: "assistant", message: { content: [{ type: "thinking", thinking: "Thought" }] } });
  translator.push({ type: "stream_event", event: { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "Answer" } } });
  assert.deepEqual(translator.last().content, [{ type: "text", text: "Answer" }]);
  assert.ok(events.some((event) => event.type === "text.delta" && event.ordinal === 1 && event.index === 0));
});

test("WorkBuddy finishing an interrupted turn commits earlier pending tools once", () => {
  const events: RuntimeExecutionEvent[] = [];
  const translator = workbuddyTranslator((event) => events.push(event));
  translator.push({ type: "assistant", message: { content: [{ type: "tool_use", id: "pending", name: "Read", input: {} }], stop_reason: "tool_use" } });
  translator.push({ type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Partial" } } });
  assert.equal(events.filter((event) => event.type === "message.commit").length, 0);
  translator.finish(); translator.finish();
  const commits = events.filter((event) => event.type === "message.commit");
  assert.equal(commits.length, 1);
  assert.equal(commits[0]?.message.stopReason, "tool_use");
  assert.deepEqual(commits[0]?.message.content, [{ type: "tool_use", id: "pending", name: "Read", input: {} }]);
  assert.deepEqual(translator.last().content, [{ type: "text", text: "Partial" }]);
});
