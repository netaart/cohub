import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import sharp from "sharp";
import { getRemoteImageUrl } from "@cohub/model-runtime/image-content";
import { hydrateSessionImages } from "../runtime/context-images.js";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";
import type { ModelsConfig } from "@cohub/infra/config-runtime/models";
import {
  CLAUDE_CODE_BETA,
  CLAUDE_CODE_SYSTEM_IDENTITY,
  CLAUDE_CODE_VERSION,
} from "@cohub/model-runtime/request-profile/claude-code";
import { SessionManager } from "../runtime/local-session-manager.js";
import { CohubModelRegistry } from "../runtime/model-registry.js";

process.env.DATABASE_URL ??= "postgres://localhost/cohub_test";
process.env.APP_ENCRYPTION_KEY ??= "test-key";
process.env.SESSIONS_NAMESPACE ??= "test";
process.env.TEST_ANTHROPIC_API_KEY = "test-key";

const { createCohubAgentSession } = await import("../runtime/session-runtime.js");

const config: ModelsConfig = {
  providers: {
    test: {
      api: "anthropic-messages",
      baseUrl: "https://anthropic.test",
      apiKey: "TEST_ANTHROPIC_API_KEY",
      models: [{ id: "claude-opus-5-5", reasoning: true, requestProfile: "claude-code" }, { id: "claude-sonnet-5", reasoning: true }],
    },
  },
};

type CapturedRequest = { headers: Headers; body: Record<string, unknown> };

function sse(block: Record<string, unknown>, delta: Record<string, unknown>, stopReason: string): string {
  return [
    { type: "message_start", message: { id: "msg_1", type: "message", role: "assistant", model: "m", content: [], stop_reason: null, usage: { input_tokens: 1, output_tokens: 0 } } },
    { type: "content_block_start", index: 0, content_block: block },
    { type: "content_block_delta", index: 0, delta },
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: stopReason }, usage: { output_tokens: 1 } },
    { type: "message_stop" },
  ].map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join("");
}

const SSE_TEXT_REPLY = sse({ type: "text", text: "" }, { type: "text_delta", text: "ok" }, "end_turn");
const SSE_TOOL_CALL_REPLY = sse(
  { type: "tool_use", id: "toolu_1", name: "echo", input: {} },
  { type: "input_json_delta", partial_json: JSON.stringify({ text: "x" }) },
  "tool_use",
);

const requests: CapturedRequest[] = [];
/** Replies served before falling back to a plain text reply. */
const replies: string[] = [];
const originalFetch = globalThis.fetch;
globalThis.fetch = async (_input, init) => {
  requests.push({ headers: new Headers(init?.headers), body: JSON.parse(String(init?.body)) as Record<string, unknown> });
  return new Response(replies.shift() ?? SSE_TEXT_REPLY, { status: 200, headers: { "content-type": "text/event-stream" } });
};

const root = await mkdtemp(join(tmpdir(), "cohub-agent-request-"));
test.after(async () => {
  globalThis.fetch = originalFetch;
  await rm(root, { recursive: true, force: true });
});

function textTool(name: string): AgentTool {
  return {
    name,
    label: name,
    description: `${name} the input`,
    parameters: Type.Object({ text: Type.String() }),
    execute: async () => ({ content: [{ type: "text", text: name }], details: undefined }),
  };
}

const echoTool = textTool("echo");

async function createSession(modelId: string) {
  const modelRegistry = new CohubModelRegistry({ configs: [config] });
  const model = modelRegistry.find("test", modelId);
  assert.ok(model);
  const sessionManager = SessionManager.create(root, join(root, "sessions"));
  sessionManager.newSession({ id: `session-${modelId}` });
  const { session } = await createCohubAgentSession({ cwd: root, sessionManager, modelRegistry, tools: [echoTool], model });
  return { session, sessionManager };
}

function systemTexts(request: CapturedRequest | undefined): string[] {
  const system = request?.body.system;
  assert.ok(Array.isArray(system), "request carries a system prompt");
  return system.map((block: { text?: string }) => block.text ?? "");
}

function toolNames(request: CapturedRequest | undefined): string[] {
  const tools = request?.body.tools;
  assert.ok(Array.isArray(tools), "request declares tools");
  return tools.map((tool: { name?: string }) => tool.name ?? "");
}

test("agent requests carry the system prompt and tools, also after the transcript is rebuilt", async () => {
  requests.length = 0;
  const { session, sessionManager } = await createSession("claude-opus-5-5");

  await session.prompt("first");
  // Compaction and cloud sync rebuild the transcript from the session file,
  // which never holds system messages.
  session.agent.state.messages = sessionManager.buildSessionContext().messages;
  await session.prompt("second");

  assert.equal(requests.length, 2);
  const prompts = requests.map((request) => systemTexts(request).at(-1));
  assert.ok(prompts[0] && prompts[0].length > 0, "Cohub system prompt is sent");
  assert.equal(prompts[1], prompts[0]);
  for (const request of requests) assert.deepEqual(toolNames(request), ["echo"]);
  // Pi's transcript system messages stay out of the session file.
  const roles = sessionManager.getBranchEntries().flatMap((entry) => entry.type === "message" ? [entry.message.role] : []);
  assert.deepEqual(roles, ["user", "assistant", "user", "assistant"]);
  session.dispose();
});

