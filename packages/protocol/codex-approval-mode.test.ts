import assert from "node:assert/strict";
import test from "node:test";
import { wsClientEventSchema } from "./src/realtime/schema.js";
import { validateCodexApprovalMode, runtimeCommandSchema } from "./src/runtime/index.js";

const payload = { spaceId: "123e4567-e89b-42d3-a456-426614174000", sessionId: "123e4567-e89b-42d3-a456-426614174001", content: [{ type: "text", text: "hello" }], harness: "codex" };
test("websocket prompts retain every explicit Codex approval mode", () => {
  for (const codexApprovalMode of ["inherit", "read_only", "auto", "full_access"]) {
    const parsed = wsClientEventSchema.parse({ type: "session.message.create", payload: { ...payload, codexApprovalMode } });
    assert.equal((parsed.payload as Record<string, unknown>).codexApprovalMode, codexApprovalMode);
  }
});
test("websocket rejects unsupported modes and non-Codex requests", () => {
  for (const patch of [{ codexApprovalMode: null }, { codexApprovalMode: "ask" }, { harness: "pi", codexApprovalMode: "auto" }, { harness: undefined, codexApprovalMode: "auto" }]) {
    assert.equal(wsClientEventSchema.safeParse({ type: "session.message.create", payload: { ...payload, ...patch } }).success, false);
  }
});

test("old runtimes cannot silently ignore explicit approval choices", () => {
  const capabilities = { harnesses: ["codex"] as const, models: [] };
  for (const codexApprovalMode of ["inherit", "auto"]) {
    assert.throws(() => validateCodexApprovalMode({ harness: "codex", codexApprovalMode }, { ...capabilities, harnesses: [...capabilities.harnesses] }), /update the Local Runtime/);
  }
  assert.doesNotThrow(() => validateCodexApprovalMode({ harness: "codex" }, { ...capabilities, harnesses: [...capabilities.harnesses] }));
  assert.doesNotThrow(() => validateCodexApprovalMode({ harness: "codex", codexApprovalMode: "auto" }, { harnesses: ["codex"], models: [], codexApprovalModes: ["auto"] }));
});
test("runtime commands preserve approval modes and reject invalid executors", () => {
  const id = "123e4567-e89b-42d3-a456-426614174000";
  const input = { spaceId: id, sessionId: id, turnId: id, userMessageId: id, actorUserId: null, harness: "codex", messages: [{ turnId: id, userMessageId: id, userId: null, content: [{ type: "text", text: "hello" }] }], context: { revision: "v1", throughTurnId: null, messages: [] }, accessMode: "full_access" };
  for (const codexApprovalMode of ["inherit", "read_only", "auto", "full_access"]) {
    const parsed = runtimeCommandSchema.parse({ type: "turn.start", requestId: id, input: { ...input, codexApprovalMode } });
    assert.equal(parsed.type === "turn.start" && parsed.input.codexApprovalMode, codexApprovalMode);
  }
  for (const patch of [{ harness: "pi", codexApprovalMode: "auto" }, { codexApprovalMode: null }, { codexApprovalMode: "ask" }]) {
    assert.equal(runtimeCommandSchema.safeParse({ type: "turn.start", requestId: id, input: { ...input, ...patch } }).success, false);
  }
});
