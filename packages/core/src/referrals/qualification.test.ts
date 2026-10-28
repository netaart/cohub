import assert from "node:assert/strict";
import { test } from "node:test";
import { isQualifyingReferralTurn, type ReferralQualificationMessage, type ReferralQualificationTurn } from "./qualification.js";

const turn = (patch: Partial<ReferralQualificationTurn> = {}): ReferralQualificationTurn => ({
  id: "turn", sessionId: "session", userUuid: "invitee", executionKind: "agent", status: "completed", intent: "followup",
  meta: { context: { kind: "websocket" } }, userContent: [{ type: "text", text: "Hi" }], completedAt: new Date("2026-10-28T00:00:00Z"), ...patch,
});
const message = (patch: Partial<ReferralQualificationMessage> = {}): ReferralQualificationMessage => ({
  sessionId: "session", turnId: "turn", role: "assistant", meta: { turnId: "turn", messageKind: "assistant_final", actorUserId: "invitee" },
  content: [{ type: "text", text: "Hi!" }], stopReason: "stop", errorMessage: null, ...patch,
});

test("a short user conversation or visible image reply qualifies", () => {
  assert.equal(isQualifyingReferralTurn(turn(), message()), true);
  assert.equal(isQualifyingReferralTurn(turn({ intent: "steer", meta: null }), message({ turnId: null })), true);
  assert.equal(isQualifyingReferralTurn(turn(), message({
    content: [{ type: "image", source: { type: "url", url: "https://example.com/result.png" } }],
  })), true);
});

test("notes, generation, shell, automatic and local turns cannot earn conversation rewards", () => {
  const ineligible: Partial<ReferralQualificationTurn>[] = [
    { executionKind: "note" }, { executionKind: "direct_generation" }, { intent: "compact" },
    { userContent: [{ type: "shell_command", command: "pwd", rawText: "!pwd" }] },
    { meta: { llm: false } }, { meta: { intent: "shell_command" } }, { meta: { runtime: "local" } },
    ...["scheduled_task", "background_bash_task", "space_hook"].map((kind) => ({ meta: { context: { kind } } })),
    ...["scheduled_prompt", "background_task", "hook"].map((kind) => ({ meta: { origin: { kind } } })),
  ];
  for (const patch of ineligible) assert.equal(isQualifyingReferralTurn(turn(patch), message()), false, JSON.stringify(patch));
  for (const meta of [{ runtime: "local" }, { llm: false }, { executionKind: "shell_command_result" }]) {
    assert.equal(isQualifyingReferralTurn(turn(), message({ meta: { turnId: "turn", messageKind: "assistant_final", ...meta } })), false);
  }
});

test("unsuccessful, truncated, empty and thinking-only results do not qualify", () => {
  for (const status of ["queued", "running", "failed", "interrupted", "cancelled"] as const) {
    assert.equal(isQualifyingReferralTurn(turn({ status }), message()), false);
  }
  for (const stopReason of ["length", "max_tokens", "error", "aborted", "toolUse", "tool_use", null]) {
    assert.equal(isQualifyingReferralTurn(turn(), message({ stopReason })), false);
  }
  for (const content of [[], [{ type: "text", text: "  " }], [{ type: "thinking", thinking: "Still thinking" }]] as ReferralQualificationMessage["content"][]) {
    assert.equal(isQualifyingReferralTurn(turn(), message({ content })), false);
  }
  assert.equal(isQualifyingReferralTurn(turn(), message({ errorMessage: "provider failed" })), false);
  assert.equal(isQualifyingReferralTurn(turn({ userContent: [] }), message()), false);
});

test("qualification requires a completed turn and its own final assistant message", () => {
  for (const patch of [{ userUuid: null }, { completedAt: null }, { completedAt: new Date("invalid") }]) {
    assert.equal(isQualifyingReferralTurn(turn(patch), message()), false);
  }
  const mismatched: Partial<ReferralQualificationMessage>[] = [
    { sessionId: "other" }, { turnId: "other" }, { role: "system" },
    { meta: { turnId: "other", messageKind: "assistant_final" } },
    { meta: { turnId: "turn", messageKind: "assistant_intermediate" } },
    { meta: { turnId: "turn", messageKind: "assistant_final", actorUserId: "other" } },
  ];
  for (const patch of mismatched) assert.equal(isQualifyingReferralTurn(turn(), message(patch)), false);
});
