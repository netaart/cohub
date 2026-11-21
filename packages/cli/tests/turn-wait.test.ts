import assert from "node:assert/strict";
import { test } from "node:test";
import type {
  SessionSubscriptionHandlers,
  SessionTurnRecord,
  SessionTurnResponse,
  WebSocketConnectionState,
} from "@neta-art/cohub";

type SessionEvent = Parameters<NonNullable<SessionSubscriptionHandlers["patch"]>>[0];
import {
  extractPatchTextDeltas,
  parseWaitTimeout,
  TurnWaitAbortedError,
  TurnWaitTimeoutError,
  waitForTurn,
  type TurnWaitClient,
} from "../src/turn-wait.js";

function makeTurn(overrides: Partial<SessionTurnRecord> = {}): SessionTurnRecord {
  const now = "2026-11-22T00:00:00.000Z";
  return {
    id: "turn-1",
    sessionId: "sess-1",
    userUuid: "user-1",
    sequence: 1,
    status: "running",
    intent: "followup",
    userContent: [{ type: "text", text: "hi" }],
    userText: "hi",
    assistantContent: null,
    assistantText: null,
    provider: "anthropic",
    model: "claude-sonnet",
    stopReason: null,
    errorMessage: null,
    finalUsage: null,
    totalUsage: null,
    summary: null,
    intermediateIndex: null,
    intermediateSummary: null,
    meta: null,
    startedAt: now,
    completedAt: null,
    durationMs: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function createFakeRealtime(turnsById: Record<string, SessionTurnRecord>) {
  let sessionHandlers: SessionSubscriptionHandlers | null = null;
  let connectionHandler: ((state: WebSocketConnectionState) => void) | null = null;
  const abortedTurns: Array<string | null | undefined> = [];
  let unsubscribed = false;

  const client: TurnWaitClient = {
    space: () => ({
      session: () => ({
        subscribe: (handlers) => {
          sessionHandlers = handlers;
          return () => {
            unsubscribed = true;
            sessionHandlers = null;
          };
        },
        turns: {
          get: async (turnId) => {
            const turn = turnsById[turnId];
            if (!turn) {
              const err = Object.assign(new Error("turn not found"), { status: 404 });
              throw err;
            }
            return { turn } as SessionTurnResponse;
          },
        },
        abort: async (options) => {
          abortedTurns.push(options?.turnId);
          return { ok: true };
        },
      }),
    }),
    onConnection: (handler) => {
      connectionHandler = handler;
      return () => {
        connectionHandler = null;
      };
    },
    disconnect: async () => {},
  };

  return {
    client,
    abortedTurns,
    isUnsubscribed: () => unsubscribed,
    emitPatch: (turnId: string, ops: Array<{ o?: string; p?: string; v?: unknown }>) => {
      sessionHandlers?.patch?.({
        type: "session.turn.patch",
        spaceId: "space-1",
        sessionId: "sess-1",
        payload: { turnId, ops },
      } as unknown as SessionEvent);
    },
    emitFinalized: (turnId: string) => {
      sessionHandlers?.turnFinalized?.({
        type: "session.turn.finalized",
        spaceId: "space-1",
        sessionId: "sess-1",
        payload: { turn: { id: turnId } },
      } as unknown as SessionEvent);
    },
    emitConnection: (state: WebSocketConnectionState["state"]) => {
      connectionHandler?.({ state, willReconnect: false });
    },
  };
}

test("parseWaitTimeout parses valid durations and rejects invalid values", () => {
  assert.equal(parseWaitTimeout("500ms"), 500);
  assert.equal(parseWaitTimeout("90s"), 90_000);
  assert.equal(parseWaitTimeout("10m"), 600_000);
  assert.equal(parseWaitTimeout("2h"), 7_200_000);
  assert.equal(parseWaitTimeout("1d"), 86_400_000);
  assert.equal(parseWaitTimeout("45"), 45_000);
  assert.throws(() => parseWaitTimeout("0s"));
  assert.throws(() => parseWaitTimeout("-5s"));
  assert.throws(() => parseWaitTimeout("abc"));
  assert.throws(() => parseWaitTimeout(""));
});

test("extractPatchTextDeltas streams only text paths and continuation chunks", () => {
  const state = { lastAppendPath: null as string | null };
  assert.deepEqual(
    extractPatchTextDeltas(
      [
        { o: "append", p: "/message/content/blocks/0/thinking", v: "hidden" },
        { v: "still-thinking" },
        { o: "append", p: "/message/content/blocks/1/text", v: "Hello" },
        { v: " world" },
        { o: "append", p: "/message/content/blocks/2/input", v: "{}" },
        { v: "ignored" },
      ],
      state,
    ),
    ["Hello", " world"],
  );
});

test("waitForTurn settles immediately when the turn already completed before WS events arrive", async () => {
  const fake = createFakeRealtime({
    "turn-1": makeTurn({ id: "turn-1", status: "completed", assistantText: "Already done" }),
  });
  const result = await waitForTurn({
    client: fake.client,
    spaceId: "space-1",
    sessionId: "sess-1",
    turnId: "turn-1",
    reconcileIntervalMs: 0,
  });
  assert.equal(result.resolvedTurnId, "turn-1");
  assert.equal(result.turn.assistantText, "Already done");
  assert.equal(result.streamedText, false);
  assert.equal(fake.isUnsubscribed(), true);
});

test("waitForTurn streams text deltas via WS and settles on turn.finalized", async () => {
  const turns: Record<string, SessionTurnRecord> = {
    "turn-1": makeTurn({ id: "turn-1", status: "running" }),
  };
  const fake = createFakeRealtime(turns);
  const chunks: string[] = [];

  const pending = waitForTurn({
    client: fake.client,
    spaceId: "space-1",
    sessionId: "sess-1",
    turnId: "turn-1",
    reconcileIntervalMs: 0,
    onTextDelta: (delta) => chunks.push(delta),
  });

  await new Promise((r) => setTimeout(r, 15));
  fake.emitPatch("turn-1", [{ o: "append", p: "/message/content/blocks/0/text", v: "Hi " }]);
  fake.emitPatch("other-turn", [{ o: "append", p: "/message/content/blocks/0/text", v: "NOPE" }]);
  fake.emitPatch("turn-1", [{ v: "there!" }]);

  turns["turn-1"] = makeTurn({ id: "turn-1", status: "completed", assistantText: "Hi there!" });
  fake.emitFinalized("turn-1");

  const result = await pending;
  assert.deepEqual(chunks, ["Hi ", "there!"]);
  assert.equal(result.streamedText, true);
  assert.equal(result.turn.assistantText, "Hi there!");
});

test("waitForTurn reconciles on WebSocket reconnect if finalized event was missed", async () => {
  const turns: Record<string, SessionTurnRecord> = {
    "turn-1": makeTurn({ id: "turn-1", status: "running" }),
  };
  const fake = createFakeRealtime(turns);
  const pending = waitForTurn({
    client: fake.client,
    spaceId: "space-1",
    sessionId: "sess-1",
    turnId: "turn-1",
    reconcileIntervalMs: 0,
  });

  await new Promise((r) => setTimeout(r, 15));
  turns["turn-1"] = makeTurn({ id: "turn-1", status: "completed", assistantText: "Recovered" });
  fake.emitConnection("open");

  const result = await pending;
  assert.equal(result.turn.assistantText, "Recovered");
});

test("waitForTurn follows merged turns via summary.mergedIntoTurnId and guards against cycles", async () => {
  const turns: Record<string, SessionTurnRecord> = {
    "turn-1": makeTurn({ id: "turn-1", status: "merged", summary: { finishReason: "merged", mergedIntoTurnId: "turn-2" } }),
    "turn-2": makeTurn({ id: "turn-2", status: "running" }),
  };
  const fake = createFakeRealtime(turns);
  const merges: Array<[string, string]> = [];
  const chunks: string[] = [];

  const pending = waitForTurn({
    client: fake.client,
    spaceId: "space-1",
    sessionId: "sess-1",
    turnId: "turn-1",
    reconcileIntervalMs: 0,
    onTurnMerged: (from, to) => merges.push([from, to]),
    onTextDelta: (delta) => chunks.push(delta),
  });

  await new Promise((r) => setTimeout(r, 20));
  fake.emitPatch("turn-2", [{ o: "append", p: "/message/content/blocks/0/text", v: "Combined reply" }]);
  turns["turn-2"] = makeTurn({ id: "turn-2", status: "completed", assistantText: "Combined reply" });
  fake.emitFinalized("turn-2");

  const result = await pending;
  assert.deepEqual(merges, [["turn-1", "turn-2"]]);
  assert.deepEqual(result.mergedChain, ["turn-1"]);
  assert.equal(result.turnId, "turn-1");
  assert.equal(result.resolvedTurnId, "turn-2");
  assert.deepEqual(chunks, ["Combined reply"]);

  // Self-looping mergedIntoTurnId settles without looping forever
  const cyclic = createFakeRealtime({
    "turn-loop": makeTurn({ id: "turn-loop", status: "merged", summary: { finishReason: "merged", mergedIntoTurnId: "turn-loop" } }),
  });
  const cyclicRes = await waitForTurn({
    client: cyclic.client,
    spaceId: "space-1",
    sessionId: "sess-1",
    turnId: "turn-loop",
    reconcileIntervalMs: 0,
  });
  assert.equal(cyclicRes.turn.status, "merged");
  assert.deepEqual(cyclicRes.mergedChain, []);
});

test("waitForTurn honors timeout without aborting cloud turn by default, and aborts only when abortOnTimeout is true", async () => {
  const fake1 = createFakeRealtime({ "turn-1": makeTurn({ id: "turn-1", status: "running" }) });
  await assert.rejects(
    waitForTurn({
      client: fake1.client,
      spaceId: "space-1",
      sessionId: "sess-1",
      turnId: "turn-1",
      timeoutMs: 30,
      reconcileIntervalMs: 0,
    }),
    (err: unknown) => {
      assert(err instanceof TurnWaitTimeoutError);
      assert.equal(err.abortedCloudTurn, false);
      assert.equal(err.turnId, "turn-1");
      return true;
    },
  );
  assert.deepEqual(fake1.abortedTurns, []);

  const fake2 = createFakeRealtime({ "turn-2": makeTurn({ id: "turn-2", status: "running" }) });
  await assert.rejects(
    waitForTurn({
      client: fake2.client,
      spaceId: "space-1",
      sessionId: "sess-1",
      turnId: "turn-2",
      timeoutMs: 30,
      abortOnTimeout: true,
      reconcileIntervalMs: 0,
    }),
    (err: unknown) => {
      assert(err instanceof TurnWaitTimeoutError);
      assert.equal(err.abortedCloudTurn, true);
      return true;
    },
  );
  assert.deepEqual(fake2.abortedTurns, ["turn-2"]);
});

test("waitForTurn handles AbortSignal without aborting cloud turn and returns failed turn records", async () => {
  const fake = createFakeRealtime({ "turn-1": makeTurn({ id: "turn-1", status: "running" }) });
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 20);
  await assert.rejects(
    waitForTurn({
      client: fake.client,
      spaceId: "space-1",
      sessionId: "sess-1",
      turnId: "turn-1",
      signal: controller.signal,
      reconcileIntervalMs: 0,
    }),
    (err: unknown) => err instanceof TurnWaitAbortedError,
  );
  assert.deepEqual(fake.abortedTurns, []);

  const failedFake = createFakeRealtime({
    "turn-fail": makeTurn({ id: "turn-fail", status: "failed", errorMessage: "Model error" }),
  });
  const failed = await waitForTurn({
    client: failedFake.client,
    spaceId: "space-1",
    sessionId: "sess-1",
    turnId: "turn-fail",
    reconcileIntervalMs: 0,
  });
  assert.equal(failed.turn.status, "failed");
  assert.equal(failed.turn.errorMessage, "Model error");
});
