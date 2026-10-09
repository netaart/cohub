import AsyncStorage from "@react-native-async-storage/async-storage";
import { useEffect, useState } from "react";
import { DEFAULT_SESSION_FILTER_MINUTES, parseSessionFilterMinutes } from "./session-status";
import type { SessionSourceFilter } from "./session-source";

const STORAGE_KEY = "cohub:mobile:session-filter-minutes:v1";
const SOURCE_STORAGE_KEY = "cohub:mobile:session-filter-source:v1";
let minutes = DEFAULT_SESSION_FILTER_MINUTES;
let loaded = false;
let error: string | null = null;
let request: Promise<number> | null = null;
let source: SessionSourceFilter = "all";
let sourceLoaded = false;
let sourceError: string | null = null;
let sourceRequest: Promise<SessionSourceFilter> | null = null;
const listeners = new Set<() => void>();

function notify() {
  for (const listener of listeners) listener();
}

export function loadSessionFilterMinutes(): Promise<number> {
  if (loaded) return Promise.resolve(minutes);
  if (request) return request;
  request = AsyncStorage.getItem(STORAGE_KEY).then((raw) => {
    // A setting saved while hydration is pending takes precedence over the stored snapshot.
    if (!loaded) minutes = raw === null ? DEFAULT_SESSION_FILTER_MINUTES : parseSessionFilterMinutes(raw);
    loaded = true;
    error = null;
    notify();
    return minutes;
  }).catch((cause: unknown) => {
    error = cause instanceof Error ? cause.message : "Unable to load the Chat filter setting. Retry in Settings.";
    notify();
    throw new Error(error, { cause });
  }).finally(() => { request = null; });
  return request;
}

export async function saveSessionFilterMinutes(next: number): Promise<void> {
  const valid = parseSessionFilterMinutes(String(next));
  await AsyncStorage.setItem(STORAGE_KEY, String(valid));
  minutes = valid;
  loaded = true;
  error = null;
  notify();
}

export function useSessionFilterPreference(): { minutes: number; loaded: boolean; error: string | null } {
  const [value, setValue] = useState({ minutes, loaded, error });
  useEffect(() => {
    const listener = () => setValue({ minutes, loaded, error });
    listeners.add(listener);
    void loadSessionFilterMinutes().catch(() => undefined);
    listener();
    return () => { listeners.delete(listener); };
  }, []);
  return value;
}

/** Anything other than a known source filter is treated as the unfiltered default. */
export function parseSessionSourceFilter(raw: string | null): SessionSourceFilter {
  return raw === "web" || raw === "other" ? raw : "all";
}

export function loadSessionSourcePreference(): Promise<SessionSourceFilter> {
  if (sourceLoaded) return Promise.resolve(source);
  if (sourceRequest) return sourceRequest;
  sourceRequest = AsyncStorage.getItem(SOURCE_STORAGE_KEY).then((raw) => {
    // A setting saved while hydration is pending takes precedence over the stored snapshot.
    if (!sourceLoaded) source = parseSessionSourceFilter(raw);
    sourceLoaded = true;
    sourceError = null;
    notify();
    return source;
  }).catch((cause: unknown) => {
    sourceError = cause instanceof Error ? cause.message : "Unable to load the Chat source filter. Retry on the Chats tab.";
    notify();
    throw new Error(sourceError, { cause });
  }).finally(() => { sourceRequest = null; });
  return sourceRequest;
}

export async function saveSessionSourcePreference(next: SessionSourceFilter): Promise<void> {
  await AsyncStorage.setItem(SOURCE_STORAGE_KEY, next);
  source = next;
  sourceLoaded = true;
  sourceError = null;
  notify();
}

export function useSessionSourcePreference(): { filter: SessionSourceFilter; loaded: boolean; error: string | null } {
  const [value, setValue] = useState({ filter: source, loaded: sourceLoaded, error: sourceError });
  useEffect(() => {
    const listener = () => setValue({ filter: source, loaded: sourceLoaded, error: sourceError });
    listeners.add(listener);
    void loadSessionSourcePreference().catch(() => undefined);
    listener();
    return () => { listeners.delete(listener); };
  }, []);
  return value;
}
