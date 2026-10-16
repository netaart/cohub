import assert from "node:assert/strict";
import { test, mock } from "node:test";
import { submitInternalSessionPrompt } from "./api-client.js";

test("gateway preserves Codex approval choices when submitting to the API", async () => {
  const bodies: Array<Record<string, unknown>> = [];
  const fetchMock = mock.method(globalThis, "fetch", async (_url: unknown, init: RequestInit) => {
    bodies.push(JSON.parse(String(init.body)));
    return new Response(JSON.stringify({ ok: true, turnId: "turn", userMessageId: "message" }), { status: 200, headers: { "content-type": "application/json" } });
  });
  try {
    for (const codexApprovalMode of [undefined, "inherit", "read_only", "auto", "full_access"] as const) {
      await submitInternalSessionPrompt({ spaceId: "space", sessionId: "session", userId: "user", clientMessageId: "message", source: "websocket", content: [{ type: "text", text: "hello" }], harness: "codex", codexApprovalMode });
      const body = bodies.at(-1);
      assert.ok(body);
      assert.equal(body.harness, "codex");
      assert.equal(body.codexApprovalMode, codexApprovalMode);
      assert.equal(Object.hasOwn(body, "codexApprovalMode"), codexApprovalMode !== undefined);
    }
  } finally { fetchMock.mock.restore(); }
});
