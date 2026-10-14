import assert from "node:assert/strict";
import test from "node:test";
import type { SimpleStreamOptions } from "@earendil-works/pi-ai";
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
        { id: "gemini-3.8-flash", reasoning: true },
        { id: "gemini-2.5-flash", reasoning: true },
      ],
    },
  },
};
const registry = new CohubModelRegistry({ configs: [resolveRuntimeModelsConfig({ platform: config })] });

/** The request body Cohub sends for one model and set of options. */
async function sentBody(modelId: string, options: SimpleStreamOptions = {}) {
  const model = registry.find("google", modelId);
  assert.ok(model);
  let body: Record<string, unknown> | undefined;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_input, init) => {
    body ??= JSON.parse(String(init?.body));
    return new Response(JSON.stringify({ error: { message: "stop" } }), { status: 400, headers: { "content-type": "application/json" } });
  };
  try {
    const stream = streamSimpleWithModels(createModelsFromRegistry(registry, model), model, {
      messages: [{ role: "user", content: "hi", timestamp: 1 }],
    }, { maxRetries: 0, ...options });
    for await (const event of stream) if (event.type === "done" || event.type === "error") break;
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.ok(body, `no request sent for ${modelId}`);
  return body;
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

test("other Gemini generations keep pi-ai's thinking config", async () => {
  assert.deepEqual(await thinkingConfig("gemini-3.8-flash", { reasoning: "high" }), { includeThoughts: true, thinkingLevel: "HIGH" });
  assert.deepEqual(await thinkingConfig("gemini-2.5-flash", { reasoning: "high" }), { includeThoughts: true, thinkingBudget: 24576 });
  assert.deepEqual(await thinkingConfig("gemini-2.5-flash"), { thinkingBudget: 0 });
});
