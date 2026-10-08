import assert from "node:assert/strict";
import { it } from "node:test";
import { sessionActiveTurnState } from "./active-turn.js";

it("idle sessions keep the latest turn sequence", () => {
  assert.deepEqual(sessionActiveTurnState(null, 7), { activeTurn: null, activeTurnSequence: 7 });
  assert.deepEqual(sessionActiveTurnState(null, null), { activeTurn: null });
});

it("live sessions are sequenced by their active turn", () => {
  const state = sessionActiveTurnState({
    id: "t", sequence: 3, status: "running", provider: null, model: null, startedAt: null, meta: { userMessageId: "m" },
  }, 4);
  assert.equal(state.activeTurnSequence, 3);
  assert.equal(state.activeTurn?.anchorUserMessageId, "m");
});
