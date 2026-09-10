import AsyncStorage from "@react-native-async-storage/async-storage";
import { useEffect, useState } from "react";
import { DEFAULT_SESSION_FILTER_MINUTES, parseSessionFilterMinutes } from "./session-status";

const STORAGE_KEY = "cohub:mobile:session-filter-minutes:v1";
let minutes = DEFAULT_SESSION_FILTER_MINUTES;
let loaded = false;
let error: string | null = null;
let request: Promise<number> | null = null;
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