test("every round of a tool loop carries the system prompt and current tools", async () => {
  requests.length = 0;
  replies.push(SSE_TOOL_CALL_REPLY);
  const { session, sessionManager } = await createSession("claude-opus-5-5");

  await session.prompt("use the tool");
  assert.equal(requests.length, 2);
  const [call, followUp] = requests;
  assert.ok(call && followUp);
  assert.equal(systemTexts(followUp).at(-1), systemTexts(call).at(-1));
  for (const request of requests) assert.deepEqual(toolNames(request), ["echo"]);
  const messages = followUp.body.messages;
  assert.ok(Array.isArray(messages));
  const toolResultIds = messages.flatMap((message: { content?: unknown }) =>
    Array.isArray(message.content)
      ? message.content.flatMap((block: { type?: string; tool_use_id?: string }) => block.type === "tool_result" ? [block.tool_use_id] : [])
      : []);
  assert.deepEqual(toolResultIds, ["toolu_1"]);

  // Tool changes reach the next request without a transcript system message.
  await session.configureTools([echoTool, textTool("shout")]);
  await session.prompt("again");
  assert.deepEqual(toolNames(requests.at(-1)), ["echo", "shout"]);

  const roles = sessionManager.getBranchEntries().flatMap((entry) => entry.type === "message" ? [entry.message.role] : []);
  assert.deepEqual(roles, ["user", "assistant", "toolResult", "assistant", "user", "assistant"]);
  session.dispose();
});

test("claude-code profile requests identify as Claude Code with API key auth", async () => {
  requests.length = 0;
  const { session } = await createSession("claude-opus-5-5");
  await session.prompt("hello");
  session.dispose();

  const [request] = requests;
  assert.ok(request);
  const [identity, prompt] = systemTexts(request);
  assert.equal(identity, CLAUDE_CODE_SYSTEM_IDENTITY);
  assert.ok(prompt && prompt.length > 0, "Cohub system prompt follows the identity");
  assert.equal(request.headers.get("user-agent"), `claude-cli/${CLAUDE_CODE_VERSION}`);
  assert.equal(request.headers.get("x-app"), "cli");
  assert.equal(request.headers.get("x-api-key"), "test-key");
  assert.equal(request.headers.get("authorization"), null);
  const betas = request.headers.get("anthropic-beta")?.split(",") ?? [];
  assert.equal(betas[0], CLAUDE_CODE_BETA);
  assert.ok(!betas.includes("oauth-2025-04-20"), "no OAuth beta without an OAuth token");
  // Tool names are Cohub's own: pi only maps Claude Code tool names back for OAuth tokens.
  assert.deepEqual(toolNames(request), ["echo"]);
});

test("models without the claude-code profile keep their own identity, whatever their id", async () => {
  requests.length = 0;
  const { session } = await createSession("claude-sonnet-5");
  await session.prompt("hello");
  session.dispose();

  const [request] = requests;
  assert.ok(request);
  assert.ok(!request.headers.get("user-agent")?.startsWith("claude-cli/"));
  assert.equal(request.headers.get("x-app"), null);
  assert.ok(!(request.headers.get("anthropic-beta") ?? "").includes(CLAUDE_CODE_BETA));
  const texts = systemTexts(request);
  assert.equal(texts.length, 1);
  assert.notEqual(texts[0], CLAUDE_CODE_SYSTEM_IDENTITY);
});


test("reload applies recovered URLs to the live agent and the next provider request", async () => {
  requests.length = 0;
  const { session, sessionManager } = await createSession("claude-sonnet-5");
  await session.setModel({ ...session.agent.state.model, input: ["text", "image"] });
  const data = await sharp({ create: { width: 20, height: 20, channels: 3, background: "red" } }).png().toBuffer();
  sessionManager.appendMessage({ role: "user", content: [{ type: "image", data: data.toString("base64"), mimeType: "image/png" }], timestamp: 0 });
  await session.reload();
  const url = "https://trusted.test/restored.png";
  const recovered = await hydrateSessionImages(sessionManager, async () => null, { writeImage: async () => url });
  assert.equal(recovered.changed, true);
  await session.reload(recovered.messages);
  const message = session.agent.state.messages[0];
  assert(message?.role === "user" && Array.isArray(message.content));
  const image = message.content[0];
  assert(image?.type === "image" && "data" in image);
  assert.equal(getRemoteImageUrl(image), url);
  await session.prompt("Describe the recovered image");
  assert.equal(requests.length, 1);
  const payload = JSON.stringify(requests[0]?.body);
  assert(payload.includes(`"source":{"type":"url","url":"${url}"}`));
  assert(!payload.includes(data.toString("base64")));
  session.dispose();
});
