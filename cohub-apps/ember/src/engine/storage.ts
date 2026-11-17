
import { type CampState, decodeSnapshot, encodeSnapshot } from "../camp/state.ts";

const PREFIX = "ember.camp.";
const TTL_MS = 20 * 60 * 60 * 1000;
const MAX_CAMPS = 8;

type Stored = { v: 1; at: number; parts: string[] };

const storage = (): Storage | null => {
  try {
    return localStorage;
  } catch {
    return null;
  }
};

const key = (code: string) => `${PREFIX}${code}`;

export const readCachedCamp = async (code: string): Promise<CampState | null> => {
  const raw = storage()?.getItem(key(code));
  if (!raw) return null;
  try {
    const stored = JSON.parse(raw) as Partial<Stored>;
    if (stored.v !== 1 || !Array.isArray(stored.parts) || typeof stored.at !== "number") return null;
    if (Date.now() - stored.at > TTL_MS) return null;
    return await decodeSnapshot(stored.parts);
  } catch {
    return null;
  }
};

let timer: ReturnType<typeof setTimeout> | null = null;
let latest: { code: string; state: CampState } | null = null;

export const writeCachedCamp = (code: string, state: CampState) => {
  latest = { code, state };
  if (timer) return;
  timer = setTimeout(() => {
    timer = null;
    void flushCachedCamp();
  }, 4000);
};

export const flushCachedCamp = async () => {
  const pending = latest;
  latest = null;
  if (!pending) return;
  const store = storage();
  if (!store) return;
  try {
    const parts = await encodeSnapshot(pending.state);
    prune(store, key(pending.code));
    store.setItem(key(pending.code), JSON.stringify({ v: 1, at: Date.now(), parts } satisfies Stored));
  } catch {
  }
};

const prune = (store: Storage, keep: string) => {
  const entries: Array<{ name: string; at: number }> = [];
  for (let index = 0; index < store.length; index += 1) {
    const name = store.key(index);
    if (!name?.startsWith(PREFIX) || name === keep) continue;
    let at = 0;
    try {
      at = (JSON.parse(store.getItem(name) ?? "null") as Partial<Stored> | null)?.at ?? 0;
    } catch {}
    entries.push({ name, at });
  }
  const now = Date.now();
  entries.sort((a, b) => b.at - a.at);
  entries.forEach((entry, index) => {
    if (index >= MAX_CAMPS - 1 || now - entry.at > TTL_MS) store.removeItem(entry.name);
  });
};

export const clearCachedCamp = (code: string) => {
  try {
    storage()?.removeItem(key(code));
  } catch {}
};

const PROFILE_KEY = "ember.profile";

export type Profile = { name: string; color: string };

export const readProfile = (): Profile | null => {
  const raw = storage()?.getItem(PROFILE_KEY);
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Partial<Profile>;
    return typeof value.name === "string" && typeof value.color === "string" ? { name: value.name, color: value.color } : null;
  } catch {
    return null;
  }
};

export const writeProfile = (profile: Profile) => {
  try {
    storage()?.setItem(PROFILE_KEY, JSON.stringify(profile));
  } catch {}
};

const SESSION_KEY = "ember.session";

export type SitIntent = { code: string; name: string; color: string; mic: boolean; cam?: boolean; at: number };

export const writeIntent = (intent: SitIntent | null) => {
  try {
    if (intent) sessionStorage.setItem(SESSION_KEY, JSON.stringify(intent));
    else sessionStorage.removeItem(SESSION_KEY);
  } catch {}
};

export const readIntent = (now = Date.now()): SitIntent | null => {
  let raw: string | null = null;
  try {
    raw = sessionStorage.getItem(SESSION_KEY);
  } catch {
    return null;
  }
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Partial<SitIntent>;
    if (typeof value.code !== "string" || typeof value.name !== "string" || typeof value.at !== "number") return null;
    if (now - value.at > 60_000) return null;
    return {
      code: value.code,
      name: value.name,
      color: typeof value.color === "string" ? value.color : "#f4a261",
      mic: value.mic === true,
      cam: value.cam === true,
      at: value.at,
    };
  } catch {
    return null;
  }
};
