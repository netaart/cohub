import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import test from "node:test";
import { Type, type Context } from "@earendil-works/pi-ai";
import { resolveRuntimeModelsConfig, type ModelsConfig } from "@cohub/infra/config-runtime/models";
import { CohubModelRegistry } from "../runtime/model-registry.js";
import { createModelsFromRegistry, streamSimpleWithModels } from "../runtime/pi-models-adapter.js";

/**
 * Golden provider requests: what Cohub sends upstream for one context, per API.
 * A pi upgrade that changes a request fails here; review the fixture diff and
 * regenerate it with UPDATE_REQUEST_SNAPSHOTS=1.
 */
const FIXTURE = new URL("./fixtures/provider-requests.json", import.meta.url);

process.env.TEST_SNAPSHOT_API_KEY = "sk-test";
const provider = { baseUrl: "https://upstream.test/v1", apiKey: "TEST_SNAPSHOT_API_KEY" };
const config: ModelsConfig = {
  providers: {
    anthropic: { ...provider, api: "anthropic-messages", requestProfile: "claude-code", models: [{ id: "claude-opus-5-5", reasoning: true, compat: { forceAdaptiveThinking: true } }] },
    completions: {
      ...provider,
      api: "openai-completions",
      models: [{ id: "deepseek-flash", reasoning: true, compat: { supportsDeveloperRole: false, thinkingFormat: "deepseek", supportsReasoningEffort: true, requiresReasoningContentOnAssistantMessages: true } }],
    },
    codex: {
      ...provider,
      api: "openai-responses",
      models: [{ id: "gpt-5.6-sol", reasoning: true, requestProfile: "codex", compat: { sessionAffinityFormat: "openai-nosession" }, headers: { Originator: "codex_cli_rs", "User-Agent": "codex_cli_rs/test" } }],
    },
    google: { ...provider, api: "google-generative-ai", models: [{ id: "gemini-3.8-flash", reasoning: true, compat: { supportsDeveloperRole: false } }] },
  },
};

const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const context: Context = {
  systemPrompt: "SYSTEM PROMPT",
  tools: [{
    name: "echo",
    description: "Echo the input",
    parameters: Type.Object({ text: Type.String(), count: Type.Optional(Type.Number()) }),
  }],
  messages: [
    { role: "user", content: [{ type: "text", text: "hi" }], timestamp: 1 },
    { role: "assistant", content: [{ type: "text", text: "calling" }, { type: "toolCall", id: "call_1", name: "echo", arguments: { text: "x" } }], api: "anthropic-messages", provider: "anthropic", model: "m", usage, stopReason: "toolUse", timestamp: 2 },
    { role: "toolResult", toolCallId: "call_1", toolName: "echo", content: [{ type: "text", text: "x" }], isError: false, timestamp: 3 },
    { role: "user", content: [{ type: "text", text: "again" }], timestamp: 4 },
  ],
};

/** Headers that vary by host or SDK patch version, not by request semantics. */
const VOLATILE_HEADERS = /^(x-stainless-(os|arch|runtime-version|package-version|retry-count|timeout)|x-goog-api-client)$/;

function normalizeHeaders(headers: Headers): Record<string, string> {
  const entries = [...headers.entries()]
    .filter(([name]) => !VOLATILE_HEADERS.test(name))
    .map(([name, value]): [string, string] => [name, name === "user-agent" ? value.replace(/^pi \(.*\)$/, "pi (<host>)") : value]);
  return Object.fromEntries(entries.sort(([a], [b]) => a.localeCompare(b)));
}

async function captureRequests() {
  const registry = new CohubModelRegistry({ configs: [resolveRuntimeModelsConfig({ platform: config })] });
  const captured: Record<string, unknown> = {};
  let current: { url: string; headers: Record<string, string>; body: unknown } | undefined;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    current ??= {
      url: String(input instanceof Request ? input.url : input),
      headers: normalizeHeaders(new Headers(init?.headers)),
      body: JSON.parse(String(init?.body)),
    };
    return new Response(JSON.stringify({ error: { message: "stop", type: "invalid_request_error" } }), { status: 400, headers: { "content-type": "application/json" } });
  };
  try {
    for (const model of registry.getAvailable()) {
      current = undefined;
      const stream = streamSimpleWithModels(createModelsFromRegistry(registry, model), model, context, {
        reasoning: "high",
        sessionId: "session-1",
        headers: { "x-trace": "1" },
        maxRetries: 0,
      });
      for await (const event of stream) if (event.type === "done" || event.type === "error") break;
      captured[`${model.api} ${model.id}`] = current ?? null;
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
  return captured;
}

test("provider requests match the golden snapshot", async () => {
  const actual = await captureRequests();
  if (process.env.UPDATE_REQUEST_SNAPSHOTS === "1") {
    await writeFile(FIXTURE, `${JSON.stringify(actual, null, 2)}\n`);
  }
  const expected: unknown = JSON.parse(await readFile(FIXTURE, "utf8"));
  assert.deepEqual(actual, expected);
});
