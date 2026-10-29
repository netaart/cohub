import assert from "node:assert/strict";
import test from "node:test";
import type { AgentMessage } from "@earendil-works/pi-agent-core";

process.env.DATABASE_URL ??= "postgres://localhost/cohub_test";
process.env.APP_ENCRYPTION_KEY ??= "test-key";
process.env.SESSIONS_NAMESPACE ??= "test";

const { toLlmMessages } = await import("../runtime/session-runtime.js");

test("tool results never reach the provider with empty content", () => {
  const [message] = toLlmMessages([{
    role: "toolResult",
    toolCallId: "call-1",
    toolName: "bash",
    content: [{ type: "text", text: "" }, { type: "text", text: "  " }],
    isError: true,
    timestamp: 0,
  } as unknown as AgentMessage]) as unknown as Array<{ content: unknown }>;

  assert.deepEqual(message?.content, [{ type: "text", text: "(no output)" }]);
});
