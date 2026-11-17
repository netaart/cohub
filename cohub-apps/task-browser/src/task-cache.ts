import type { GenerationTask } from "./task-output.ts";

export type TaskPageInfo = {
  hasMore: boolean;
  nextCursor: string | null;
};

export type TaskCachePage = {
  tasks: GenerationTask[];
  pageInfo: TaskPageInfo;
  savedAt: number;
};

type CacheIdentity = {
  appId: string;
  viewerId: string | null;
};

const CACHE_PREFIX = "cohub:task-browser:v1:";
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

function cacheKey(identity: CacheIdentity, queryKey: string) {
  return `${CACHE_PREFIX}${identity.appId}:${identity.viewerId ?? "anonymous"}:${queryKey}`;
}

function storage() {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

export function readTaskCache(identity: CacheIdentity | null, queryKey: string): TaskCachePage | null {
  if (!identity) return null;
  const store = storage();
  if (!store) return null;
  try {
    const raw = store.getItem(cacheKey(identity, queryKey));
    if (!raw) return null;
    const value = JSON.parse(raw) as Partial<TaskCachePage>;
    if (
      !Array.isArray(value.tasks) ||
      !value.pageInfo ||
      typeof value.pageInfo.hasMore !== "boolean" ||
      typeof value.savedAt !== "number" ||
      Date.now() - value.savedAt > MAX_AGE_MS
    ) {
      store.removeItem(cacheKey(identity, queryKey));
      return null;
    }
    return value as TaskCachePage;
  } catch {
    return null;
  }
}

export function writeTaskCache(identity: CacheIdentity | null, queryKey: string, page: Omit<TaskCachePage, "savedAt">) {
  if (!identity) return;
  const store = storage();
  if (!store) return;
  try {
    store.setItem(cacheKey(identity, queryKey), JSON.stringify({ ...page, savedAt: Date.now() }));
  } catch {
    // Cache is an optimization; quota and privacy settings must not affect the app.
  }
}

export function clearTaskCache(identity: CacheIdentity | null, queryKey: string) {
  if (!identity) return;
  const store = storage();
  if (!store) return;
  try {
    store.removeItem(cacheKey(identity, queryKey));
  } catch {
    // Ignore storage failures.
  }
}
