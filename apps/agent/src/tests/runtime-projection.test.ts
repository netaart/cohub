import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { contextToPiMessages, type RuntimeContext } from "@cohub/protocol";
import { SessionManager } from "../runtime/local-session-manager.js";
import { syncCloudContext } from "../runtime/cloud-context.js";

const history: RuntimeContext = { revision: "r", throughTurnId: "t", messages: [
  { id: "u", turnId: "t", role: "user", content: [{ type: "text", text: "request" }] },
  { id: "a", turnId: "t", role: "assistant", provider: "p", model: "m", stopReason: "error", errorMessage: "failed", usage: { input: 7, output: 3 }, meta: { nativeApi: "anthropic-messages", createdAt: "2026-09-16T00:00:00Z" }, content: [
    { type: "thinking", thinking: "reasoning", signature: "opaque" },
    { type: "tool_use", id: "tc", name: "read", input: { path: "a" } },
    { type: "tool_result", tool_use_id: "tc", content: "result", is_error: true },
  ] },
] };

test("Cloud DB projection survives file reload with native reasoning, tools and error state", async () => {
  const root = await mkdtemp(join(tmpdir(), "cloud-projection-"));
  try {
    const path = join(root, "session.jsonl");
    const manager = SessionManager.create(root, root); manager.newSession({ id: "s" }); manager.setSessionFile(path);
    assert(syncCloudContext(manager, history));
    await manager.close();
    const reopened = await SessionManager.open(path, root);
    const expected = contextToPiMessages(history.messages);
    assert.deepEqual(reopened.buildSessionContext().messages, expected);
    assert.equal(syncCloudContext(reopened, { ...history, revision: "new" }), false);
    assert.deepEqual(reopened.buildSessionContext().messages, expected);
    const assistant = expected[1];
    assert(assistant);
    assert.equal(assistant.api, "anthropic-messages"); assert.equal(assistant.errorMessage, "failed");
    assert.equal((assistant.usage as { input: number }).input, 7);
    await reopened.close();
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("generation placeholders never advance the Cloud resume marker", () => {
  const manager = SessionManager.create("/tmp", "/tmp"); manager.newSession({ id: "test" });
  const context: RuntimeContext = { ...history, messages: [{ id: "g", turnId: "t", role: "assistant", content: [{ type: "text", text: "queued" }], meta: { generationTaskId: "g", messageKind: "generation_result", generationStatus: "queued" } }] };
  assert.throws(() => syncCloudContext(manager, context), /not settled/);
  assert.equal(manager.getCustomEntries("cohub.context").length, 0);
  assert.equal(manager.buildSessionContext().messages.length, 0);
});
