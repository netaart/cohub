import assert from "node:assert/strict";
import test from "node:test";
import {
  Type,
  createAssistantMessageEventStream,
  normalizeContext,
  type Api,
  type AssistantMessage,
  type AssistantMessageEvent,
  type Model,
  type ProviderStreams,
  type ToolCall,
} from "@earendil-works/pi-ai";
import { applyRequestProfile, withRequestProfiles } from "@cohub/model-runtime/request-profile";
import {
  CLAUDE_CODE_BETA,
  CLAUDE_CODE_SYSTEM_IDENTITY,
  CLAUDE_CODE_VERSION,
  restoreToolName,
  withClaudeCodePayload,
} from "@cohub/model-runtime/request-profile/claude-code";

function unprofiledModel(id: string, headers?: Record<string, string>): Model<Api> {
  return { id, provider: "cohub", api: "anthropic-messages", headers } as Model<Api>;
}

function model(id: string, headers?: Record<string, string>): Model<Api> & { requestProfile: string } {
  return { ...unprofiledModel(id, headers), requestProfile: "claude-code" };
}

const payload = { system: [{ type: "text", text: "cohub prompt" }], betas: ["fine-grained-tool-streaming-2025-05-14"] };

test("claude-code profile models get Claude Code identity headers", () => {
  const overrides = applyRequestProfile(model("claude-opus-5-5"), { headers: { "x-trace": "1" } });
  assert.deepEqual(overrides.headers, { "User-Agent": `claude-cli/${CLAUDE_CODE_VERSION}`, "x-app": "cli", "x-trace": "1" });
});

test("models without the claude-code profile are untouched, whatever their id", () => {
  assert.deepEqual(applyRequestProfile(unprofiledModel("claude-opus-5-5"), { headers: { "x-trace": "1" } }), { headers: { "x-trace": "1" } });
  assert.deepEqual(applyRequestProfile(unprofiledModel("glm-5"), undefined), {});
});

test("configured headers win over the identity", () => {
  const fromModel = applyRequestProfile(model("claude-sonnet-5", { "user-agent": "custom/1" }), undefined);
  assert.deepEqual(fromModel.headers, { "x-app": "cli" });
  const fromOptions = applyRequestProfile(model("claude-sonnet-5"), { headers: { "X-App": "web" } });
  assert.deepEqual(fromOptions.headers, { "User-Agent": `claude-cli/${CLAUDE_CODE_VERSION}`, "X-App": "web" });
});

test("identity leads the system prompt and the Claude Code beta is declared", async () => {
  const overrides = applyRequestProfile(model("claude-opus-5-5"), undefined);
  const next = await overrides.onPayload?.(payload, model("claude-opus-5-5"));
  assert.deepEqual(next, {
    system: [{ type: "text", text: CLAUDE_CODE_SYSTEM_IDENTITY }, { type: "text", text: "cohub prompt" }],
    betas: [CLAUDE_CODE_BETA, "fine-grained-tool-streaming-2025-05-14"],
  });
  // Applying twice changes nothing.
  assert.deepEqual(withClaudeCodePayload(next, { beta: true }), next);
});

test("requests without a system prompt still carry the identity", () => {
  assert.deepEqual(withClaudeCodePayload({ messages: [] }, { beta: true }), {
    messages: [],
    system: [{ type: "text", text: CLAUDE_CODE_SYSTEM_IDENTITY }],
    betas: [CLAUDE_CODE_BETA],
  });
});

test("a configured anthropic-beta list is left as configured", async () => {
  const overrides = applyRequestProfile(model("claude-opus-5-5", { "anthropic-beta": "context-1m-2025-08-07" }), undefined);
  const next = await overrides.onPayload?.({ ...payload, betas: ["context-1m-2025-08-07"] }, model("claude-opus-5-5"));
  assert.deepEqual((next as { betas: string[] }).betas, ["context-1m-2025-08-07"]);
});

test("the caller's payload hook runs first", async () => {
  const overrides = applyRequestProfile(model("claude-opus-5-5"), {
    onPayload: (value) => ({ ...(value as object), metadata: { user_id: "u" } }),
  });
  const next = await overrides.onPayload?.(payload, model("claude-opus-5-5"));
  assert.deepEqual((next as { metadata: unknown }).metadata, { user_id: "u" });
  assert.equal((next as { system: Array<{ text: string }> }).system[0]?.text, CLAUDE_CODE_SYSTEM_IDENTITY);
});

test("tool names are restored to the declared casing, case-insensitively", () => {
  const declared = ["read", "ls", "find", "Custom"];
  assert.equal(restoreToolName("Read", declared), "read");
  assert.equal(restoreToolName("LS", declared), "ls");
  assert.equal(restoreToolName("find", declared), "find");
  assert.equal(restoreToolName("custom", declared), "Custom");
  assert.equal(restoreToolName("WebSearch", declared), "WebSearch");
});

const declaredTools = ["read", "ls", "find"].map((name) => ({ name, description: name, parameters: Type.Object({}) }));

/** Replays an upstream that recased declared tools, sharing one mutable message across events like pi's providers. */
function recasingUpstream(names: string[]): ProviderStreams {
  const stream: ProviderStreams["stream"] = (streamModel) => {
    const output = { role: "assistant", content: [], api: streamModel.api, provider: streamModel.provider, model: streamModel.id, stopReason: "toolUse", timestamp: 0 } as unknown as AssistantMessage;
    const events = createAssistantMessageEventStream();
    queueMicrotask(() => {
      events.push({ type: "start", partial: output });
      names.forEach((name, index) => {
        const block: ToolCall = { type: "toolCall", id: `call-${index}`, name, arguments: {} };
        output.content.push(block);
        events.push({ type: "toolcall_start", contentIndex: index, partial: output });
        events.push({ type: "toolcall_delta", contentIndex: index, delta: "{}", partial: output });
        events.push({ type: "toolcall_end", contentIndex: index, toolCall: { ...block, name }, partial: output });
      });
      events.push({ type: "done", reason: "toolUse", message: output });
    });
    return events;
  };
  return { stream, streamSimple: stream };
}

function toolCallNames(message: AssistantMessage): string[] {
  return message.content.flatMap((block) => (block.type === "toolCall" ? [block.name] : []));
}

test("claude-code profile streams return tool calls under the declared names", async () => {
  const upstream = recasingUpstream(["Read", "LS", "find", "WebSearch"]);
  const context = normalizeContext({ messages: [], tools: declaredTools });
  const events: AssistantMessageEvent[] = [];
  const started: string[] = [];
  const stream = withRequestProfiles(upstream).streamSimple(model("claude-opus-5-5-m"), context);
  for await (const event of stream) {
    events.push(event);
    const block = event.type === "toolcall_start" ? event.partial.content[event.contentIndex] : undefined;
    if (block?.type === "toolCall") started.push(block.name);
  }

  assert.deepEqual(started, ["read", "ls", "find", "WebSearch"]);
  const ended = events.flatMap((event) => (event.type === "toolcall_end" ? [event.toolCall.name] : []));
  assert.deepEqual(ended, ["read", "ls", "find", "WebSearch"]);
  assert.deepEqual(toolCallNames(await stream.result()), ["read", "ls", "find", "WebSearch"]);
});

test("models without the claude-code profile keep the upstream's tool names", async () => {
  const upstream = recasingUpstream(["Read"]);
  const stream = withRequestProfiles(upstream).stream(unprofiledModel("claude-opus-5-5"), normalizeContext({ messages: [], tools: declaredTools }));
  assert.deepEqual(toolCallNames(await stream.result()), ["Read"]);
});
