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
