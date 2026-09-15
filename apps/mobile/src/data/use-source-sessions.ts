import type { CohubClient, UserSessionListItem } from "@neta-art/cohub";
import { useCallback, useEffect, useRef, useState } from "react";
import { translate } from "@/src/i18n/core";
import { sessionPageState, type SessionPageBoundary } from "@/src/data/session-status";
import { sessionSourceFilterKeys, type SessionSourceFilter } from "@/src/data/session-source";

const PAGE_SIZE = 60;
const REQUEST_TIMEOUT_MS = 15_000;
const EMPTY = { sessions: [] as UserSessionListItem[], loading: false, loadingMore: false, error: null as string | null, hasMore: false, initialized: false };

function withTimeout<T>(promise: Promise<T>) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(translate("data.timeout", { label: translate("tabs.chats"), seconds: 15 }))), REQUEST_TIMEOUT_MS);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

function errorMessage(error: unknown) {
  if (typeof error === "object" && error !== null && "status" in error) {
    const status = (error as { status?: unknown }).status;
    if (status === 401) return translate("data.signInRejected");
    if (status === 403) return translate("data.noAccess");
  }
  return error instanceof Error && error.message.trim() ? error.message : translate("data.chatsLoadFailed");
}

function mergePage(current: UserSessionListItem[], incoming: UserSessionListItem[]) {
  const byId = new Map(current.map((session) => [session.id, session]));
  for (const session of incoming) byId.set(session.id, { ...byId.get(session.id), ...session });
  return [...byId.values()];
}

/**
 * Server-filtered global Chats list for a source filter. The shared home list stays
 * unfiltered for cache hydration and cross-screen lookups, so this keeps its own
 * pages and cursor. `all` resolves to the empty state; callers use the home list.
 */
export function useSourceSessions(client: CohubClient | null, filter: SessionSourceFilter) {
  const enabled = filter !== "all";
  const [state, setState] = useState(EMPTY);
  const requestIdRef = useRef(0);
  const cursorRef = useRef<string | null>(null);
  const boundaryRef = useRef<SessionPageBoundary | null>(null);
  const hasMoreRef = useRef(false);
  const loadingMoreRef = useRef(false);
  const loadedFilterRef = useRef<SessionSourceFilter | null>(null);
  const [reloadToken, setReloadToken] = useState(0);

  const fetchPage = useCallback(async (requestId: number, cursor: string | null) => {
    if (!client) return;
    const keys = sessionSourceFilterKeys(filter);
    if (!keys) return;
    const response = await withTimeout(client.user.listSessions({ limit: PAGE_SIZE, ...(cursor ? { cursor } : {}), source: keys }));
    if (requestId !== requestIdRef.current) return;
    const page = sessionPageState(response, cursor, boundaryRef.current);
    cursorRef.current = page.cursor;
    boundaryRef.current = page.boundary;
    hasMoreRef.current = page.hasMore;
    setState((current) => ({
      sessions: cursor ? mergePage(current.sessions, response.sessions ?? []) : response.sessions ?? [],
      loading: false,
      loadingMore: false,
      error: null,
      hasMore: page.hasMore,
      initialized: true,
    }));
  }, [client, filter]);

  useEffect(() => {
    const requestId = ++requestIdRef.current;
    // A reload keeps the current page on screen; a new filter starts clean.
    const sameFilter = loadedFilterRef.current === filter;
    loadedFilterRef.current = filter;
    cursorRef.current = null;
    boundaryRef.current = null;
    hasMoreRef.current = false;
    loadingMoreRef.current = false;
    if (!enabled || !client) {
      // Defer so the effect never synchronously cascades a render (see react-hooks/set-state-in-effect).
      void Promise.resolve().then(() => {
        if (requestId === requestIdRef.current) setState(EMPTY);
      });
      return;
    }
    void Promise.resolve().then(() => {
      if (requestId !== requestIdRef.current) return;
      setState((current) => sameFilter ? { ...current, loading: current.sessions.length === 0, loadingMore: false, error: null, hasMore: false } : { ...EMPTY, loading: true });
    });
    void fetchPage(requestId, null).catch((error: unknown) => {
      if (requestId !== requestIdRef.current) return;
      setState((current) => ({ ...current, loading: false, loadingMore: false, error: errorMessage(error), hasMore: false, initialized: true }));
    });
  }, [client, enabled, fetchPage, filter, reloadToken]);

  const loadMore = useCallback(() => {
    if (!enabled || loadingMoreRef.current || !hasMoreRef.current) return;
    const cursor = cursorRef.current;
    if (!cursor) return;
    loadingMoreRef.current = true;
    const requestId = requestIdRef.current;
    setState((current) => ({ ...current, loadingMore: true, error: null }));
    void fetchPage(requestId, cursor).catch((error: unknown) => {
      if (requestId !== requestIdRef.current) return;
      setState((current) => ({ ...current, loadingMore: false, error: errorMessage(error) }));
    }).finally(() => {
      loadingMoreRef.current = false;
    });
  }, [enabled, fetchPage]);

  const reload = useCallback(() => setReloadToken((value) => value + 1), []);

  return { ...state, loadMore, reload };
}
