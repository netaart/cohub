import { and, eq, inArray } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { spaceMembers, spaces } from "@cohub/db";
import { getRealtimeSpaceRoom, getRealtimeUserRoom, type RealtimeRoom } from "@cohub/protocol/realtime";
import { readSessionParticipantUserUuids } from "./session-meta.js";

type AudienceDb = PostgresJsDatabase<Record<string, unknown>>;

export type SessionAudienceInput = {
  spaceId: string;
  userUuid?: string | null;
  meta?: unknown;
};

export function sessionAudienceCandidates(session: Pick<SessionAudienceInput, "userUuid" | "meta">): string[] {
  const values = [session.userUuid?.trim(), ...readSessionParticipantUserUuids(session.meta)];
  return [...new Set(values.filter((value): value is string => Boolean(value)))];
}

export function pickSessionAudience(candidates: readonly string[], ownerUuid: string | null, memberIds: readonly string[]): string[] {
  const allowed = new Set(memberIds);
  if (ownerUuid) allowed.add(ownerUuid);
  return candidates.filter((userUuid) => allowed.has(userUuid));
}

export async function resolveSessionAudienceRooms(db: AudienceDb, session: SessionAudienceInput): Promise<RealtimeRoom[]> {
  const spaceRoom = getRealtimeSpaceRoom(session.spaceId);
  const candidates = sessionAudienceCandidates(session);
  if (candidates.length === 0) return [spaceRoom];
  const [owners, members] = await Promise.all([
    db.select({ userUuid: spaces.userUuid }).from(spaces).where(eq(spaces.id, session.spaceId)).limit(1),
    db
      .select({ userId: spaceMembers.userId })
      .from(spaceMembers)
      .where(and(eq(spaceMembers.spaceId, session.spaceId), inArray(spaceMembers.userId, candidates))),
  ]);
  const audience = pickSessionAudience(candidates, owners[0]?.userUuid ?? null, members.map((member) => member.userId));
  return [spaceRoom, ...audience.map(getRealtimeUserRoom)];
}
