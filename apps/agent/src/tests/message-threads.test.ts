import assert from "node:assert/strict";
import test from "node:test";
import type { Api, Context, Model } from "@earendil-works/pi-ai";
import { resolveRuntimeModelsConfig, type ModelsConfig } from "@cohub/infra/config-runtime/models";
import { CohubModelRegistry } from "../runtime/model-registry.js";
import { createModelsFromRegistry, streamSimpleWithModels } from "../runtime/pi-models-adapter.js";

process.env.TEST_MESSAGE_THREADS_API_KEY = "sk-test";
const config: ModelsConfig = {
  providers: {
    anthropic: {
      baseUrl: "https://api.anthropic.com",
      apiKey: "TEST_MESSAGE_THREADS_API_KEY",
      api: "anthropic-messages",
      models: [{ id: "claude-default" }, { id: "claude-threads", compat: { supportsMessageThreads: true } }],
    },
  },
};
const registry = new CohubModelRegistry({ configs: [resolveRuntimeModelsConfig({ platform: config })] });
const context: Context = { messages: [{ role: "user", content: "hi", timestamp: 1 }] };

/** The first request a session sends; the stubbed upstream rejects it, which ends the stream. */
async function firstRequest(modelId: string) {
  const model = registry.find("anthropic", modelId) as Model<Api>;
  assert.ok(model);
  let sent: { body: Record<string, unknown>; beta: string } | undefined;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_input, init) => {
    sent ??= { body: JSON.parse(String(init?.body)), beta: new Headers(init?.headers).get("anthropic-beta") ?? "" };
    return new Response(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "stop" } }), { status: 400, headers: { "content-type": "application/json" } });
  };
  try {
    const stream = streamSimpleWithModels(createModelsFromRegistry(registry, model), model, context, { sessionId: `session-${modelId}`, maxRetries: 0 });
    for await (const event of stream) if (event.type === "done" || event.type === "error") break;
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.ok(sent, "no request sent");
  return sent;
}

test("Anthropic requests stay whole unless a model opts into message threads", async () => {
  const plain = await firstRequest("claude-default");
  assert.equal("thread" in plain.body, false);
  assert.doesNotMatch(plain.beta, /message-threads/);

  const threaded = await firstRequest("claude-threads");
  assert.ok("thread" in threaded.body);
  assert.match(threaded.beta, /message-threads/);
});
