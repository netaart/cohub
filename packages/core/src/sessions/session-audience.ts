import { and, eq, inArray, or } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { accessPolicies, spaceMembers, type SpaceRole } from "@cohub/db";
import { type AccessPolicy, roleHasPermission } from "../permissions/index.js";
import {
  getRealtimeSpaceRoom,
  getRealtimeUserRoom,
  type RealtimeRoom,
} from "@cohub/protocol/realtime";
import { readSessionParticipantUserUuids } from "./session-meta.js";

type AudienceDb = PostgresJsDatabase<Record<string, unknown>>;

export type SessionAudienceInput = {
  id: string;
  spaceId: string;
  userUuid?: string | null;
  meta?: unknown;
};

export function sessionAudienceCandidates(
  session: Pick<SessionAudienceInput, "userUuid" | "meta">,
): string[] {
  const values = [
    session.userUuid?.trim(),
    ...readSessionParticipantUserUuids(session.meta),
  ];
  return [
    ...new Set(values.filter((value): value is string => Boolean(value))),
  ];
}

export function pickSessionAudience(
  candidates: readonly string[],
  members: readonly { userId: string; role: SpaceRole }[],
  policy: AccessPolicy | null,
): string[] {
  const roles = new Map(members.map((member) => [member.userId, member.role]));
  const fallback = policy?.signedInUserRole ?? policy?.anonymousUserRole;
  return candidates.filter((userUuid) => {
    const role = roles.get(userUuid) ?? fallback;
    return role != null && roleHasPermission(role, "session.view");
  });
}

export async function resolveSessionAudienceRooms(
  db: AudienceDb,
  session: SessionAudienceInput,
): Promise<RealtimeRoom[]> {
  const spaceRoom = getRealtimeSpaceRoom(session.spaceId);
  const candidates = sessionAudienceCandidates(session);
  if (candidates.length === 0) return [spaceRoom];
  // Same membership/session-policy precedence as the Session list.
  const [policies, members] = await Promise.all([
    db
      .select({
        resourceType: accessPolicies.resourceType,
        signedInUserRole: accessPolicies.signedInUserRole,
        anonymousUserRole: accessPolicies.anonymousUserRole,
      })
      .from(accessPolicies)
      .where(
        or(
          and(
            eq(accessPolicies.resourceType, "session"),
            eq(accessPolicies.resourceId, session.id),
          ),
          and(
            eq(accessPolicies.resourceType, "space"),
            eq(accessPolicies.resourceId, session.spaceId),
          ),
        ),
      ),
    db
      .select({ userId: spaceMembers.userId, role: spaceMembers.role })
      .from(spaceMembers)
      .where(
        and(
          eq(spaceMembers.spaceId, session.spaceId),
          inArray(spaceMembers.userId, candidates),
        ),
      ),
  ]);
  const policy =
    policies.find((row) => row.resourceType === "session") ??
    policies.find((row) => row.resourceType === "space") ??
    null;
  const audience = pickSessionAudience(candidates, members, policy);
  return [spaceRoom, ...audience.map(getRealtimeUserRoom)];
}
