import assert from "node:assert/strict";
import { test } from "node:test";
import { nativeTurnStartSchema, nativeTurnCompleteSchema, nativeTurnProgressSchema } from "./src/runtime/native.js";

const input = () => ({ turnId: crypto.randomUUID(), sessionId: null, parentTurnId: null, branchSessionId: crypto.randomUUID(), harness: "pi", nativeSessionId: "native", userContent: [{ type: "text", text: "hello" }], startedAt: new Date().toISOString() });
test("native sync accepts Turn anchors only, never client-supplied ownership or message fork positions", () => {
  assert(nativeTurnStartSchema.safeParse(input()).success);
  assert(!nativeTurnStartSchema.safeParse({ ...input(), parentTurnId: crypto.randomUUID() }).success);
  assert(!nativeTurnStartSchema.safeParse({ ...input(), ownerUserId: "other" }).success);
  assert(!nativeTurnStartSchema.safeParse({ ...input(), parentMessageId: "message" }).success);
  assert(!nativeTurnStartSchema.safeParse({ ...input(), harness: "cohub" }).success);
});
test("native receipts reject invalid counters, nonterminal completion and unbounded revisions", () => {
  const result = { completedAt: new Date().toISOString(), status: "completed", messages: [{ content: [], usage: { input: 3, output: 2 } }] };
  assert(nativeTurnCompleteSchema.safeParse(result).success);
  assert(!nativeTurnCompleteSchema.safeParse({ ...result, status: "running" }).success);
  assert(!nativeTurnCompleteSchema.safeParse({ ...result, messages: [{ content: [], usage: { input: -1 } }] }).success);
  assert(!nativeTurnProgressSchema.safeParse({ messages: [], revision: Number.MAX_SAFE_INTEGER + 1 }).success);
});

test("native user messages preserve ordered text and images on the existing wire format", () => {
  const content = [
    { type: "text", text: "Follow up", _meta: { nativeUserMessage: true } },
    { type: "image", source: { type: "url", url: "https://example.com/image.png" }, _meta: { nativeUserMessage: true } },
  ];
  assert.deepEqual(nativeTurnProgressSchema.parse({ revision: 1, messages: [{ content }] }).messages[0].content, content);
  assert.equal(nativeTurnProgressSchema.safeParse({ revision: 1, messages: [{ content: [content[0], { type: "text", text: "Mixed author" }] }] }).success, false);
  assert.equal(nativeTurnProgressSchema.safeParse({ revision: 1, messages: [{ content: [{ type: "text", text: "Invalid marker", _meta: { nativeUserMessage: "yes" } }] }] }).success, false);
});
