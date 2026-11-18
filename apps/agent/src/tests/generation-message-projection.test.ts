import assert from "node:assert/strict";
import test from "node:test";
import { estimateContextTokens } from "../runtime/pi-compaction.js";
import { projectGenerationSessionMessage } from "../generation-message-projection.js";

const createdAt = new Date("2026-08-18T00:00:00.000Z");

test("projects generation results as complete assistant messages", () => {
  const message = projectGenerationSessionMessage({
    id: "message-1",
    turnId: "turn-1",
    role: "assistant",
    content: [
      { type: "text", text: "{\"type\":\"generation.result\"}" },
      { type: "image", source: { type: "url", url: "https://example.com/output.png" } },
    ],
    provider: null,
    model: "image-model",
    meta: { provider: "openai.images", generationTaskId: "task-1" },
    createdAt,
  });

  assert.equal(message.role, "assistant");
  if (message.role !== "assistant") return;
  assert.equal(message.api, "generation");
  assert.equal(message.provider, "openai.images");
  assert.equal(message.model, "image-model");
  assert.equal(message.usage.totalTokens, 0);
  assert.equal(message.stopReason, "stop");
  assert.deepEqual(message.content, [{ type: "text", text: "{\"type\":\"generation.result\"}" }]);
  assert.doesNotThrow(() => estimateContextTokens([message]));
});

test("projects failed generation results as assistant errors", () => {
  const message = projectGenerationSessionMessage({
    id: "message-failed",
    turnId: "turn-failed",
    role: "assistant",
    content: [{
      type: "text",
      text: JSON.stringify({
        type: "generation.result",
        status: "failed",
        error: { code: "generation_failed", message: "Image generation failed." },
      }),
    }],
    provider: "openai.images",
    model: "image-model",
    meta: { generationStatus: "failed", generationTaskId: "task-failed" },
    createdAt,
  });

  assert.equal(message.role, "assistant");
  if (message.role !== "assistant") return;
  assert.equal(message.stopReason, "error");
  assert.equal(message.errorMessage, "Image generation failed.");
});

test("rejects invalid generation roles and content blocks", () => {
  const base = {
    id: "message-invalid",
    turnId: "turn-invalid",
    content: [{ type: "text", text: "hello" }],
    provider: null,
    model: null,
    meta: null,
    createdAt,
  };

  assert.throws(
    () => projectGenerationSessionMessage({ ...base, role: "toolResult" }),
    /Invalid generation message role/,
  );
  assert.throws(
    () => projectGenerationSessionMessage({ ...base, role: "user", content: [{ type: "text" }] }),
    /Invalid generation text block/,
  );
  assert.throws(
    () => projectGenerationSessionMessage({ ...base, role: "user", content: [{ type: "image", source: {} }] }),
    /Invalid image content/,
  );
});

test("falls back from an invalid generation timestamp", () => {
  const before = Date.now();
  const message = projectGenerationSessionMessage({
    id: "message-invalid-date",
    turnId: null,
    role: "user",
    content: [{ type: "text", text: "hello" }],
    provider: null,
    model: null,
    meta: null,
    createdAt: new Date(Number.NaN),
  });

  assert.ok(message.timestamp >= before && message.timestamp <= Date.now());
});

test("preserves generation request images in user messages", () => {
  const content = [
    { type: "text" as const, text: "create an image" },
    { type: "image" as const, source: { type: "url" as const, url: "https://example.com/input.png" } },
  ];
  const message = projectGenerationSessionMessage({
    id: "message-2",
    turnId: "turn-2",
    role: "user",
    content,
    provider: null,
    model: null,
    meta: { generationTaskId: "task-2" },
    createdAt,
  });

  assert.equal(message.role, "user");
  assert.deepEqual(message.content, content);
  assert.doesNotThrow(() => estimateContextTokens([message]));
});
