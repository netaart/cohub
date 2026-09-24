import assert from "node:assert/strict";
import { test } from "node:test";
import { piTranslator } from "../src/runtime/native/translate.js";

test("Pi live translation drops tool results without a call", () => {
  const translator = piTranslator(() => undefined);
  const call = { type: "toolCall", id: "call", name: "bash", arguments: {} };
  translator.push({ type: "message_start", message: { role: "assistant" } });
  translator.push({ type: "message_end", message: { role: "assistant", content: [call, { ...call, id: "nameless", name: "" }] } });
  translator.push({ type: "turn_end", message: { role: "assistant", content: [call] }, toolResults: [{ toolCallId: "call", content: "ok" }, { toolCallId: "nameless", content: "orphan" }, { toolCallId: "", content: "empty" }] });
  assert.deepEqual(translator.last().content.map((block) => block.type), ["tool_use", "tool_result"]);
});
