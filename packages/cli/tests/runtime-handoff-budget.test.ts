import assert from "node:assert/strict";
import { test } from "node:test";
import type { CanonicalProjectionMessage, CanonicalProjectionTurn, ContentBlock, ProjectionInput } from "@neta-art/cohub";
import { fitHandoff } from "../src/runtime/harnesses/handoff-budget.js";

const sessionId = "session-1";

function message(turnId: string, role: CanonicalProjectionMessage["role"], content: ContentBlock[]): CanonicalProjectionMessage {
  return { id: `${turnId}:${role}`, turnId, role, content, sourceSessionId: sessionId, sequence: 0, createdAt: "2026-11-25T00:00:00Z" };
}

function turn(index: number, assistant: ContentBlock[] = [{ type: "text", text: "a".repeat(100) }]): CanonicalProjectionTurn {
  const id = `turn-${index}`;
  return {
    id, sourceSessionId: sessionId, sourceTurnId: id, sequence: index, status: "completed", intent: "followup", provider: null, model: null,
    userContent: [], assistantContent: null, meta: null, createdAt: "2026-11-25T00:00:00Z", startedAt: null, completedAt: null, durationMs: null,
    messages: [message(id, "user", [{ type: "text", text: "u".repeat(100) }]), message(id, "assistant", assistant)],
  };
}

const input = (turns: CanonicalProjectionTurn[]): ProjectionInput => ({ spaceId: "space-1", sessionId, nativeSessionId: "native-1", cwd: "/work", turns });
const ids = (fitted: ProjectionInput) => fitted.turns.map((entry) => entry.id);
const note = (entry: CanonicalProjectionTurn) => {
  const block = entry.messages[0]?.content[0];
  return block?.type === "text" ? block.text : "";
};

test("over budget keeps whole Turns: the opening one and the newest, with a note at the gap", () => {
  const fitted = fitHandoff(input([turn(1), turn(2), turn(3), turn(4), turn(5)]), { chars: 900 });
  assert.deepEqual(ids(fitted), ["turn-1", "turn-4", "turn-5"]);
  assert.match(note(fitted.turns[1] as CanonicalProjectionTurn), /^\[2 earlier turns .*cohub spaces turns ls --session session-1 --cursor 4 --direction older/);
  assert.equal(note(fitted.turns[0] as CanonicalProjectionTurn), "u".repeat(100));
});

test("the newest Turn is kept even when it alone exceeds the budget", () => {
  const fitted = fitHandoff(input([turn(1), turn(2, [{ type: "text", text: "a".repeat(5_000) }])]), { chars: 1_000 });
  assert.deepEqual(ids(fitted), ["turn-2"]);
  assert.match(note(fitted.turns[0] as CanonicalProjectionTurn), /^\[1 earlier turn /);
});
