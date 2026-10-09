import AsyncStorage from "@react-native-async-storage/async-storage";
import { useEffect, useState } from "react";

export type BrowserPreference = "system" | "in-app";

const STORAGE_KEY = "cohub:mobile:browser-preference:v1";
const DEFAULT_PREFERENCE: BrowserPreference = "system";

let preference: BrowserPreference = DEFAULT_PREFERENCE;
let loaded = false;
let error: string | null = null;
let request: Promise<BrowserPreference> | null = null;
const listeners = new Set<() => void>();

function notify() {
  for (const listener of listeners) listener();
}

export function parseBrowserPreference(value: string | null): BrowserPreference {
  if (value === null) return DEFAULT_PREFERENCE;
  if (value === "system" || value === "in-app") return value;
  throw new Error("Invalid browser preference. Select a browser in Settings.");
}

export function loadBrowserPreference(): Promise<BrowserPreference> {
  if (loaded) return Promise.resolve(preference);
  if (request) return request;
  request = AsyncStorage.getItem(STORAGE_KEY)
    .then((value) => {
      // A selection saved while hydration is pending wins over the stored snapshot.
      if (!loaded) preference = parseBrowserPreference(value);
      loaded = true;
      error = null;
      notify();
      return preference;
    })
    .catch((cause: unknown) => {
      error = cause instanceof Error ? cause.message : "Unable to load the browser preference.";
      notify();
      throw new Error(error, { cause });
    })
    .finally(() => {
      request = null;
    });
  return request;
}

export async function saveBrowserPreference(next: BrowserPreference): Promise<void> {
  if (next !== "system" && next !== "in-app") throw new Error("Invalid browser preference. Select a browser in Settings.");
  await AsyncStorage.setItem(STORAGE_KEY, next);
  preference = next;
  loaded = true;
  error = null;
  notify();
}

export function getBrowserPreferenceSnapshot() {
  return { preference, loaded, error };
}

export function subscribeBrowserPreference(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useBrowserPreference(): { preference: BrowserPreference; loaded: boolean; error: string | null } {
  const [snapshot, setSnapshot] = useState({ preference, loaded, error });
  useEffect(() => {
    const listener = () => setSnapshot({ preference, loaded, error });
    listeners.add(listener);
    void loadBrowserPreference().catch(() => undefined);
    listener();
    return () => { listeners.delete(listener); };
  }, []);
  return snapshot;
}
