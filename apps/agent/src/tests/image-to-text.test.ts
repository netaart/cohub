import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Api, Context, Model } from "@earendil-works/pi-ai";
import type { ImageToTextConfig } from "@cohub/infra/config-runtime/model-tasks";
import { SessionManager } from "../runtime/local-session-manager.js";
import { urlToPiImage } from "@cohub/model-runtime/image-content";

process.env.DATABASE_URL ??= "postgres://localhost/cohub_test";
process.env.APP_ENCRYPTION_KEY ??= "test-key";
process.env.SESSIONS_NAMESPACE ??= "test";

const config: ImageToTextConfig = {
  enabled: true,
  model: {
    provider: "cohub",
    id: "vlm",
    api: "openai-responses",
    baseUrl: "https://example.com/v1",
    apiKey: "VLM_API_KEY",
    reasoning: false,
    input: ["text", "image"],
  },
  prompt: "Describe the image.",
};

const textModel = { provider: "cohub", id: "text-model", input: ["text"] } as Model<Api>;

function createMessage(): AgentMessage {
  return {
    role: "user",
    content: [
      { type: "text", text: "Inspect this." },
      { type: "image", data: "aGVsbG8=", mimeType: "image/png" },
    ],
    timestamp: Date.now(),
    meta: { messageId: "message-u1", turnId: "turn-u1" },
  } as AgentMessage;
}

test("Agent projects JSONL sidecar descriptions while custom entries stay out of normal context", async () => {
  const { prepareAgentImagesForModel } = await import("../runtime/image-to-text.js");
  const sessionManager = SessionManager.create("/workspace", "/tmp");
  const message = createMessage();
  const sourceEntryId = sessionManager.appendMessage(message, { id: "entry-u1" });
  sessionManager.appendCustomEntry("image_description.v1", {
    sourceEntryId,
    imageIndex: 0,
    text: "A terminal displaying a build result.",
    provider: "cohub",
    model: "vlm",
    usage: { input: 10, output: 5, totalTokens: 15 },
    generatedAt: "2026-08-03T10:00:00.000Z",
  });

  assert.equal(sessionManager.buildSessionContext().messages.length, 1);
  const context = { systemPrompt: "", messages: [message] } as Context;
  const prepared = await prepareAgentImagesForModel({
    context,
    targetModel: textModel,
    config,
    sessionManager,
    sessionId: "session-1",
    executionTurnId: "turn-current",
  });

  assert.equal(prepared.calls.length, 0);
  const projectedContent = prepared.context.messages[0]?.content;
  const originalContent = context.messages[0]?.content;
  assert.ok(Array.isArray(projectedContent));
  assert.ok(Array.isArray(originalContent));
  assert.equal((projectedContent[1] as { type: string }).type, "text");
  assert.match((projectedContent[1] as { text: string }).text, /terminal displaying/);
  assert.equal((originalContent[1] as { type: string }).type, "image");
});

test("Agent projection keeps uncloneable tool references and does not mutate the original context", async () => {
  const { prepareAgentImagesForModel } = await import("../runtime/image-to-text.js");
  const sessionManager = SessionManager.create("/workspace", "/tmp");
  const message = createMessage();
  const sourceEntryId = sessionManager.appendMessage(message, { id: "entry-u2" });
  sessionManager.appendCustomEntry("image_description.v1", {
    sourceEntryId,
    imageIndex: 0,
    text: "A chart showing request latency.",
    provider: "cohub",
    model: "vlm",
    usage: { input: 8, output: 4, totalTokens: 12 },
    generatedAt: "2026-08-03T10:00:00.000Z",
  });

  const execute = async () => ({ content: [{ type: "text", text: "ok" }] });
  const tools = [{ name: "shell", description: "Run a command", parameters: {}, execute }];
  const context = { systemPrompt: "", messages: [message], tools } as unknown as Context;

  const prepared = await prepareAgentImagesForModel({
    context,
    targetModel: textModel,
    config,
    sessionManager,
    sessionId: "session-2",
    executionTurnId: "turn-current",
  });

  assert.equal(prepared.calls.length, 0);
  assert.equal(prepared.context.tools, tools, "tool references must be preserved");
  const projectedContent = prepared.context.messages[0]?.content;
  assert.ok(Array.isArray(projectedContent));
  assert.equal((projectedContent[1] as { type: string }).type, "text");
  assert.match((projectedContent[1] as { text: string }).text, /request latency/);

  const originalContent = context.messages[0]?.content;
  assert.ok(Array.isArray(originalContent));
  assert.equal((originalContent[1] as { type: string }).type, "image", "original context must stay untouched");
  assert.notEqual(projectedContent, originalContent);
});

