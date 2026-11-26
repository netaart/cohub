import assert from "node:assert/strict";
import test from "node:test";
import type { AgentTurnAbortEvent } from "@cohub/protocol";
import { applyRoundBoundaryAbort, clearActiveAbortController, clearActiveAbortEvent, getActiveAbortEvent, requestActiveTurnStop, setActiveAbortController } from "../active-turns.js";

const billingStop = (turnId: string): AgentTurnAbortEvent => ({ id: `stop-${turnId}`, spaceId: "space", sessionId: "session", turnId, reason: "billing", timestamp: Date.now() });

test("a billing stop waits for the next LLM round of a Turn executing here", (t) => {
  const controller = new AbortController();
  setActiveAbortController("turn-a", controller, "round");
  t.after(() => {
    clearActiveAbortController("turn-a", controller);
    clearActiveAbortEvent("turn-a");
  });

  assert.equal(requestActiveTurnStop(billingStop("turn-a")).deferred, true);
  assert.equal(controller.signal.aborted, false);
  assert.equal(applyRoundBoundaryAbort("turn-a"), true);
  assert.equal(controller.signal.aborted, true);
  assert.equal(getActiveAbortEvent("turn-a")?.reason, "billing");
  assert.equal(applyRoundBoundaryAbort("turn-a"), false);
});
