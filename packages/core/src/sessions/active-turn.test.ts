import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { pickActiveTurns, type ActiveTurnRow } from "./active-turn.js";

const row = (overrides: Partial<ActiveTurnRow> & Pick<ActiveTurnRow, "sessionId" | "id">): ActiveTurnRow => ({
  sequence: 1,
  status: "running",
  provider: "cohub",
  model: "deepseek-flash",
  startedAt: new Date("2026-09-10T10:00:00.000Z"),
  meta: null,
  ...overrides,
});

describe("pickActiveTurns", () => {
  it("attaches the active turn to its session and null to the rest, preserving order", () => {
    const sessions = [{ id: "a" }, { id: "b" }, { id: "c" }];
    const picked = pickActiveTurns(sessions, [row({ sessionId: "b", id: "turn-b" })]);

    assert.deepEqual(picked.map((s) => s.id), ["a", "b", "c"]);
    assert.equal(picked[0]?.activeTurn, null);
    assert.deepEqual(picked[1]?.activeTurn, {
      id: "turn-b",
      sequence: 1,
      status: "running",
      provider: "cohub",
      model: "deepseek-flash",
      startedAt: "2026-09-10T10:00:00.000Z",
      anchorUserMessageId: null,
    });
    assert.equal(picked[2]?.activeTurn, null);
  });

  it("keeps the first (newest) row per session", () => {
    const picked = pickActiveTurns(
      [{ id: "a" }],
      [row({ sessionId: "a", id: "newest" }), row({ sessionId: "a", id: "older" })],
    );
    assert.equal(picked[0]?.activeTurn?.id, "newest");
  });

  it("lifts a string anchorUserMessageId from meta and tolerates other shapes", () => {
    const picked = pickActiveTurns(
      [{ id: "a" }, { id: "b" }, { id: "c" }],
      [
        row({ sessionId: "a", id: "t", meta: { userMessageId: "msg-1" } }),
        row({ sessionId: "b", id: "t", meta: { userMessageId: 7 } }),
        row({ sessionId: "c", id: "t", meta: [] }),
      ],
    );
    assert.equal(picked[0]?.activeTurn?.anchorUserMessageId, "msg-1");
    assert.equal(picked[1]?.activeTurn?.anchorUserMessageId, null);
    assert.equal(picked[2]?.activeTurn?.anchorUserMessageId, null);
  });

  it("nulls missing scalars", () => {
    const picked = pickActiveTurns(
      [{ id: "a" }],
      [row({ sessionId: "a", id: "t", provider: null, model: null, startedAt: null })],
    );
    assert.deepEqual(picked[0]?.activeTurn, {
      id: "t",
      sequence: 1,
      status: "running",
      provider: null,
      model: null,
      startedAt: null,
      anchorUserMessageId: null,
    });
  });

  it("returns every session idle when there are no rows", () => {
    assert.deepEqual(pickActiveTurns([{ id: "a" }], []), [{ id: "a", activeTurn: null }]);
    assert.deepEqual(pickActiveTurns([], []), []);
  });
});
