import type { MessageRecord, SpaceRecord, UserSessionListItem } from "@neta-art/cohub";

export type CachedHome = {
  spaces: SpaceRecord[];
  sessions: UserSessionListItem[];
};

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

const sessionReadSequences = new Map<string, number>();

export async function loadSessionReadSequence(userKey: string, sessionId: string): Promise<number | null> {
  return sessionReadSequences.get(`${userKey}:${sessionId}`) ?? null;
}

export async function saveSessionReadSequence(userKey: string, sessionId: string, sequence: number) {
  sessionReadSequences.set(`${userKey}:${sessionId}`, sequence);
}

export async function clearUserCache(userKey: string) {
  for (const key of sessionReadSequences.keys()) {
    if (key.startsWith(`${userKey}:`)) sessionReadSequences.delete(key);
  }
  return undefined;
}
