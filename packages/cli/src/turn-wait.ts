import type {
  SessionSubscriptionHandlers,
  SessionTurnRecord,
  SessionTurnResponse,
  WebSocketConnectionState,
} from "@neta-art/cohub";

export type SessionTurnStatus = SessionTurnRecord["status"];
type SessionEvent = Parameters<NonNullable<SessionSubscriptionHandlers["patch"]>>[0];

export const TERMINAL_TURN_STATUSES = new Set<SessionTurnStatus>([
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
const DEFAULT_RECONCILE_INTERVAL_MS = 15_000;
const MAX_MERGED_HOPS = 20;

export function isTerminalTurnStatus(status: SessionTurnStatus): boolean {
  return TERMINAL_TURN_STATUSES.has(status);
}

/** Parse a positive wait duration such as `90s`, `10m`, `2h`, `5000ms`, or plain seconds `60`. */
export function parseWaitTimeout(value: string): number {
  const match = DURATION_RE.exec(value.trim());
  if (!match) {
    throw new Error("Use a positive duration such as 90s, 10m, or 2h.");
  }
  const amount = Number(match[1]);
  const unit = (match[2] ?? "s").toLowerCase();
  const ms = amount * (DURATION_UNITS[unit] ?? 1_000);
  if (!Number.isSafeInteger(ms) || ms <= 0) {
    throw new Error("Use a positive duration such as 90s, 10m, or 2h.");
  }
  return ms;
}

export class TurnWaitTimeoutError extends Error {
  readonly spaceId: string;
  readonly sessionId: string;
  readonly turnId: string;
  readonly timeoutMs: number;
  readonly abortedCloudTurn: boolean;

  constructor(input: {
    spaceId: string;
    sessionId: string;
    turnId: string;
    timeoutMs: number;
    abortedCloudTurn: boolean;
  }) {
    super(`Timed out waiting for turn ${input.turnId} after ${input.timeoutMs}ms`);
    this.name = "TurnWaitTimeoutError";
    this.spaceId = input.spaceId;
    this.sessionId = input.sessionId;
    this.turnId = input.turnId;
    this.timeoutMs = input.timeoutMs;
    this.abortedCloudTurn = input.abortedCloudTurn;
  }
}

export class TurnWaitAbortedError extends Error {
  readonly spaceId: string;
  readonly sessionId: string;
  readonly turnId: string;

  constructor(input: { spaceId: string; sessionId: string; turnId: string }) {
    super(`Stopped waiting for turn ${input.turnId}`);
    this.name = "TurnWaitAbortedError";
    this.spaceId = input.spaceId;
    this.sessionId = input.sessionId;
    this.turnId = input.turnId;
  }
}

export type TurnWaitSessionClient = {
  subscribe(handlers: SessionSubscriptionHandlers): () => void;
  turns: {
    get(turnId: string, request?: { signal?: AbortSignal }): Promise<SessionTurnResponse>;
  };
  abort(options?: { turnId?: string | null }): Promise<{ ok: true }>;
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
  turn: SessionTurnRecord;
  streamedText: boolean;
};

export type WaitForTurnOptions = {
  client: TurnWaitClient;
  spaceId: string;
  sessionId: string;
  turnId: string;
  timeoutMs?: number;
  abortOnTimeout?: boolean;
  reconcileIntervalMs?: number;
  signal?: AbortSignal;
  onTextDelta?: (delta: string) => void;
  onTurnMerged?: (fromTurnId: string, toTurnId: string) => void;
  onStatus?: (status: SessionTurnStatus, turnId: string) => void;
};

type PatchOp = { o?: string; p?: string; v?: unknown };

/** Extract incremental text chunks from a `session.turn.patch` event's `ops` array. */
export function extractPatchTextDeltas(
  ops: readonly PatchOp[] | undefined,
  state: { lastAppendPath: string | null },
): string[] {
  const chunks: string[] = [];
  for (const op of ops ?? []) {
    if (op.o === "append" && typeof op.v === "string" && op.p?.endsWith("/text")) {
      state.lastAppendPath = op.p;
      if (op.v) chunks.push(op.v);
      continue;
    }
    if (op.o === "append" && typeof op.p === "string") {
      state.lastAppendPath = op.p;
      continue;
    }
    if (!op.o && !op.p && typeof op.v === "string" && state.lastAppendPath?.endsWith("/text")) {
      if (op.v) chunks.push(op.v);
    }
  }
  return chunks;
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
    spaceId,
    sessionId,
    turnId,
    timeoutMs,
    abortOnTimeout = false,
    reconcileIntervalMs = DEFAULT_RECONCILE_INTERVAL_MS,
    signal,
    onTextDelta,
    onTurnMerged,
    onStatus,
  } = options;

  if (signal?.aborted) {
    throw new TurnWaitAbortedError({ spaceId, sessionId, turnId });
  }

  const session = client.space(spaceId).session(sessionId);
  let currentTurnId = turnId;
  const visited = new Set<string>([turnId]);
  const mergedChain: string[] = [];
  const patchState = { lastAppendPath: null as string | null };
  let streamedText = false;
  let lastReportedStatus: SessionTurnStatus | null = null;

  return await new Promise<TurnWaitResult>((resolve, reject) => {
    let settled = false;
    let reconciling = false;
    let reconcileQueued = false;
    let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
    let intervalTimer: ReturnType<typeof setInterval> | undefined;
    let unsubscribeSession: (() => void) | undefined;
    let unsubscribeConnection: (() => void) | undefined;

    const cleanup = () => {
      if (timeoutTimer) clearTimeout(timeoutTimer);
      if (intervalTimer) clearInterval(intervalTimer);
      timeoutTimer = undefined;
      intervalTimer = undefined;
      unsubscribeSession?.();
      unsubscribeConnection?.();
      unsubscribeSession = undefined;
      unsubscribeConnection = undefined;
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
      fail(new TurnWaitAbortedError({ spaceId, sessionId, turnId: currentTurnId }));
    };

    const reconcile = async () => {
      if (settled) return;
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
            const status = (err as { status?: number })?.status;
            if (status === 401 || status === 403 || status === 404) {
              fail(err);
              return;
            }
            // Transient network / 5xx error: keep waiting for next WS event or safety-net tick.
            return;
          }
          if (settled) return;
          const turn = response.turn;
          if (turn.status !== lastReportedStatus) {
            lastReportedStatus = turn.status;
            onStatus?.(turn.status, turn.id);
          }
          if (turn.status === "merged") {
            const nextId = turn.summary?.mergedIntoTurnId?.trim();
            if (nextId && !visited.has(nextId) && mergedChain.length < MAX_MERGED_HOPS) {
              const previousId = currentTurnId;
              mergedChain.push(previousId);
              visited.add(nextId);
              currentTurnId = nextId;
              patchState.lastAppendPath = null;
              lastReportedStatus = null;
              onTurnMerged?.(previousId, nextId);
              reconcileQueued = true;
              continue;
            }
          }
          if (isTerminalTurnStatus(turn.status)) {
            finish({
              spaceId,
              sessionId,
              turnId,
              resolvedTurnId: turn.id,
              mergedChain,
              turn,
              streamedText,
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
      if (settled) return;
      void reconcile();
    };

    signal?.addEventListener("abort", onAbort, { once: true });

    if (timeoutMs !== undefined) {
      timeoutTimer = setTimeout(() => {
        if (settled) return;
        settled = true;
        cleanup();
        const timedOutTurnId = currentTurnId;
        if (!abortOnTimeout) {
          reject(new TurnWaitTimeoutError({
            spaceId,
            sessionId,
            turnId: timedOutTurnId,
            timeoutMs,
            abortedCloudTurn: false,
          }));
          return;
        }
        void session.abort({ turnId: timedOutTurnId })
          .then(
            () => true,
            () => false,
          )
          .then((abortedCloudTurn) => {
            reject(new TurnWaitTimeoutError({
              spaceId,
              sessionId,
              turnId: timedOutTurnId,
              timeoutMs,
              abortedCloudTurn,
            }));
          });
      }, timeoutMs);
    }

    unsubscribeConnection = client.onConnection(({ state }) => {
      if (state === "open") scheduleReconcile();
    });

    unsubscribeSession = session.subscribe({
      patch: (event) => {
        if (settled || !onTextDelta) return;
        const id = eventTurnId(event);
        if (id && id !== currentTurnId) return;
        const ops = (event.payload as { ops?: PatchOp[] } | undefined)?.ops;
        for (const chunk of extractPatchTextDeltas(ops, patchState)) {
          streamedText = true;
          onTextDelta(chunk);
        }
      },
      turnUpdated: (event) => {
        const id = eventTurnId(event);
        if (!id || id === currentTurnId) scheduleReconcile();
      },
      turnFinalized: (event) => {
        const id = eventTurnId(event);
        if (!id || id === currentTurnId) scheduleReconcile();
      },
      error: (event) => {
        if (event.type === "system.subscribe.error") {
          // Subscription denied; still reconcile over HTTP which surfaces any 403/404 cleanly.
          scheduleReconcile();
          return;
        }
        const id = eventTurnId(event);
        if (!id || id === currentTurnId) scheduleReconcile();
      },
    });

    if (reconcileIntervalMs > 0) {
      intervalTimer = setInterval(scheduleReconcile, reconcileIntervalMs);
    }

    // Immediate HTTP reconciliation eliminates the race where the turn settled before WS subscribed.
    scheduleReconcile();
  });
}