test("cached URL and base64 image descriptions retain their source indexes", async () => {
  const { prepareAgentImagesForModel } = await import("../runtime/image-to-text.js");
  const manager = SessionManager.create("/workspace", "/tmp");
  const message = {
    role: "user" as const, timestamp: 0,
    content: [urlToPiImage("https://public.cohub.test/image.png"), { type: "image" as const, data: "aGVsbG8=", mimeType: "image/png" }],
    meta: { messageId: "mixed-images" },
  };
  const sourceEntryId = manager.appendMessage(message, { id: "mixed" });
  for (const [imageIndex, text] of ["Remote image description", "Inline image description"].entries()) {
    manager.appendCustomEntry("image_description.v1", { sourceEntryId, imageIndex, text });
  }
  const prepared = await prepareAgentImagesForModel({ context: { messages: [message] }, targetModel: textModel, config, sessionManager: manager, sessionId: "mixed" });
  assert.equal(prepared.calls.length, 0);
  const content = prepared.context.messages[0]?.content;
  assert(Array.isArray(content));
  assert(content[0]?.type === "text" && content[0].text.includes("Remote image description"));
  assert(content[1]?.type === "text" && content[1].text.includes("Inline image description"));
  assert.equal(message.content[0]?.type, "image");
});

test("a text-only model receives a new URL image description via Responses and reuses it", async (t) => {
  const { prepareAgentImagesForModel } = await import("../runtime/image-to-text.js");
  const url = "https://public.cohub.test/image.png";
  const manager = SessionManager.create("/workspace", "/tmp");
  const message = { role: "user" as const, content: [urlToPiImage(url)], timestamp: 0, meta: { messageId: "new-url" } };
  manager.appendMessage(message, { id: "new-url" });
  const requests: unknown[] = [];
  t.mock.method(globalThis, "fetch", async (_input: unknown, init?: RequestInit) => {
    requests.push(JSON.parse(String(init?.body)));
    const item = { type: "message", id: "description", role: "assistant", content: [{ type: "output_text", text: "A red square." }] };
    const events = [
      { type: "response.output_item.done", output_index: 0, item },
      { type: "response.completed", response: { id: "response", status: "completed", output: [item], usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 } } },
    ];
    return new Response(events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
  });
  const input = {
    context: { messages: [message] }, targetModel: textModel,
    config: { ...config, model: { ...config.model, apiKey: "test-api-key" } },
    sessionManager: manager, sessionId: "new-url", executionTurnId: "current",
  };
  const first = await prepareAgentImagesForModel(input);
  assert.equal(first.calls[0]?.status, "succeeded", first.calls[0]?.error ?? "No successful image description");
  assert.equal(first.calls[0]?.usage?.totalTokens, 15);
  const content = first.context.messages[0]?.content;
  assert(Array.isArray(content));
  assert(content[0]?.type === "text" && content[0].text.includes("A red square."));
  assert.equal(requests.length, 1);
  assert(JSON.stringify(requests[0]).includes(`"image_url":"${url}"`));
  assert(!JSON.stringify(requests[0]).includes("application/x-cohub-image-url"));
  assert.equal(manager.getCustomEntries("image_description.v1").length, 1);
  const second = await prepareAgentImagesForModel({ ...input, executionTurnId: "next" });
  assert.equal(second.calls.length, 0);
  assert.equal(requests.length, 1);
  assert.deepEqual(second.context.messages, first.context.messages);
  assert.equal(message.content[0]?.mimeType, "application/x-cohub-image-url");
});

test("stopping an image description propagates cancellation without persisting a failed description", async (t) => {
  const { prepareAgentImagesForModel } = await import("../runtime/image-to-text.js");
  const controller = new AbortController();
  const manager = SessionManager.create("/workspace", "/tmp");
  const message = { role: "user" as const, content: [urlToPiImage("https://assets.test/a.png")], timestamp: 0, meta: { messageId: "cancel-description" } };
  manager.appendMessage(message, { id: "cancel-description" });
  let markStarted: (() => void) | undefined;
  const started = new Promise<void>((resolve) => { markStarted = resolve; });
  t.mock.method(globalThis, "fetch", async (_url: unknown, init?: RequestInit) => {
    const signal = init?.signal;
    assert(signal);
    markStarted?.();
    return new Promise<Response>((_, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
  });
  const pending = prepareAgentImagesForModel({
    context: { messages: [message] }, targetModel: textModel,
    config: { ...config, model: { ...config.model, apiKey: "test-api-key" } },
    sessionManager: manager, sessionId: "cancel-description", executionTurnId: "cancel", signal: controller.signal,
  });
  await started;
  const reason = new Error("Stopped description");
  controller.abort(reason);
  await assert.rejects(pending, (error) => error === reason);
  assert.equal(manager.getCustomEntries("image_description.v1").length, 0);
  assert.equal(message.content[0]?.type, "image");
});
