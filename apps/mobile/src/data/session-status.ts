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

export async function loadSessionLatestTurns(
  client: CohubClient,
  sessions: Pick<UserSessionListItem, "id" | "spaceId" | "lastMessageAt">[],
  onTurn: (sessionId: string, turn: LatestSessionTurn | null) => void,
  lookbackMinutes = DEFAULT_SESSION_FILTER_MINUTES,
): Promise<void> {
  const cutoff = sessionFilterCutoff(lookbackMinutes, Date.now());
  const recentSessions = sessions.filter((session) => {
    if (session.lastMessageAt !== null && !Number.isFinite(Date.parse(session.lastMessageAt))) throw new Error(`Invalid lastMessageAt for Chat ${session.id}. Refresh Chats and retry.`);
    return isSessionInFilterWindow(session, cutoff);
  });
  let next = 0;
  const errors: unknown[] = [];
  await Promise.all(Array.from({ length: Math.min(6, recentSessions.length) }, async () => {
    while (next < recentSessions.length) {
      const session = recentSessions[next++]!;
      try {
        const response = await withTimeout(client.space(session.spaceId).session(session.id).turns.listPaginated({ limit: 1, direction: "older" }));
        onTurn(session.id, latestTurn(response.turns));
      } catch (error) {
        errors.push(error);
      }
    }
  }));
  if (errors.length) throw new Error(`Could not refresh ${errors.length} Chat status request(s). Pull to refresh and retry.`, { cause: errors[0] });
}

export function getSessionStatus(value: string | null | undefined): SessionStatus {
  switch (value) {
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
