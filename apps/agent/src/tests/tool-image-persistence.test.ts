import assert from "node:assert/strict";
import { test } from "node:test";
import { urlToPiImage } from "@cohub/model-runtime/image-content";
import { normalizeAssistantTurn } from "../assistant-message-normalizer.js";

test("mixed tool image results persist actual URLs alongside their text", () => {
  const url = "https://assets.test/chat-attachments/resized.png";
  const result = normalizeAssistantTurn({ content: [{ type: "toolCall", id: "read-image", name: "read", arguments: { path: "image.png" } }] }, [{
    toolCallId: "read-image", toolName: "read", content: [{ type: "text", text: "Read image file [image/png]" }, urlToPiImage(url)], isError: false,
  }]);
  const toolResult = result.content.find((block) => block.type === "tool_result");
  assert.equal(toolResult?.type, "tool_result");
  assert.deepEqual(toolResult.content, [{ type: "text", text: "Read image file [image/png]" }, { type: "image", source: { type: "url", url } }]);
  assert(!JSON.stringify(result.content).includes("application/x-cohub-image-url"));
});

test("legacy real base64 tool images also survive mixed-content persistence", () => {
  const result = normalizeAssistantTurn({ content: [{ type: "toolCall", id: "read-image", name: "read", arguments: {} }] }, [{
    toolCallId: "read-image", toolName: "read", content: [{ type: "text", text: "Image" }, { type: "image", mimeType: "image/png", data: "YWJj" }], isError: false,
  }]);
  const toolResult = result.content.find((block) => block.type === "tool_result");
  assert.equal(toolResult?.type, "tool_result");
  assert.deepEqual(toolResult.content, [{ type: "text", text: "Image" }, { type: "image", source: { type: "base64", media_type: "image/png", data: "YWJj" } }]);
});
