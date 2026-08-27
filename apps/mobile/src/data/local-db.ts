import type { MessageRecord, SpaceRecord, UserSessionListItem } from "@neta-art/cohub";

export type CachedHome = {
  spaces: SpaceRecord[];
  sessions: UserSessionListItem[];
};

/** TypeScript fallback; Metro selects the native or web adapter at runtime. */
export async function hydrateHome(_userKey: string): Promise<CachedHome> {
  return { spaces: [], sessions: [] };
}

export async function saveHome(_userKey: string, _home: CachedHome) {
  return undefined;
}

export async function loadMessages(_userKey: string, _sessionId: string): Promise<MessageRecord[]> {
  return [];
}

export async function saveMessages(_userKey: string, _sessionId: string, _messages: MessageRecord[]) {
  return undefined;
}

export async function clearUserCache(_userKey: string) {
  return undefined;
}
