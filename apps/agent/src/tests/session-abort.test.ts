import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { Type } from "@earendil-works/pi-ai";
import { resolveRuntimeModelsConfig, type ModelsConfig } from "@cohub/infra/config-runtime/models";
import { SessionManager } from "../runtime/local-session-manager.js";
import { CohubModelRegistry } from "../runtime/model-registry.js";

process.env.DATABASE_URL ??= "postgres://localhost/cohub_test";
process.env.APP_ENCRYPTION_KEY ??= "test-key";
process.env.SESSIONS_NAMESPACE ??= "test";
process.env.TEST_ABORT_API_KEY = "test-key";

const { createCohubAgentSession } = await import("../runtime/session-runtime.js");

const BASE_URL = "https://abort.test";
const config: ModelsConfig = {
  providers: {
    test: {
      api: "anthropic-messages",
      baseUrl: BASE_URL,
      apiKey: "TEST_ABORT_API_KEY",
      models: [{ id: "claude-sonnet-5", reasoning: true }],
    },
  },
};

const TOOL_CALL_REPLY = [
  { type: "message_start", message: { id: "msg_1", type: "message", role: "assistant", model: "m", content: [], stop_reason: null, usage: { input_tokens: 1, output_tokens: 0 } } },
  { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "toolu_1", name: "wait", input: {} } },
  { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: "{}" } },
  { type: "content_block_stop", index: 0 },
  { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 1 } },
  { type: "message_stop" },
].map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join("");

const root = await mkdtemp(join(tmpdir(), "cohub-agent-abort-"));
test.after(() => rm(root, { recursive: true, force: true }));

test("stopping a Turn while a tool runs ends the next round as aborted", async (t) => {
  // Test files share one process, so the fake upstream serves only this provider and lives only for this test.
  let upstreamRequests = 0;
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    if (!url.startsWith(BASE_URL)) return previousFetch(input, init);
    upstreamRequests += 1;
    return new Response(TOOL_CALL_REPLY, { status: 200, headers: { "content-type": "text/event-stream" } });
  };
  t.after(() => {
    globalThis.fetch = previousFetch;
  });

  const modelRegistry = new CohubModelRegistry({ configs: [resolveRuntimeModelsConfig({ platform: config })] });
  const model = modelRegistry.find("test", "claude-sonnet-5");
  assert.ok(model);
  const sessionManager = SessionManager.create(root, join(root, "sessions"));
  sessionManager.newSession({ id: "session-abort" });

  let stop: () => void = () => undefined;
  // The tool resolves only after the Turn signal fires, like a sandbox command that reports `[Command aborted.]`.
  const waitTool: AgentTool = {
    name: "wait",
    label: "wait",
    description: "wait until stopped",
    parameters: Type.Object({}),
    execute: async (_toolCallId, _params, signal) => {
      stop();
      if (!signal?.aborted) await new Promise((resolve) => signal?.addEventListener("abort", resolve, { once: true }));
      return { content: [{ type: "text", text: "[Command aborted.]" }], details: undefined };
    },
  };
  const { session } = await createCohubAgentSession({ cwd: root, sessionManager, modelRegistry, tools: [waitTool], model });
  t.after(() => session.dispose());
  stop = () => void session.abort();

  await session.prompt("run the tool");
  await session.agent.waitForIdle();

  const last = session.agent.state.messages.at(-1) as AssistantMessage | undefined;
  assert.equal(last?.role, "assistant");
  assert.equal(last?.stopReason, "aborted");
  assert.equal(upstreamRequests, 1);
});
