import AsyncStorage from "@react-native-async-storage/async-storage";
import { useEffect, useState } from "react";

export type CacheRetention = "1d" | "7d" | "30d" | "forever";

export const CACHE_RETENTION_OPTIONS: readonly CacheRetention[] = ["1d", "7d", "30d", "forever"];
export const DEFAULT_CACHE_RETENTION: CacheRetention = "7d";

const CACHE_RETENTION_KEY = "cohub:mobile:cache-retention:v1";
const DAY_MS = 24 * 60 * 60 * 1000;
const RETENTION_DAYS: Record<Exclude<CacheRetention, "forever">, number> = {
  "1d": 1,
  "7d": 7,
  "30d": 30,
};

let retention: CacheRetention = DEFAULT_CACHE_RETENTION;
let retentionLoaded = false;
let retentionLoad: Promise<void> | null = null;
const retentionListeners = new Set<() => void>();

function isCacheRetention(value: string | null): value is CacheRetention {
  return value === "1d" || value === "7d" || value === "30d" || value === "forever";
}

function notifyRetentionListeners() {
  for (const listener of retentionListeners) listener();
}

function loadCacheRetentionPreference() {
  if (retentionLoad) return retentionLoad;
  retentionLoad = AsyncStorage.getItem(CACHE_RETENTION_KEY)
    .then((value) => {
      if (!retentionLoaded && isCacheRetention(value)) retention = value;
      retentionLoaded = true;
      notifyRetentionListeners();
    })
    .catch(() => {
      retentionLoaded = true;
    })
    .finally(() => {
      retentionLoad = null;
    });
  return retentionLoad;
}

/** Resolves once the stored preference is known; the startup prune waits on it. */
export async function loadCacheRetention(): Promise<CacheRetention> {
  if (!retentionLoaded) await loadCacheRetentionPreference();
  return retention;
}

export function useCacheRetention(): CacheRetention {
  const [value, setValue] = useState(retention);
  useEffect(() => {
    const listener = () => setValue(retention);
    retentionListeners.add(listener);
    if (!retentionLoaded) void loadCacheRetentionPreference();
    listener();
    return () => {
      retentionListeners.delete(listener);
    };
  }, []);
  return value;
}

export async function setCacheRetention(next: CacheRetention) {
  retention = next;
  retentionLoaded = true;
  notifyRetentionListeners();
  await AsyncStorage.setItem(CACHE_RETENTION_KEY, next);
}

/** `null` means "keep everything" (forever). */
export function cacheRetentionCutoff(value: CacheRetention, now: number): number | null {
  if (value === "forever") return null;
  return now - RETENTION_DAYS[value] * DAY_MS;
}
