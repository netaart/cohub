import {
  HttpError,
  type ContentBlock,
  type GenerationStreamSubscribeOptions,
  type GenerationStreamSubscriptionHandlers,
  type SessionSubscriptionHandlers,
  type SessionTurnRecord,
  type SessionTurnResponse,
  type WebSocketConnectionState,
} from "@neta-art/cohub";
import { isFetchFailure } from "./network-error.js";

type SessionTurnStatus = SessionTurnRecord["status"];
type SessionEvent = Parameters<NonNullable<SessionSubscriptionHandlers["turnUpdated"]>>[0];

const TERMINAL_TURN_STATUSES = new Set<SessionTurnStatus>([
  "completed",
  "failed",
  "interrupted",
  "merged",
  "cancelled",
]);

const DURATION_RE = /^(\d+)(ms|s|m|h|d)?$/i;
const DURATION_UNITS: Record<string, number> = {
  ms: 1,
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
};
// setTimeout fires after 1ms for anything longer.
const MAX_TIMEOUT_MS = 2_147_483_647;
const DEFAULT_RECONCILE_INTERVAL_MS = 15_000;
const STOP_REQUEST_TIMEOUT_MS = 10_000;
const MAX_MERGED_HOPS = 20;

/** Parse a positive wait duration such as `90s`, `10m`, `2h`, `5000ms`, or plain seconds `60`. */
export function parseWaitTimeout(value: string): number {
  const match = DURATION_RE.exec(value.trim());
  const ms = match ? Number(match[1]) * (DURATION_UNITS[(match[2] ?? "s").toLowerCase()] ?? 1_000) : Number.NaN;
  if (!Number.isSafeInteger(ms) || ms <= 0 || ms > MAX_TIMEOUT_MS) {
    throw new Error("Use a positive duration up to 24d, such as 90s, 10m, or 2h.");
  }
  return ms;
}

type TurnRef = { spaceId: string; sessionId: string; turnId: string };

/** Lowercase hyphenated form, so short or uppercase IDs still match server records. */
function canonicalId(value: string): string {
  const id = value.trim().toLowerCase();
  return /^[0-9a-f]{32}$/.test(id) ? `${id.slice(0, 8)}-${id.slice(8, 12)}-${id.slice(12, 16)}-${id.slice(16, 20)}-${id.slice(20)}` : id;
}

export class TurnWaitTimeoutError extends Error {
  readonly ref: TurnRef;
  readonly timeoutMs: number;
  /** The server accepted the stop request. */
  readonly abortedCloudTurn: boolean;
  /** Why a requested stop did not go through. */
  readonly abortError: string | null;

  constructor(ref: TurnRef, input: { timeoutMs: number; abortedCloudTurn: boolean; abortError: string | null }) {
    super(`Timed out waiting for turn ${ref.turnId} after ${input.timeoutMs}ms`);
    this.name = "TurnWaitTimeoutError";
    this.ref = ref;
    this.timeoutMs = input.timeoutMs;
    this.abortedCloudTurn = input.abortedCloudTurn;
    this.abortError = input.abortError;
  }
}

export class TurnWaitAbortedError extends Error {
  readonly ref: TurnRef;
  /** Interrupted after the timeout had already sent a stop request. */
  readonly stopRequested: boolean;

  constructor(ref: TurnRef, stopRequested = false) {
    super(`Stopped waiting for turn ${ref.turnId}`);
    this.name = "TurnWaitAbortedError";
    this.ref = ref;
    this.stopRequested = stopRequested;
  }
}

export type TurnWaitSessionClient = {
  subscribe(handlers: SessionSubscriptionHandlers): () => void;
  subscribeGeneration(handlers: GenerationStreamSubscriptionHandlers, options?: GenerationStreamSubscribeOptions): () => void;
  turns: {
    get(turnId: string, request?: { signal?: AbortSignal }): Promise<SessionTurnResponse>;
  };
  abort(options?: { turnId?: string | null }): Promise<{ ok: true }>;
  cancelTurn(turnId: string): Promise<unknown>;
};

export type TurnWaitClient = {
  space(spaceId: string): {
    session(sessionId: string): TurnWaitSessionClient;
  };
  onConnection(handler: (state: WebSocketConnectionState) => void): () => void;
  disconnect(): Promise<void>;
};

export type TurnWaitResult = {
  spaceId: string;
  sessionId: string;
  turnId: string;
  resolvedTurnId: string;
  mergedChain: string[];
  /** Final HTTP state of the resolved turn, with its session and billing. */
  response: SessionTurnResponse;
  streamedText: boolean;
  /** The last streamed message matches the final reply, so nothing needs reprinting. */
  streamComplete: boolean;
};

export type WaitForTurnOptions = {
  client: TurnWaitClient;
  spaceId: string;
  sessionId: string;
  turnId: string;
  /** The response that created the turn; it already confirms the session and status. */
  initial?: SessionTurnResponse;
  timeoutMs?: number;
  abortOnTimeout?: boolean;
  reconcileIntervalMs?: number;
  signal?: AbortSignal;
  onTextDelta?: (delta: string) => void;
  onTurnMerged?: (fromTurnId: string, toTurnId: string) => void;
  onStatus?: (status: SessionTurnStatus, turnId: string) => void;
};

