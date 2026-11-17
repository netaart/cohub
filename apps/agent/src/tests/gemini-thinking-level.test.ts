import assert from "node:assert/strict";
import test from "node:test";
import type { Api, Context, Model, SimpleStreamOptions } from "@earendil-works/pi-ai";
import { resolveRuntimeModelsConfig, type ModelsConfig } from "@cohub/infra/config-runtime/models";
import { CohubModelRegistry } from "../runtime/model-registry.js";
import { createModelsFromRegistry, streamSimpleWithModels } from "../runtime/pi-models-adapter.js";

process.env.TEST_GEMINI_API_KEY = "sk-test";
const config: ModelsConfig = {
  providers: {
    google: {
      baseUrl: "https://upstream.test/v1",
      apiKey: "TEST_GEMINI_API_KEY",
      api: "google-generative-ai",
      models: [
        { id: "gemini-4-argon", reasoning: true, thinkingLevelMap: { off: null, minimal: null, low: "low", medium: "medium", high: "high", xhigh: null, max: null } },
        { id: "gemini-2.5-flash", reasoning: true },
      ],
    },
  },
};
const registry = new CohubModelRegistry({ configs: [resolveRuntimeModelsConfig({ platform: config })] });
const context: Context = { messages: [{ role: "user", content: "hi", timestamp: 1 }] };

function findModel(modelId: string): Model<Api> {
  const model = registry.find("google", modelId);
  assert.ok(model);
  return model;
}

/** The first request body a stream sends; the stubbed upstream rejects it, which ends the stream. */
async function capturedBody(start: () => AsyncIterable<{ type: string }>) {
  let body: Record<string, unknown> | undefined;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_input, init) => {
    body ??= JSON.parse(String(init?.body));
    return new Response(JSON.stringify({ error: { message: "stop" } }), { status: 400, headers: { "content-type": "application/json" } });
  };
  try {
    for await (const event of start()) if (event.type === "done" || event.type === "error") break;
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.ok(body, "no request sent");
  return body;
}

function sentBody(modelId: string, options: SimpleStreamOptions = {}) {
  const model = findModel(modelId);
  return capturedBody(() => streamSimpleWithModels(createModelsFromRegistry(registry, model), model, context, { maxRetries: 0, ...options }));
}

const thinkingConfig = async (modelId: string, options?: SimpleStreamOptions) =>
  ((await sentBody(modelId, options)).generationConfig as { thinkingConfig?: unknown }).thinkingConfig;

test("Gemini 4 sends the requested reasoning as thinkingLevel", async () => {
  assert.deepEqual(await thinkingConfig("gemini-4-argon", { reasoning: "low" }), { includeThoughts: true, thinkingLevel: "LOW" });
  assert.deepEqual(await thinkingConfig("gemini-4-argon", { reasoning: "medium" }), { includeThoughts: true, thinkingLevel: "MEDIUM" });
  assert.deepEqual(await thinkingConfig("gemini-4-argon", { reasoning: "high" }), { includeThoughts: true, thinkingLevel: "HIGH" });
  // Unsupported levels clamp like every other model.
  assert.deepEqual(await thinkingConfig("gemini-4-argon", { reasoning: "xhigh" }), { includeThoughts: true, thinkingLevel: "HIGH" });
  // Thinking cannot be disabled, so "off" uses the lowest supported level.
  assert.deepEqual(await thinkingConfig("gemini-4-argon"), { thinkingLevel: "LOW" });
});

test("Gemini 2.5 keeps its thinking budget", async () => {
  assert.deepEqual(await thinkingConfig("gemini-2.5-flash", { reasoning: "high" }), { includeThoughts: true, thinkingBudget: 24576 });
});
