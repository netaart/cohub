import type { CohubClient, UserSessionListItem } from "@neta-art/cohub";
import { useCallback, useEffect, useRef, useState } from "react";
import { translate } from "@/src/i18n/core";
import { sessionPageState, type SessionPageBoundary } from "@/src/data/session-status";
import { sessionSourceFilterKeys, type SessionSourceFilter } from "@/src/data/session-source";
import { mergeSessionPages, reconcileSessionHead } from "./session-list-sync";
import { useSyncScope } from "./use-sync-scope";
import { sortByRecent } from "@/src/utils";

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
  const pagesLoadedRef = useRef(0);
  const headRequestRef = useRef<Promise<void> | null>(null);
  const [reloadToken, setReloadToken] = useState(0);

  const fetchPage = useCallback(async (requestId: number, cursor: string | null, head = false) => {
    if (!client) return;
    const keys = sessionSourceFilterKeys(filter);
    if (!keys) return;
    const requestStartedAt = Date.now();
    const response = await withTimeout(client.user.listSessions({ limit: PAGE_SIZE, ...(cursor ? { cursor } : {}), source: keys }));
    if (requestId !== requestIdRef.current) return;
    if (cursor && pagesLoadedRef.current === 1 && !hasMoreRef.current) {
      setState((current) => ({ ...current, loadingMore: false }));
      return;
    }
    const page = sessionPageState(response, cursor, boundaryRef.current);
    const keepTail = head && pagesLoadedRef.current > 1 && page.hasMore;
    if (!keepTail) {
      cursorRef.current = page.cursor;
      boundaryRef.current = page.boundary;
      hasMoreRef.current = page.hasMore;
    }
    if (cursor) pagesLoadedRef.current += 1;
    else if (!keepTail) pagesLoadedRef.current = 1;
    setState((current) => ({
      sessions: head ? sortByRecent(reconcileSessionHead(current.sessions, response.sessions, page.hasMore, requestStartedAt)) : cursor ? sortByRecent(mergeSessionPages(current.sessions, response.sessions ?? [])) : response.sessions ?? [],
      loading: false,
      loadingMore: head ? current.loadingMore : false,
      error: null,
      hasMore: hasMoreRef.current,
      initialized: true,
    }));
  }, [client, filter]);

  useEffect(() => {
    const requestId = ++requestIdRef.current;
    // A reload keeps the current page on screen; a new filter starts clean.
    const sameFilter = loadedFilterRef.current === filter;
    loadedFilterRef.current = filter;
    cursorRef.current = null;
    pagesLoadedRef.current = 0;
    headRequestRef.current = null;
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
    const request = fetchPage(requestId, null);
    headRequestRef.current = request;
    void request.catch((error: unknown) => {
      if (requestId !== requestIdRef.current) return;
      setState((current) => ({ ...current, loading: false, loadingMore: false, error: errorMessage(error), hasMore: false, initialized: true }));
    }).finally(() => { if (headRequestRef.current === request) headRequestRef.current = null; });
    return () => { requestIdRef.current += 1; };
  }, [client, enabled, fetchPage, filter, reloadToken]);

  const refresh = useCallback((): Promise<void> => {
    if (headRequestRef.current) return headRequestRef.current;
    const requestId = requestIdRef.current;
    const request = fetchPage(requestId, null, true).catch((error: unknown) => {
      if (requestId === requestIdRef.current) setState((current) => ({ ...current, error: errorMessage(error) }));
      throw error;
    });
    headRequestRef.current = request;
    void request.finally(() => { if (headRequestRef.current === request) headRequestRef.current = null; }).catch(() => undefined);
    return request;
  }, [fetchPage]);
  useSyncScope(`chats:source:${filter}`, refresh, 15_000, enabled && state.initialized && !state.loading);

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
      if (requestId === requestIdRef.current) loadingMoreRef.current = false;
    });
  }, [enabled, fetchPage]);

  const reload = useCallback(() => setReloadToken((value) => value + 1), []);

  return { ...state, loadMore, reload };
}
