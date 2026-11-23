import assert from "node:assert/strict";
import { test } from "node:test";
import type {
  GenerationStreamSubscriptionHandlers,
  SessionSubscriptionHandlers,
  SessionTurnRecord,
  SessionTurnResponse,
  WebSocketConnectionState,
} from "@neta-art/cohub";
type SessionEvent = Parameters<NonNullable<SessionSubscriptionHandlers["turnFinalized"]>>[0];

import {
  canonicalId,
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

const tick = (ms = 15) => new Promise((r) => setTimeout(r, ms));

function createFakeRealtime(turnsById: Record<string, SessionTurnRecord>, options: { sessionSpaceId?: string; cancelStatus?: number; getDelayMs?: number; abortDelayMs?: number } = {}) {
  let sessionHandlers: SessionSubscriptionHandlers | null = null;
  let generationHandlers: GenerationStreamSubscriptionHandlers | null = null;
  let connectionHandler: ((state: WebSocketConnectionState) => void) | null = null;
  const abortedTurns: Array<string | null | undefined> = [];
  const cancelledTurns: string[] = [];
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
        subscribeGeneration: (handlers) => {
          generationHandlers = handlers;
          return () => {
            generationHandlers = null;
          };
        },
        turns: {
          get: async (turnId) => {
            if (options.getDelayMs) await tick(options.getDelayMs);
            const turn = turnsById[turnId];
            if (!turn) {
              const err = Object.assign(new Error("turn not found"), { status: 404 });
              throw err;
            }
            return { session: { id: "sess-1", spaceId: options.sessionSpaceId ?? "space-1" }, turn } as SessionTurnResponse;
          },
        },
        abort: async (input) => {
          abortedTurns.push(input?.turnId);
          if (options.abortDelayMs) await tick(options.abortDelayMs);
          return { ok: true };
        },
        cancelTurn: async (turnId) => {
          if (options.cancelStatus) throw Object.assign(new Error("turn is not queued"), { status: options.cancelStatus });
          cancelledTurns.push(turnId);
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
    cancelledTurns,
    isUnsubscribed: () => unsubscribed,
    emitText: (turnId: string, messageId: string, text: string) => {
      generationHandlers?.state?.({
        type: "state",
        source: "patch",
        state: { spaceId: "space-1", sessionId: "sess-1", status: "streaming", contentBlocks: [{ type: "text", text }], anchorUserMessageId: null, patchSeq: 1, turnId, appendPath: null },
        messageId,
        messageOrdinal: null,
        intermediateMessages: [],
        rawEvent: null,
      });
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

const textBlock = (text: string) => [{ type: "text" as const, text }];

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
  assert.throws(() => parseWaitTimeout("30d"));
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
  assert.equal(result.response.turn.assistantText, "Already done");
  assert.equal(result.streamedText, false);
  assert.equal(fake.isUnsubscribed(), true);
});

test("waitForTurn streams only new text of the waited turn and settles on turn.finalized", async () => {
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

  await tick();
  fake.emitText("turn-1", "m1", "Hi ");
  fake.emitText("other-turn", "m9", "NOPE");
  fake.emitText("turn-1", "m1", "Hi there!");

  turns["turn-1"] = makeTurn({ id: "turn-1", status: "completed", assistantText: "Hi there!", assistantContent: textBlock("Hi there!") });
  fake.emitFinalized("turn-1");

  const result = await pending;
  assert.deepEqual(chunks, ["Hi ", "there!"]);
  assert.equal(result.streamedText, true);
  assert.equal(result.streamComplete, true);
  assert.equal(result.response.turn.assistantText, "Hi there!");
});

test("waitForTurn separates assistant messages and judges completeness by the final one", async () => {
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

  await tick();
  fake.emitText("turn-1", "m1", "Checking.");
  fake.emitText("turn-1", "m2", "");
  fake.emitText("turn-1", "m2", "All pass.");
  turns["turn-1"] = makeTurn({ id: "turn-1", status: "completed", assistantText: "All pass.", assistantContent: textBlock("All pass.") });
  fake.emitFinalized("turn-1");

  const result = await pending;
  assert.equal(chunks.join(""), "Checking.\n\nAll pass.");
  assert.equal(result.streamComplete, true);
});

test("waitForTurn reports an incomplete stream when printed text was rewritten", async () => {
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

  await tick();
  fake.emitText("turn-1", "m1", "Hello wrld");
  fake.emitText("turn-1", "m1", "Hello world");
  turns["turn-1"] = makeTurn({ id: "turn-1", status: "completed", assistantText: "Hello world", assistantContent: textBlock("Hello world") });
  fake.emitFinalized("turn-1");

  const result = await pending;
  assert.deepEqual(chunks, ["Hello wrld"]);
  assert.equal(result.streamedText, true);
  assert.equal(result.streamComplete, false);
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
  assert.equal(result.response.turn.assistantText, "Recovered");
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
  fake.emitText("turn-2", "m1", "Combined reply");
  turns["turn-2"] = makeTurn({ id: "turn-2", status: "completed", assistantText: "Combined reply", assistantContent: textBlock("Combined reply") });
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
  assert.equal(cyclicRes.response.turn.status, "merged");
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
      assert.equal(err.ref.turnId, "turn-1");
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
  assert.equal(failed.response.turn.status, "failed");
  assert.equal(failed.response.turn.errorMessage, "Model error");
});

test("waitForTurn cancels a queued turn on timeout and reports a failed stop with its reason", async () => {
  const queued = createFakeRealtime({ "turn-q": makeTurn({ id: "turn-q", status: "queued" }) });
  await assert.rejects(
    waitForTurn({ client: queued.client, spaceId: "space-1", sessionId: "sess-1", turnId: "turn-q", timeoutMs: 30, abortOnTimeout: true, reconcileIntervalMs: 0 }),
    (err: unknown) => err instanceof TurnWaitTimeoutError && err.abortedCloudTurn,
  );
  assert.deepEqual(queued.cancelledTurns, ["turn-q"]);
  assert.deepEqual(queued.abortedTurns, []);

  const steer = createFakeRealtime({ "turn-q": makeTurn({ id: "turn-q", status: "queued", intent: "steer" }) }, { cancelStatus: 409 });
  await assert.rejects(
    waitForTurn({ client: steer.client, spaceId: "space-1", sessionId: "sess-1", turnId: "turn-q", timeoutMs: 30, abortOnTimeout: true, reconcileIntervalMs: 0 }),
    (err: unknown) => err instanceof TurnWaitTimeoutError && !err.abortedCloudTurn && err.abortError === "turn is not queued",
  );
  assert.deepEqual(steer.abortedTurns, []);

  const mergeTurns: Record<string, SessionTurnRecord> = { "turn-q": makeTurn({ id: "turn-q", status: "queued" }) };
  const merging = createFakeRealtime(mergeTurns, { cancelStatus: 409 });
  const pending = waitForTurn({ client: merging.client, spaceId: "space-1", sessionId: "sess-1", turnId: "turn-q", timeoutMs: 30, abortOnTimeout: true, reconcileIntervalMs: 0 });
  await tick();
  mergeTurns["turn-q"] = makeTurn({ id: "turn-q", status: "merged", summary: { finishReason: "merged", mergedIntoTurnId: "owner" } });
  await assert.rejects(pending, (err: unknown) => err instanceof TurnWaitTimeoutError && !err.abortedCloudTurn && /merged into owner/.test(err.abortError ?? ""));
  assert.deepEqual(merging.abortedTurns, []);

  const refused = createFakeRealtime({ "turn-q": makeTurn({ id: "turn-q", status: "queued" }) }, { cancelStatus: 403 });
  await assert.rejects(
    waitForTurn({ client: refused.client, spaceId: "space-1", sessionId: "sess-1", turnId: "turn-q", timeoutMs: 30, abortOnTimeout: true, reconcileIntervalMs: 0 }),
    (err: unknown) => err instanceof TurnWaitTimeoutError && !err.abortedCloudTurn && err.abortError === "turn is not queued",
  );
});

test("waitForTurn rejects a session from another Space and never stops it", async () => {
  const fake = createFakeRealtime({ "turn-1": makeTurn({ id: "turn-1", status: "running" }) }, { sessionSpaceId: "space-2" });
  await assert.rejects(
    waitForTurn({ client: fake.client, spaceId: "space-1", sessionId: "sess-1", turnId: "turn-1", timeoutMs: 50, abortOnTimeout: true, reconcileIntervalMs: 0 }),
    (err: unknown) => (err as { status?: number }).status === 404,
  );
  assert.deepEqual(fake.abortedTurns, []);
});

test("waitForTurn fails at once on errors that retrying cannot fix", async () => {
  const fake = createFakeRealtime({});
  const authError = new Error("Not signed in");
  const client: TurnWaitClient = {
    ...fake.client,
    space: () => ({
      session: () => ({
        ...fake.client.space("space-1").session("sess-1"),
        turns: { get: async () => { throw authError; } },
      }),
    }),
  };
  await assert.rejects(
    waitForTurn({ client, spaceId: "space-1", sessionId: "sess-1", turnId: "turn-1", reconcileIntervalMs: 0 }),
    (err: unknown) => err === authError,
  );
});

test("waitForTurn keeps the timeout outcome once the deadline fires, and stops a turn the send already confirmed", async () => {
  const turns: Record<string, SessionTurnRecord> = { "turn-1": makeTurn({ id: "turn-1", status: "running" }) };
  const racing = createFakeRealtime(turns, { abortDelayMs: 40 });
  const pending = waitForTurn({ client: racing.client, spaceId: "space-1", sessionId: "sess-1", turnId: "turn-1", timeoutMs: 30, abortOnTimeout: true, reconcileIntervalMs: 0 });
  await tick(45);
  turns["turn-1"] = makeTurn({ id: "turn-1", status: "completed" });
  racing.emitFinalized("turn-1");
  await assert.rejects(pending, (err: unknown) => err instanceof TurnWaitTimeoutError && err.abortedCloudTurn);

  const slow = createFakeRealtime({ "turn-1": makeTurn({ id: "turn-1", status: "running" }) }, { getDelayMs: 100 });
  const initial = { session: { id: "sess-1", spaceId: "space-1" }, turn: makeTurn({ id: "turn-1", status: "running" }) } as SessionTurnResponse;
  await assert.rejects(
    waitForTurn({ client: slow.client, spaceId: "space-1", sessionId: "sess-1", turnId: "turn-1", initial, timeoutMs: 20, abortOnTimeout: true, reconcileIntervalMs: 0 }),
    (err: unknown) => err instanceof TurnWaitTimeoutError && err.abortedCloudTurn,
  );
  assert.deepEqual(slow.abortedTurns, ["turn-1"]);
});

test("canonicalId expands short and uppercase UUIDs", () => {
  assert.equal(canonicalId("0F8FAD5BD9CB469FA16570867728950E"), "0f8fad5b-d9cb-469f-a165-70867728950e");
  assert.equal(canonicalId(" 0F8FAD5B-D9CB-469F-A165-70867728950E "), "0f8fad5b-d9cb-469f-a165-70867728950e");
});
