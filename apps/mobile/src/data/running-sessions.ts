import type { CohubClient, UserSessionListItem, UserSessionSourceKey } from "@neta-art/cohub";

export type RunningSessionsSnapshot = {
  sessions: UserSessionListItem[];
  loading: boolean;
  loaded: boolean;
  error: string | null;
};

export const emptyRunningSessions: RunningSessionsSnapshot = { sessions: [], loading: false, loaded: false, error: null };

/** Known list rows remain usable while account-wide discovery fills the older pages. */
export function runningSessionCandidates(discovered: UserSessionListItem[], known: UserSessionListItem[]): UserSessionListItem[] {
  const sessions = new Map(discovered.map((session) => [session.id, session]));
  for (const session of known) {
    const previous = sessions.get(session.id);
    if (!previous || Date.parse(session.updatedAt) > Date.parse(previous.updatedAt)) sessions.set(session.id, session);
  }
  return [...sessions.values()];
}

/** The SDK has no active-session filter; scan the authoritative user list without a recency cutoff. */
export async function loadRunningSessions(
  client: CohubClient,
  options: { source?: readonly UserSessionSourceKey[]; signal: AbortSignal; onPage?: (sessions: UserSessionListItem[]) => void },
): Promise<UserSessionListItem[]> {
  const sessions = new Map<string, UserSessionListItem>();
  const cursors = new Set<string>();
  let cursor: string | undefined;
  do {
    if (options.signal.aborted) throw new Error("Running Chat discovery was cancelled.");
    const controller = new AbortController();
    const abort = () => controller.abort();
    options.signal.addEventListener("abort", abort, { once: true });
    const timeout = setTimeout(abort, 15_000);
    const requestFetch: typeof fetch = (input, init) => fetch(input, { ...init, signal: controller.signal });
    try {
      const response = await client.user.listSessions({ limit: 60, ...(cursor ? { cursor } : {}), ...(options.source ? { source: options.source } : {}) }, requestFetch);
      if (options.signal.aborted) throw new Error("Running Chat discovery was cancelled.");
      if (controller.signal.aborted) throw new Error("Running Chat discovery timed out. Check your connection and retry.");
      for (const session of response.sessions) {
        if (!session.id || !session.spaceId || !Number.isFinite(Date.parse(session.updatedAt)) || (session.lastMessageAt !== null && !Number.isFinite(Date.parse(session.lastMessageAt)))) {
          throw new Error("Invalid Chat record during Running discovery. Refresh Chats and retry.");
        }
        // Missing projection is not an empty result. Do not claim a complete Running list.
        if (session.activeTurn === undefined || (session.activeTurn !== null && (!session.activeTurn.id || !["queued", "running", "abort_requested"].includes(session.activeTurn.status)))) {
          throw new Error("The server did not return valid activeTurn state. Update the Cohub server to enable account-wide Running discovery.");
        }
        const previous = sessions.get(session.id);
        if (!previous || Date.parse(previous.updatedAt) <= Date.parse(session.updatedAt)) sessions.set(session.id, session);
      }
      if (!response.pageInfo || typeof response.pageInfo.hasMore !== "boolean") {
        throw new Error("The server did not return Chat pagination information. Account-wide Running discovery cannot finish.");
      }
      const next = response.pageInfo.hasMore ? response.pageInfo.nextCursor : null;
      if (response.pageInfo.hasMore && (!next || cursors.has(next))) throw new Error("Running Chat discovery pagination did not advance. Refresh Chats and retry.");
      options.onPage?.(response.sessions);
      if (!next) break;
      cursors.add(next);
      cursor = next;
    } finally {
      clearTimeout(timeout);
      options.signal.removeEventListener("abort", abort);
    }
  } while (cursor);
  return [...sessions.values()].filter((session) => session.activeTurn !== null);
}
