import assert from "node:assert/strict";
import test, { describe } from "node:test";
import { normalizeContext, type Api, type Context, type Model, type SimpleStreamOptions } from "@earendil-works/pi-ai";
import { googleGenerativeAIApi } from "@earendil-works/pi-ai/api/google-generative-ai.lazy";
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

describe("withGeminiThinkingLevel workaround", () => {
  test("pi-ai still sends thinkingBudget for Gemini 4", async () => {
    const body = await capturedBody(() =>
      googleGenerativeAIApi().streamSimple(findModel("gemini-4-argon"), normalizeContext(context), { apiKey: "sk-test", maxRetries: 0, reasoning: "high" }),
    );
    const { thinkingConfig: piThinkingConfig } = body.generationConfig as { thinkingConfig?: { thinkingBudget?: number } };
    assert.notEqual(
      piThinkingConfig?.thinkingBudget,
      undefined,
      "pi-ai now sends thinkingLevel for Gemini 4 (earendil-works/pi#10890). Delete packages/model-runtime/src/gemini-thinking-level.ts, " +
        "unwrap googleGenerativeAIApi() and googleVertexApi() in packages/model-runtime/src/pi-models-adapter.ts, and delete this block. " +
        "The other tests in this file must pass unchanged.",
    );
  });

  test("Gemini 4 keeps the caller's payload hook", async () => {
    const body = await sentBody("gemini-4-argon", {
      reasoning: "medium",
      onPayload: (payload) => {
        const params = payload as { config: Record<string, unknown> };
        return { ...params, config: { ...params.config, temperature: 0.5 } };
      },
    });
    assert.deepEqual(body.generationConfig, {
      temperature: 0.5,
      maxOutputTokens: 16384,
      thinkingConfig: { includeThoughts: true, thinkingLevel: "MEDIUM" },
    });
  });
});