const textOf = (blocks: readonly ContentBlock[] | null | undefined) =>
  (blocks ?? []).flatMap((block) => (block.type === "text" && block.text ? [block.text] : [])).join("\n\n");

/** The final reply with its formatting; `assistantText` is a whitespace-collapsed preview. */
export const finalReplyText = (turn: SessionTurnRecord) => textOf(turn.assistantContent) || turn.assistantText || "";

const errorStatus = (error: unknown) => (error as { status?: unknown })?.status;

// Only failures that can clear up on their own are retried; auth and other client errors surface at once.
function isTransientError(error: unknown): boolean {
  const status = errorStatus(error);
  if (typeof status === "number") return status === 408 || status === 429 || status >= 500;
  return isFetchFailure(error);
}

function eventTurnId(event: SessionEvent): string | null {
  const payload = event.payload as Record<string, unknown> | undefined;
  if (!payload || typeof payload !== "object") return null;
  if (typeof payload.turnId === "string" && payload.turnId) return payload.turnId;
  const turn = payload.turn;
  if (turn && typeof turn === "object" && "id" in turn && typeof (turn as { id?: unknown }).id === "string") {
    return (turn as { id: string }).id;
  }
  return null;
}

async function withDeadline<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(message)), ms); }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** Stop a turn: a queued follow-up is cancelled, an active turn aborted. Returns why it failed, or null. */
async function stopTurn(session: TurnWaitSessionClient, turnId: string, status: SessionTurnStatus | null): Promise<string | null> {
  const request = async () => {
    if (status === "queued") {
      try {
        await session.cancelTurn(turnId);
        return;
      } catch (error) {
        if (errorStatus(error) !== 409) throw error;
        // The turn moved on; only a turn that is now running can still be aborted.
        const { turn } = await session.turns.get(turnId);
        if (turn.status === "queued") throw error;
        if (turn.status === "merged") throw new Error(`Turn was merged into ${turn.summary?.mergedIntoTurnId ?? "another turn"}, which was not stopped`);
        if (turn.status !== "running" && turn.status !== "abort_requested") throw new Error(`Turn already ${turn.status}`);
      }
    }
    await session.abort({ turnId });
  };
  try {
    await withDeadline(request(), STOP_REQUEST_TIMEOUT_MS, "Stop request timed out");
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

/**
 * Wait for a Session turn to reach a terminal status using Cohub's realtime WebSocket
 * paired with HTTP `turns.get` reconciliation.
 *
 * - Reconciles immediately after subscribing and after every WS reconnect so fast turns
 *   or drops never hang.
 * - Automatically follows `merged` turns via `summary.mergedIntoTurnId` (with cycle guard).
 * - Leaves the cloud turn running on timeout/abort unless `abortOnTimeout` is explicitly true.
 */
export async function waitForTurn(options: WaitForTurnOptions): Promise<TurnWaitResult> {
  const {
    client,
    initial,
    timeoutMs,
    abortOnTimeout = false,
    reconcileIntervalMs = DEFAULT_RECONCILE_INTERVAL_MS,
    signal,
    onTextDelta,
    onTurnMerged,
    onStatus,
  } = options;
  const spaceId = canonicalId(options.spaceId);
  const sessionId = canonicalId(options.sessionId);
  const turnId = canonicalId(options.turnId);

  if (signal?.aborted) {
    throw new TurnWaitAbortedError({ spaceId, sessionId, turnId });
  }

  const session = client.space(spaceId).session(sessionId);
  let currentTurnId = turnId;
  const visited = new Set<string>([turnId]);
  const mergedChain: string[] = [];
  let streamedText = false;
  /** Text printed for the assistant message currently streaming. */
  let printed = "";
  /** Assistant message the printed text belongs to, and whether it was rewritten after printing. */
  let printedMessageId: string | null = null;
  let diverged = false;
  const belongsHere = (response: SessionTurnResponse) => response.session.spaceId === spaceId && response.session.id === sessionId;
  // Nothing is stopped until a response shows the session belongs to `spaceId`.
  let verified = Boolean(initial && belongsHere(initial) && initial.turn.id === turnId);
  let lastStatus: SessionTurnStatus | null = verified && initial ? initial.turn.status : null;

  return await new Promise<TurnWaitResult>((resolve, reject) => {
    let settled = false;
    // After the deadline only the stop request or Ctrl-C decide the outcome.
    let stopping = false;
    let reconciling = false;
    let reconcileQueued = false;
    let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
    let intervalTimer: ReturnType<typeof setInterval> | undefined;
    let unsubscribes: Array<() => void> = [];

    const stopListening = () => {
      if (timeoutTimer) clearTimeout(timeoutTimer);
      if (intervalTimer) clearInterval(intervalTimer);
      timeoutTimer = undefined;
      intervalTimer = undefined;
      for (const unsubscribe of unsubscribes) unsubscribe();
      unsubscribes = [];
    };

    const cleanup = () => {
      stopListening();
      signal?.removeEventListener("abort", onAbort);
    };

    const finish = (result: TurnWaitResult) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(result);
    };

    const fail = (err: unknown) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(err);
    };

    const onAbort = () => {
      fail(new TurnWaitAbortedError({ spaceId, sessionId, turnId: currentTurnId }, stopping));
    };

    const reconcile = async () => {
      if (settled || stopping) return;
      if (reconciling) {
        reconcileQueued = true;
        return;
      }
      reconciling = true;
      try {
        while (!settled) {
          reconcileQueued = false;
          let response: SessionTurnResponse;
          try {
            response = await session.turns.get(currentTurnId, signal ? { signal } : undefined);
          } catch (err: unknown) {
            if (signal?.aborted) {
              onAbort();
              return;
            }
            if (settled || stopping) return;
            // Transient: keep waiting for the next WS event or safety-net tick.
            if (!isTransientError(err)) fail(err);
            return;
          }
          if (settled || stopping) return;
          if (!belongsHere(response)) {
            fail(new HttpError("Session not found in this space", 404, { code: "session_context_mismatch" }));
            return;
          }
          verified = true;
          const turn = response.turn;
          if (turn.status !== lastStatus) {
            lastStatus = turn.status;
            onStatus?.(turn.status, turn.id);
          }
          if (turn.status === "merged") {
            const nextId = turn.summary?.mergedIntoTurnId?.trim();
            if (nextId && !visited.has(nextId) && mergedChain.length < MAX_MERGED_HOPS) {
              const previousId = currentTurnId;
              mergedChain.push(previousId);
              visited.add(nextId);
              currentTurnId = nextId;
              printed = "";
              printedMessageId = null;
              diverged = false;
              lastStatus = null;
              onTurnMerged?.(previousId, nextId);
              reconcileQueued = true;
              continue;
            }
          }
          if (TERMINAL_TURN_STATUSES.has(turn.status)) {
            finish({
              spaceId,
              sessionId,
              turnId,
              resolvedTurnId: turn.id,
              mergedChain,
              response,
              streamedText,
              streamComplete: streamedText && !diverged && printed === finalReplyText(turn),
            });
            return;
          }
          if (!reconcileQueued) return;
        }
      } finally {
        reconciling = false;
      }
    };

    const scheduleReconcile = () => {
      if (settled || stopping) return;
      void reconcile();
    };

    signal?.addEventListener("abort", onAbort, { once: true });

    if (timeoutMs !== undefined) {
      timeoutTimer = setTimeout(() => {
        timeoutTimer = undefined;
        if (settled) return;
        const timedOutTurnId = currentTurnId;
        const timeout = (abortedCloudTurn: boolean, abortError: string | null) =>
          fail(new TurnWaitTimeoutError({ spaceId, sessionId, turnId: timedOutTurnId }, { timeoutMs, abortedCloudTurn, abortError }));
        if (!abortOnTimeout) return timeout(false, null);
        if (!verified) return timeout(false, "The turn was never confirmed in this Space, so nothing was stopped");
        stopping = true;
        stopListening();
        void stopTurn(session, timedOutTurnId, lastStatus).then((abortError) => timeout(abortError === null, abortError));
      }, timeoutMs);
    }

    unsubscribes.push(client.onConnection(({ state }) => {
      if (state === "open") scheduleReconcile();
    }));

    const onTurnEvent = (event: SessionEvent) => {
      const id = eventTurnId(event);
      if (!id || id === currentTurnId) scheduleReconcile();
    };
    unsubscribes.push(session.subscribe({
      turnUpdated: onTurnEvent,
      turnFinalized: onTurnEvent,
      error: (event) => {
        // A denied subscription still reconciles over HTTP, which surfaces any 403/404 cleanly.
        if (event.type === "system.subscribe.error") scheduleReconcile();
        else onTurnEvent(event);
      },
    }));

    if (onTextDelta) {
      // The generation stream seeds an in-flight message from the server snapshot and resyncs after gaps.
      unsubscribes.push(session.subscribeGeneration({
        state: ({ state, messageId }) => {
          if (settled || stopping || (state.turnId && state.turnId !== currentTurnId)) return;
          const text = textOf(state.contentBlocks);
          // A new message's boundary waits for its first visible text, so the separator lands with it.
          if (!text && messageId !== printedMessageId) return;
          let delta: string;
          // Without message IDs, text that stops extending the printed text is the next message.
          if (messageId !== printedMessageId || (messageId === null && !text.startsWith(printed))) {
            delta = `${streamedText && text ? "\n\n" : ""}${text}`;
            printedMessageId = messageId;
            diverged = false;
          } else if (text.startsWith(printed)) {
            delta = text.slice(printed.length);
          } else {
            delta = "";
            diverged = true;
          }
          printed = text;
          if (!delta) return;
          streamedText = true;
          onTextDelta(delta);
        },
      }, { recover: true }));
    }

    if (reconcileIntervalMs > 0) {
      intervalTimer = setInterval(scheduleReconcile, reconcileIntervalMs);
    }

    // Immediate HTTP reconciliation eliminates the race where the turn settled before WS subscribed.
    scheduleReconcile();
  });
}
