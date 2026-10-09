import type { CohubClient, SessionTurnRecord, UserSessionListItem, UserSessionsResponse } from "@neta-art/cohub";

export const DEFAULT_SESSION_FILTER_MINUTES = 30;
export const MAX_SESSION_FILTER_MINUTES = 1440;
export type SessionPageBoundary = Pick<UserSessionListItem, "lastMessageAt">;

export function parseSessionFilterMinutes(value: string): number {
  const minutes = Number(value.trim());
  if (!/^\d+$/.test(value.trim()) || !Number.isSafeInteger(minutes) || minutes < 1 || minutes > MAX_SESSION_FILTER_MINUTES) {
    throw new Error(`Enter a whole number of minutes between 1 and ${MAX_SESSION_FILTER_MINUTES}.`);
  }
  return minutes;
}

export function sessionFilterCutoff(minutes: number, now: number): number {
  return now - parseSessionFilterMinutes(String(minutes)) * 60_000;
}

export function isSessionInFilterWindow(session: SessionPageBoundary, cutoff: number): boolean {
  return session.lastMessageAt !== null && Date.parse(session.lastMessageAt) >= cutoff;
}

export function hasMoreRecentSessions(input: {
  hasMore: boolean;
  cursor: string | null;
  boundary: SessionPageBoundary | null;
  cutoff: number;
}): boolean {
  return input.hasMore && input.cursor !== null && (input.boundary === null || isSessionInFilterWindow(input.boundary, input.cutoff));
}

export function sessionPageState(response: UserSessionsResponse, previousCursor: string | null = null, previousBoundary: SessionPageBoundary | null = null): {
  hasMore: boolean;
  cursor: string | null;
  boundary: SessionPageBoundary | null;
} {
  const hasMore = response.pageInfo?.hasMore === true;
  const cursor = response.pageInfo?.nextCursor ?? null;
  if (hasMore && (!cursor || cursor === previousCursor)) {
    throw new Error("Chat pagination did not advance. Pull to refresh and retry.");
  }
  for (const session of response.sessions) {
    if (session.lastMessageAt !== null && !Number.isFinite(Date.parse(session.lastMessageAt))) {
      throw new Error(`Invalid lastMessageAt for Chat ${session.id}. Refresh Chats and retry.`);
    }
  }
  const last = response.sessions.at(-1);
  // Use the server page boundary, not the merged cache or realtime-reordered list.
  return { hasMore, cursor: hasMore ? cursor : null, boundary: last ? { lastMessageAt: last.lastMessageAt } : previousBoundary };
}

const STATUS_REQUEST_TIMEOUT_MS = 15_000;

function withTimeout<T>(promise: Promise<T>) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("Loading Chat status timed out after 15 seconds")), STATUS_REQUEST_TIMEOUT_MS);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

export type SessionStatus = "running" | "completed" | "failed" | "stopped" | "idle";

export type LatestSessionTurn = Pick<SessionTurnRecord, "id" | "sequence" | "status" | "updatedAt">;

export function latestTurn<T extends { sequence: number }>(turns: readonly T[]): T | null {
  return turns.reduce<T | null>((latest, turn) => !latest || turn.sequence > latest.sequence ? turn : latest, null);
}

export function reconcileLatestTurn(current: LatestSessionTurn | null | undefined, incoming: LatestSessionTurn | null): LatestSessionTurn | null {
  if (!incoming) return current ?? null;
  if (current) {
    if (incoming.sequence < current.sequence) return current;
    if (incoming.sequence === current.sequence) {
      const delta = Date.parse(incoming.updatedAt) - Date.parse(current.updatedAt);
      if (delta < 0) return current;
      // A late running snapshot must not undo finalization at the same timestamp.
      const terminal = ["completed", "failed", "interrupted", "merged", "cancelled"];
      if (delta === 0 && terminal.includes(current.status) && !terminal.includes(incoming.status)) return current;
    }
  }
  return { id: incoming.id, sequence: incoming.sequence, status: incoming.status, updatedAt: incoming.updatedAt };
}

export function reconcileTurnStatusPatch(current: LatestSessionTurn | null | undefined, patch: Partial<LatestSessionTurn>): LatestSessionTurn | null {
  const turn = current?.id === patch.id ? { ...current, ...patch } : patch;
  if (!turn.id || turn.sequence === undefined || !turn.status || !turn.updatedAt) return current ?? null;
  return reconcileLatestTurn(current, { id: turn.id, sequence: turn.sequence, status: turn.status, updatedAt: turn.updatedAt });
}

export type StatusSession = Pick<UserSessionListItem, "id" | "spaceId" | "lastMessageAt" | "activeTurn">;

type StatusRead = { turn: LatestSessionTurn | null; at: number; activity: string | null };
type StatusReads = {
  requests: Map<string, Promise<LatestSessionTurn | null>>;
  cached: Map<string, StatusRead>;
  running: number;
  waiting: (() => void)[];
};
const statusClients = new WeakMap<CohubClient, StatusReads>();

