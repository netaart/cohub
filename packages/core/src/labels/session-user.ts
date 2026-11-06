import { and, eq, inArray } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { labelAssignments } from "@cohub/db";
import { getOrCreateSpaceSystemLabel } from "./system-label.js";

export type SessionUserLabelInput = {
  db: PostgresJsDatabase<Record<string, unknown>>;
  spaceId: string;
  sessionId: string;
  userUuids: Array<string | null | undefined>;
  userId?: string | null;
};

const SCOPE_TYPE = "space";
const ROOT_LABEL_NAME = "User";
const MAX_LABEL_NAME_LENGTH = 80;
export const SESSION_USER_LABEL_SYSTEM_KEY_PREFIX = "session-user:";
export const SESSION_USER_ROOT_LABEL_SYSTEM_KEY = `${SESSION_USER_LABEL_SYSTEM_KEY_PREFIX}root`;

export const getSessionUserLabelSystemKey = (userUuid: string) => `${SESSION_USER_LABEL_SYSTEM_KEY_PREFIX}${userUuid}`;

export const parseSessionUserLabelSystemKey = (systemKey: string | null | undefined) => {
  if (!systemKey?.startsWith(SESSION_USER_LABEL_SYSTEM_KEY_PREFIX)) return null;
  const userUuid = systemKey.slice(SESSION_USER_LABEL_SYSTEM_KEY_PREFIX.length).trim();
  return userUuid && userUuid !== "root" ? userUuid : null;
};

const normalizeUserUuids = (userUuids: Array<string | null | undefined>) => {
  const seen = new Set<string>();
  const values: string[] = [];
  for (const value of userUuids) {
    const normalized = value?.trim();
    if (!normalized || normalized.length > MAX_LABEL_NAME_LENGTH || normalized.includes("/") || seen.has(normalized)) continue;
    seen.add(normalized);
    values.push(normalized);
  }
  return values;
};

export async function assignSessionParticipantSystemLabels(input: SessionUserLabelInput) {
  const userUuids = normalizeUserUuids(input.userUuids);
  if (userUuids.length === 0) return [];

  const rootLabel = await getOrCreateSpaceSystemLabel(input.db, {
    spaceId: input.spaceId,
    name: ROOT_LABEL_NAME,
    parentId: null,
    depth: 0,
    systemKey: SESSION_USER_ROOT_LABEL_SYSTEM_KEY,
    userId: input.userId ?? null,
  });

  const childLabels = await Promise.all(userUuids.map((userUuid) => getOrCreateSpaceSystemLabel(input.db, {
    spaceId: input.spaceId,
    name: userUuid,
    parentId: rootLabel.id,
    depth: 1,
    systemKey: getSessionUserLabelSystemKey(userUuid),
    userId: input.userId ?? null,
  })));

  const labelIds = childLabels.map((label) => label.id);
  if (labelIds.length === 0) return [];
  const existingAssignments = await input.db
    .select({ labelId: labelAssignments.labelId })
    .from(labelAssignments)
    .where(and(
      eq(labelAssignments.scopeType, SCOPE_TYPE),
      eq(labelAssignments.scopeId, input.spaceId),
      eq(labelAssignments.resourceType, "session"),
      eq(labelAssignments.resourceRef, input.sessionId),
      inArray(labelAssignments.labelId, labelIds),
    ));
  const existingIds = new Set(existingAssignments.map((row) => row.labelId));
  const userUuidByLabelId = new Map(childLabels.map((label, index) => [label.id, userUuids[index] ?? null]));
  const rows = childLabels
    .filter((label) => !existingIds.has(label.id))
    .map((label) => ({
      labelId: label.id,
      scopeType: SCOPE_TYPE,
      scopeId: input.spaceId,
      resourceType: "session",
      resourceRef: input.sessionId,
      rank: null,
      source: "system" as const,
      createdBy: input.userId ?? null,
      meta: { kind: "session_participant", userUuid: userUuidByLabelId.get(label.id) },
    }));

  if (rows.length === 0) return [];
  const inserted = await input.db.insert(labelAssignments).values(rows).onConflictDoNothing()
    .returning({ labelId: labelAssignments.labelId });
  return inserted.map((row) => row.labelId);
}
