import type { CohubClient, GlobalSearchResult, GlobalSearchType } from "@neta-art/cohub";
import { useCallback, useEffect, useRef, useState } from "react";

export type SessionNavigationTarget = {
  turn?: number;
  turnId?: string;
};

export type RemoteSessionSearchHit = {
  sessionId: string;
  spaceId: string;
  title: string;
  preview: string | null;
  spaceName: string | null;
  spaceAvatarUrl: string | null;
  turnSequence: number | null;
  turnId: string | null;
  updatedAt: string | null;
  score: number;
  turnScore: number | null;
};

export type RemoteSpaceSearchHit = {
  spaceId: string;
  title: string;
  description: string | null;
  avatarUrl: string | null;
  updatedAt: string | null;
  score: number;
};

type RemoteSearchState = {
  query: string;
  sessions: RemoteSessionSearchHit[];
  spaces: RemoteSpaceSearchHit[];
  loading: boolean;
  error: string | null;
  degraded: boolean;
};

type RemoteSearchOptions = {
  enabled?: boolean;
  limit?: number;
  spaceId?: string;
  types?: readonly GlobalSearchType[];
};

const DEFAULT_SEARCH_TYPES: readonly GlobalSearchType[] = ["session", "turn"];
const SEARCH_DEBOUNCE_MS = 180;
const EMPTY_STATE: RemoteSearchState = {
  query: "",
  sessions: [],
  spaces: [],
  loading: false,
  error: null,
  degraded: false,
};

export function normalizeSearchQuery(value: string) {
  return value.replace(/\s+/g, " ").trim();
}

function text(value: string | null | undefined) {
  const normalized = value?.replace(/\s+/g, " ").trim();
  return normalized || null;
}

function latestTimestamp(current: string | null, incoming: string | null) {
  if (!current) return incoming;
  if (!incoming) return current;
  const currentTime = Date.parse(current);
  const incomingTime = Date.parse(incoming);
  if (!Number.isFinite(currentTime)) return incoming;
  if (!Number.isFinite(incomingTime)) return current;
  return incomingTime > currentTime ? incoming : current;
}

function sessionIdForResult(item: GlobalSearchResult) {
  if (item.sessionId) return item.sessionId;
  return item.type === "session" ? item.id : null;
}

export function mapRemoteSearchResults(items: GlobalSearchResult[]) {
  const sessions = new Map<string, RemoteSessionSearchHit>();
  const spaces = new Map<string, RemoteSpaceSearchHit>();

  for (const item of items) {
    if (item.type === "space") {
      const title = text(item.title) ?? "Untitled Space";
      const current = spaces.get(item.spaceId);
      spaces.set(item.spaceId, current ? {
        ...current,
        title,
        description: text(item.excerpt) ?? current.description,
        avatarUrl: item.spaceProfile?.avatarUrl ?? current.avatarUrl,
        updatedAt: latestTimestamp(current.updatedAt, item.updatedAt),
        score: Math.max(current.score, item.score),
      } : {
        spaceId: item.spaceId,
        title,
        description: text(item.excerpt),
        avatarUrl: item.spaceProfile?.avatarUrl ?? null,
        updatedAt: item.updatedAt,
        score: item.score,
      });
      continue;
    }

    const sessionId = sessionIdForResult(item);
    if (!sessionId) continue;
    const itemTitle = text(item.sessionTitle) ?? (item.type === "session" ? text(item.title) : null);
    const itemPreview = text(item.excerpt) ?? (item.type === "turn" ? text(item.title) : null);
    const current = sessions.get(sessionId);
    if (!current) {
      sessions.set(sessionId, {
        sessionId,
        spaceId: item.spaceId,
        title: itemTitle ?? "Untitled Chat",
        preview: itemPreview,
        spaceName: text(item.spaceName),
        spaceAvatarUrl: item.spaceProfile?.avatarUrl ?? null,
        turnSequence: item.type === "turn" ? item.sequence : null,
        turnId: item.type === "turn" ? item.turnId : null,
        updatedAt: item.updatedAt,
        score: item.score,
        turnScore: item.type === "turn" ? item.score : null,
      });
      continue;
    }

    const replaceTurn = item.type === "turn" && (
      current.turnSequence === null || current.turnScore === null || item.score > current.turnScore
    );
    sessions.set(sessionId, {
      ...current,
      title: itemTitle ?? current.title,
      preview: replaceTurn ? itemPreview : current.preview,
      spaceName: text(item.spaceName) ?? current.spaceName,
      spaceAvatarUrl: item.spaceProfile?.avatarUrl ?? current.spaceAvatarUrl,
      turnSequence: replaceTurn ? item.sequence : current.turnSequence,
      turnId: replaceTurn ? item.turnId : current.turnId,
      updatedAt: latestTimestamp(current.updatedAt, item.updatedAt),
      score: Math.max(current.score, item.score),
      turnScore: replaceTurn ? item.score : current.turnScore,
    });
  }

  return {
    sessions: [...sessions.values()].sort((left, right) => right.score - left.score),
    spaces: [...spaces.values()].sort((left, right) => right.score - left.score),
  };
}

function isGlobalSearchType(value: string): value is GlobalSearchType {
  return value === "turn" || value === "session" || value === "space" || value === "label";
}

export function useRemoteSearch(
  client: CohubClient | null,
  query: string,
  options: RemoteSearchOptions = {},
) {
  const enabled = options.enabled ?? true;
  const limit = options.limit ?? 50;
  const spaceId = options.spaceId ?? null;
  const typesKey = (options.types ?? DEFAULT_SEARCH_TYPES).join(",");
  const normalizedQuery = normalizeSearchQuery(query);
  const [state, setState] = useState<RemoteSearchState>(EMPTY_STATE);
  const requestIdRef = useRef(0);
  const [retryToken, setRetryToken] = useState(0);
  const retry = useCallback(() => setRetryToken((value) => value + 1), []);

  useEffect(() => {
    let active = true;
    const requestId = ++requestIdRef.current;
    const shouldSearch = enabled && client !== null && normalizedQuery.length >= 2;
    const reset = () => {
      if (active) setState(EMPTY_STATE);
    };

    if (!shouldSearch) {
      reset();
      return () => {
        active = false;
      };
    }

    void Promise.resolve().then(() => {
      if (active && requestId === requestIdRef.current) setState({ ...EMPTY_STATE, query: normalizedQuery, loading: true });
    });
    const timer = setTimeout(() => {
      if (!active || !client) return;
      const types = typesKey.split(",").filter(isGlobalSearchType);
      void client.search.query({
        q: normalizedQuery,
        limit,
        types,
        ...(spaceId ? { spaceId } : {}),
      }).then((response) => {
        if (!active || requestId !== requestIdRef.current) return;
        const mapped = mapRemoteSearchResults(response.items ?? []);
        setState({ ...mapped, query: normalizedQuery, loading: false, error: null, degraded: response.degraded === true });
      }).catch((caught) => {
        if (!active || requestId !== requestIdRef.current) return;
        setState({ ...EMPTY_STATE, query: normalizedQuery, error: caught instanceof Error ? caught.message : "Search is unavailable" });
      });
    }, SEARCH_DEBOUNCE_MS);

    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [client, enabled, limit, normalizedQuery, retryToken, spaceId, typesKey]);

  return { ...state, normalizedQuery, retry };
}
