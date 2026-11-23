import assert from "node:assert/strict";
import { test } from "node:test";
import type {
  GenerationStreamSubscriptionHandlers,
  SessionSubscriptionHandlers,
  SessionTurnRecord,
  SessionTurnResponse,
  WebSocketConnectionState,
} from "@neta-art/cohub";
import {
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

type SessionEvent = Parameters<NonNullable<SessionSubscriptionHandlers["turnFinalized"]>>[0];

const tick = (ms = 15) => new Promise((r) => setTimeout(r, ms));
const textBlock = (text: string) => [{ type: "text" as const, text }];

function createFakeRealtime(turnsById: Record<string, SessionTurnRecord>, options: { sessionSpaceId?: string; cancelStatus?: number; getError?: Error } = {}) {
  let sessionHandlers: SessionSubscriptionHandlers | null = null;
  let generationHandlers: GenerationStreamSubscriptionHandlers | null = null;
  let connectionHandler: ((state: WebSocketConnectionState) => void) | null = null;
  const abortedTurns: Array<string | null | undefined> = [];
  const cancelledTurns: string[] = [];

  const client: TurnWaitClient = {
    space: () => ({
      session: () => ({
        subscribe: (handlers) => {
          sessionHandlers = handlers;
          return () => { sessionHandlers = null; };
        },
        subscribeGeneration: (handlers) => {
          generationHandlers = handlers;
          return () => { generationHandlers = null; };
        },
        turns: {
          get: async (turnId) => {
            if (options.getError) throw options.getError;
            const turn = turnsById[turnId];
            if (!turn) throw Object.assign(new Error("turn not found"), { status: 404 });
            return { session: { id: "sess-1", spaceId: options.sessionSpaceId ?? "space-1" }, turn } as SessionTurnResponse;
          },
        },
        abort: async (input) => {
          abortedTurns.push(input?.turnId);
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
      return () => { connectionHandler = null; };
    },
    disconnect: async () => {},
  };

  return {
    abortedTurns,
    cancelledTurns,
    wait: (input: Partial<Parameters<typeof waitForTurn>[0]> = {}) =>
      waitForTurn({ client, spaceId: "space-1", sessionId: "sess-1", turnId: "turn-1", reconcileIntervalMs: 0, ...input }),
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
    emitReconnect: () => connectionHandler?.({ state: "open", willReconnect: false }),
  };
}

test("parseWaitTimeout accepts durations within setTimeout's range", () => {
  assert.equal(parseWaitTimeout("500ms"), 500);
  assert.equal(parseWaitTimeout("10m"), 600_000);
  assert.equal(parseWaitTimeout("45"), 45_000);
  for (const invalid of ["0s", "-5s", "abc", "30d"]) assert.throws(() => parseWaitTimeout(invalid));
});

test("a turn that finished before subscribing settles at once", async () => {
  const fake = createFakeRealtime({ "turn-1": makeTurn({ status: "completed", assistantText: "Already done" }) });
  const result = await fake.wait();
  assert.equal(result.response.turn.assistantText, "Already done");
});

test("streaming prints only new text of the waited turn", async () => {
  const turns = { "turn-1": makeTurn() };
  const fake = createFakeRealtime(turns);
  const chunks: string[] = [];
  const pending = fake.wait({ onTextDelta: (delta) => chunks.push(delta) });

  await tick();
  fake.emitText("turn-1", "m1", "Hi ");
  fake.emitText("other-turn", "m9", "NOPE");
  fake.emitText("turn-1", "m1", "Hi there!");
  turns["turn-1"] = makeTurn({ status: "completed", assistantContent: textBlock("Hi there!") });
  fake.emitFinalized("turn-1");

  const result = await pending;
  assert.deepEqual(chunks, ["Hi ", "there!"]);
  assert.equal(result.streamComplete, true);
});

test("a stream that does not match the final reply is reported incomplete", async () => {
  const turns = { "turn-1": makeTurn() };
  const fake = createFakeRealtime(turns);
  const pending = fake.wait({ onTextDelta: () => {} });

  await tick();
  fake.emitText("turn-1", "m1", "Hello wrld");
  fake.emitText("turn-1", "m1", "Hello world");
  turns["turn-1"] = makeTurn({ status: "completed", assistantContent: textBlock("Hello world") });
  fake.emitFinalized("turn-1");

  assert.equal((await pending).streamComplete, false);
});

test("a reconnect reconciles a missed finalize", async () => {
  const turns = { "turn-1": makeTurn() };
  const fake = createFakeRealtime(turns);
  const pending = fake.wait();

  await tick();
  turns["turn-1"] = makeTurn({ status: "completed", assistantText: "Recovered" });
  fake.emitReconnect();

  assert.equal((await pending).response.turn.assistantText, "Recovered");
});

test("merged turns are followed to the turn they merged into, without looping", async () => {
  const turns = {
    "turn-1": makeTurn({ status: "merged", summary: { finishReason: "merged", mergedIntoTurnId: "turn-2" } }),
    "turn-2": makeTurn({ id: "turn-2", status: "completed" }),
  };
  const result = await createFakeRealtime(turns).wait();
  assert.equal(result.resolvedTurnId, "turn-2");
  assert.deepEqual(result.mergedChain, ["turn-1"]);

  const cyclic = createFakeRealtime({ "turn-1": makeTurn({ status: "merged", summary: { finishReason: "merged", mergedIntoTurnId: "turn-1" } }) });
  assert.equal((await cyclic.wait()).response.turn.status, "merged");
});

test("a timeout stops the cloud turn only with abortOnTimeout, and never claims a stop that did not happen", async () => {
  const timedOut = (abortedCloudTurn: boolean) => (err: unknown) => err instanceof TurnWaitTimeoutError && err.abortedCloudTurn === abortedCloudTurn;

  const left = createFakeRealtime({ "turn-1": makeTurn() });
  await assert.rejects(left.wait({ timeoutMs: 30 }), timedOut(false));
  assert.deepEqual(left.abortedTurns, []);

  const running = createFakeRealtime({ "turn-1": makeTurn() });
  await assert.rejects(running.wait({ timeoutMs: 30, abortOnTimeout: true }), timedOut(true));
  assert.deepEqual(running.abortedTurns, ["turn-1"]);

  const queued = createFakeRealtime({ "turn-1": makeTurn({ status: "queued" }) });
  await assert.rejects(queued.wait({ timeoutMs: 30, abortOnTimeout: true }), timedOut(true));
  assert.deepEqual(queued.cancelledTurns, ["turn-1"]);

  const turns = { "turn-1": makeTurn({ status: "queued" }) };
  const merged = createFakeRealtime(turns, { cancelStatus: 409 });
  const pending = merged.wait({ timeoutMs: 30, abortOnTimeout: true });
  await tick();
  turns["turn-1"] = makeTurn({ status: "merged", summary: { finishReason: "merged", mergedIntoTurnId: "owner" } });
  await assert.rejects(pending, timedOut(false));
  assert.deepEqual(merged.abortedTurns, []);
});

test("an interrupted wait leaves the cloud turn running", async () => {
  const fake = createFakeRealtime({ "turn-1": makeTurn() });
  await assert.rejects(fake.wait({ signal: AbortSignal.timeout(20) }), (err: unknown) => err instanceof TurnWaitAbortedError);
  assert.deepEqual(fake.abortedTurns, []);
});

test("a session from another Space is rejected and never stopped", async () => {
  const fake = createFakeRealtime({ "turn-1": makeTurn() }, { sessionSpaceId: "space-2" });
  await assert.rejects(fake.wait({ timeoutMs: 50, abortOnTimeout: true }), (err: unknown) => (err as { status?: number }).status === 404);
  assert.deepEqual(fake.abortedTurns, []);
});

test("errors that retrying cannot fix, such as being signed out, end the wait at once", async () => {
  const signedOut = new Error("Not signed in");
  await assert.rejects(createFakeRealtime({}, { getError: signedOut }).wait(), (err: unknown) => err === signedOut);
});
