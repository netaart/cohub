/*
 * The response cache (session storage) holds successful server responses only;
 * drafts (local storage) are never evicted, and a failed write is reported so
 * the caller can refuse to close.
 */

type Storage = Pick<globalThis.Storage, "getItem" | "setItem" | "removeItem">;

const CACHE_PREFIX = "resource-app:cache:v3:";
const MAX_ENTRY_CHARS = 512 * 1024;

function sessionStore(): Storage | null {
  try {
    return sessionStorage;
  } catch {
    return null;
  }
}

function localStore(): Storage | null {
  try {
    return localStorage;
  } catch {
    return null;
  }
}

function read<T>(storage: Storage | null, key: string): T | null {
  try {
    return JSON.parse(storage?.getItem(key) ?? "null") as T | null;
  } catch {
    return null;
  }
}

type CacheEntry<T> = { at: number; value: T };

export function readCache<T>(key: string | null): CacheEntry<T> | null {
  if (!key) return null;
  const entry = read<CacheEntry<T>>(sessionStore(), CACHE_PREFIX + key);
  return entry && typeof entry.at === "number" ? entry : null;
}

export function writeCache(key: string | null, value: unknown) {
  const storage = sessionStore();
  if (!key || !storage) return;
  const text = JSON.stringify({ at: Date.now(), value });
  if (text.length > MAX_ENTRY_CHARS) return forgetCache(key);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      storage.setItem(CACHE_PREFIX + key, text);
      return;
    } catch {
      if (!evictOldest(storage as globalThis.Storage)) return;
    }
  }
}

export function forgetCache(key: string | null) {
  if (key) sessionStore()?.removeItem(CACHE_PREFIX + key);
}

function evictOldest(storage: globalThis.Storage) {
  const entries: { key: string; at: number }[] = [];
  for (let index = 0; index < storage.length; index += 1) {
    const key = storage.key(index);
    if (!key?.startsWith(CACHE_PREFIX)) continue;
    entries.push({ key, at: read<{ at?: number }>(storage, key)?.at ?? 0 });
  }
  entries.sort((a, b) => a.at - b.at);
  const stale = entries.slice(0, Math.max(1, Math.ceil(entries.length / 2)));
  for (const entry of stale) storage.removeItem(entry.key);
  return stale.length > 0;
}

export function readDraft<T extends Record<string, unknown>>(
  key: string | null,
  storage: Storage | null = localStore(),
): T | null {
  if (!key) return null;
  const value = read<T>(storage, `${key}:draft`);
  return value && typeof value === "object" && !Array.isArray(value)
    ? value
    : null;
}

export function writeDraft(
  key: string | null,
  value: Record<string, unknown>,
  storage: Storage | null = localStore(),
) {
  if (!key || !storage) return false;
  try {
    storage.setItem(`${key}:draft`, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

export function forgetDraft(
  key: string | null,
  storage: Storage | null = localStore(),
) {
  if (!key) return;
  try {
    storage?.removeItem(`${key}:draft`);
  } catch {
  }
}
