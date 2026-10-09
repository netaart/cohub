import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "@earendil-works/pi-agent-core";
import type { Context } from "@earendil-works/pi-ai";
import type { ModelsConfig } from "@cohub/infra/config-runtime/models";
import { CohubModelRegistry } from "../runtime/model-registry.js";
import { SessionManager } from "../runtime/local-session-manager.js";
import { createModelsFromRegistry, streamSimpleWithModels } from "../runtime/pi-models-adapter.js";

process.env.TEST_CODEX_API_KEY = "test-key";

const sessionId = "cohub-session-id";
const threadId = "cohub-child-session-id";
const config: ModelsConfig = {
  providers: {
    test: {
      api: "openai-responses",
      baseUrl: "https://example.test/v1",
      apiKey: "TEST_CODEX_API_KEY",
      models: [
        {
          id: "gpt-test",
          reasoning: true,
          requestProfile: "codex",
          compat: { sessionAffinityFormat: "openai-nosession" },
          headers: {
            Originator: "codex_cli_rs",
            "User-Agent": "codex_cli_rs/test",
          },
        },
      ],
    },
  },
};

const modelRegistry = new CohubModelRegistry({ configs: [config] });
const model = modelRegistry.find("test", "gpt-test");
assert.ok(model);

let capturedHeaders: Headers | undefined;
let capturedBody: Record<string, unknown> | undefined;
const originalFetch = globalThis.fetch;
globalThis.fetch = async (_input, init) => {
  capturedHeaders = new Headers(init?.headers);
  capturedBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
  return new Response("data: [DONE]\n\n", {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
};

try {
  const models = createModelsFromRegistry(modelRegistry, model);
  const context: Context = { systemPrompt: "test", messages: [] };
  const stream = streamSimpleWithModels(
    models,
    model,
    context,
    { sessionId, threadId },
  );
  for await (const event of stream) {
    if (event.type === "done" || event.type === "error") break;
  }

  assert.equal(capturedHeaders?.get("session-id"), sessionId);
  assert.equal(capturedHeaders?.get("thread-id"), threadId);
  assert.equal(capturedHeaders?.get("x-client-request-id"), sessionId);
  assert.equal(capturedHeaders?.get("session_id"), null);
  assert.equal(capturedHeaders?.get("originator"), "codex_cli_rs");
  assert.equal(capturedHeaders?.get("user-agent"), "codex_cli_rs/test");
  assert.equal(capturedBody?.prompt_cache_key, sessionId);
} finally {
  globalThis.fetch = originalFetch;
}

const root = await mkdtemp(join(tmpdir(), "cohub-codex-profile-"));
try {
  const sessionManager = SessionManager.create(root, join(root, "sessions"));
  sessionManager.newSession({ id: sessionId });

  const affinity = sessionManager.getSessionAffinity();
  const agent = new Agent({
    sessionId: affinity.sessionId,
    streamFn: () => {
      throw new Error("stream should not be called");
    },
  });

  assert.deepEqual(affinity, { sessionId, threadId: sessionId });
  assert.equal(agent.sessionId, sessionId);
} finally {
  await rm(root, { recursive: true, force: true });
}