async function readStatus(reads: StatusReads, run: () => Promise<LatestSessionTurn | null>): Promise<LatestSessionTurn | null> {
  if (reads.running >= 2) {
    await new Promise<void>((resolve) => reads.waiting.push(() => {
      // Reserve the slot before waking the waiter so a new caller cannot take it.
      reads.running += 1;
      resolve();
    }));
  } else reads.running += 1;
  try {
    return await run();
  } finally {
    reads.running -= 1;
    reads.waiting.shift()?.();
  }
}

export async function loadSessionLatestTurns(
  client: CohubClient,
  sessions: StatusSession[],
  onTurn: (sessionId: string, turn: LatestSessionTurn | null) => void,
  lookbackMinutes = DEFAULT_SESSION_FILTER_MINUTES,
  options: { knownTurns?: Record<string, LatestSessionTurn | null>; turnStatuses?: Record<string, LatestSessionTurn | null>; cached?: boolean; activeOnly?: boolean; shouldContinue?: () => boolean } = {},
): Promise<void> {
  const cutoff = sessionFilterCutoff(lookbackMinutes, Date.now());
  const recentSessions = sessions.filter((session) => {
    if (session.lastMessageAt !== null && !Number.isFinite(Date.parse(session.lastMessageAt))) throw new Error(`Invalid lastMessageAt for Chat ${session.id}. Refresh Chats and retry.`);
    return isSessionInFilterWindow(session, cutoff) || Boolean(session.activeTurn) || getSessionStatus(options.knownTurns?.[session.id]?.status) === "running";
  });
  const reads = statusClients.get(client) ?? { requests: new Map<string, Promise<LatestSessionTurn | null>>(), cached: new Map<string, StatusRead>(), running: 0, waiting: [] };
  statusClients.set(client, reads);
  let next = 0;
  const errors: unknown[] = [];
  await Promise.all(Array.from({ length: Math.min(2, recentSessions.length) }, async () => {
    while (next < recentSessions.length && (options.shouldContinue?.() ?? true)) {
      const session = recentSessions[next++]!;
      const known = options.knownTurns?.[session.id];
      const activeRecord = session.activeTurn ? options.turnStatuses?.[session.activeTurn.id] : null;
      const activeTurnId = session.activeTurn && (!activeRecord || getSessionStatus(activeRecord.status) === "running") ? session.activeTurn.id : undefined;
      const active = activeTurnId !== undefined || getSessionStatus(known?.status) === "running";
      const turnId = options.activeOnly || !isSessionInFilterWindow(session, cutoff) ? activeTurnId ?? (active ? known?.id : undefined) : undefined;
      const key = `${session.id}:${turnId ?? "latest"}`;
      const previous = reads.cached.get(key);
      if (options.cached && previous && previous.activity === session.lastMessageAt && Date.now() - previous.at < (active ? 4_000 : 60_000)) {
        onTurn(session.id, previous.turn);
        continue;
      }
      let request = reads.requests.get(key);
      if (!request) {
        const turns = client.space(session.spaceId).session(session.id).turns;
        request = readStatus(reads, async () => {
          if (!(options.shouldContinue?.() ?? true)) return null;
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), STATUS_REQUEST_TIMEOUT_MS);
          const requestFetch: typeof fetch = (input, init) => fetch(input, { ...init, signal: controller.signal });
          try {
            const turn = await (turnId ? turns.get(turnId, requestFetch).then((response) => response.turn) : turns.listPaginated({ limit: 1, direction: "older" }, requestFetch).then((response) => latestTurn(response.turns)));
            reads.cached.set(key, { turn, at: Date.now(), activity: session.lastMessageAt });
            return turn;
          } finally {
            clearTimeout(timer);
          }
        });
        reads.requests.set(key, request);
        const current = request;
        void request.finally(() => { if (reads.requests.get(key) === current) reads.requests.delete(key); }).catch(() => undefined);
      }
      try {
        const turn = await withTimeout(request);
        if (options.shouldContinue?.() ?? true) onTurn(session.id, turn);
      } catch (error) {
        errors.push(error);
      }
    }
  }));
  if (errors.length) throw new Error(`Could not refresh ${errors.length} Chat status request(s). Pull to refresh and retry.`, { cause: errors[0] });
}

export function sessionListStatus(session: Pick<UserSessionListItem, "activeTurn">, turn: LatestSessionTurn | null | undefined, known: Record<string, LatestSessionTurn | null>): SessionStatus {
  if (session.activeTurn) {
    const active = known[session.activeTurn.id];
    if (!active || getSessionStatus(active.status) === "running") return "running";
  }
  return getSessionStatus(turn?.status);
}

export function getSessionStatus(value: string | null | undefined): SessionStatus {
  switch (value) {
    case "queued":
    case "abort_requested":
    case "running":
      return "running";
    case "completed":
      return "completed";
    case "failed":
    case "error":
      return "failed";
    case "interrupted":
    case "cancelled":
      return "stopped";
    default:
      return "idle";
  }
}
