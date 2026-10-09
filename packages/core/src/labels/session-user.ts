import { and, eq, inArray, max, sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { labelAssignments, labels } from "@cohub/db";

export type SessionUserLabelInput = {
  db: PostgresJsDatabase<Record<string, unknown>>;
  spaceId: string;
  sessionId: string;
  userUuids: Array<string | null | undefined>;
  userId?: string | null;
};

const SCOPE_TYPE = "space";
const ROOT_LABEL_NAME = "User";
const CUSTOM_LABEL_NAME_SUFFIX = " (Custom)";
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

const slugifyLabelName = (name: string) => {
  const slug = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return slug || "label";
};

async function findLabelByName(db: PostgresJsDatabase<Record<string, unknown>>, spaceId: string, name: string, parentId: string | null) {
  const [row] = await db
    .select()
    .from(labels)
    .where(and(
      eq(labels.scopeType, SCOPE_TYPE),
      eq(labels.scopeId, spaceId),
      parentId ? eq(labels.parentId, parentId) : sql`${labels.parentId} is null`,
      sql`lower(${labels.name}) = lower(${name})`,
    ))
    .limit(1);
  return row ?? null;
}

async function findLabelBySystemKey(db: PostgresJsDatabase<Record<string, unknown>>, spaceId: string, systemKey: string) {
  const [row] = await db
    .select()
    .from(labels)
    .where(and(eq(labels.scopeType, SCOPE_TYPE), eq(labels.scopeId, spaceId), eq(labels.systemKey, systemKey)))
    .limit(1);
  return row ?? null;
}

async function nextLabelRank(db: PostgresJsDatabase<Record<string, unknown>>, spaceId: string, parentId: string | null) {
  const [{ value } = { value: 0 }] = await db
    .select({ value: max(labels.rank) })
    .from(labels)
    .where(and(
      eq(labels.scopeType, SCOPE_TYPE),
      eq(labels.scopeId, spaceId),
      parentId ? eq(labels.parentId, parentId) : sql`${labels.parentId} is null`,
    ));
  return Number(value ?? 0) + 10;
}

function customFallbackLabelName(name: string, suffix: string) {
  const base = name.length + suffix.length <= 80
    ? name
    : name.slice(0, 80 - suffix.length);
  return `${base}${suffix}`;
}

async function nextAvailableCustomLabelName(db: PostgresJsDatabase<Record<string, unknown>>, input: {
  spaceId: string;
  name: string;
  parentId: string | null;
}) {
  for (let index = 0; index < 100; index += 1) {
    const suffix = index === 0 ? CUSTOM_LABEL_NAME_SUFFIX : ` (Custom ${index + 1})`;
    const candidate = customFallbackLabelName(input.name, suffix);
    const existing = await findLabelByName(db, input.spaceId, candidate, input.parentId);
    if (!existing) return candidate;
  }
  throw new Error(`failed to rename conflicting user label: ${input.name}`);
}

async function moveConflictingUserLabel(db: PostgresJsDatabase<Record<string, unknown>>, input: {
  spaceId: string;
  name: string;
  parentId: string | null;
}) {
  const existing = await findLabelByName(db, input.spaceId, input.name, input.parentId);
  if (!existing || existing.source === "system") return;
  const name = await nextAvailableCustomLabelName(db, input);
  await db
    .update(labels)
    .set({ name, slug: slugifyLabelName(name), updatedAt: new Date() })
    .where(and(eq(labels.id, existing.id), eq(labels.source, "user")));
}

async function getOrCreateSystemLabel(db: PostgresJsDatabase<Record<string, unknown>>, input: {
  spaceId: string;
  name: string;
  parentId: string | null;
  depth: 0 | 1;
  systemKey: string;
  userId: string | null;
}) {
  const existingBySystemKey = await findLabelBySystemKey(db, input.spaceId, input.systemKey);
  if (existingBySystemKey) return existingBySystemKey;

  await moveConflictingUserLabel(db, {
    spaceId: input.spaceId,
    name: input.name,
    parentId: input.parentId,
  });
  const existingByName = await findLabelByName(db, input.spaceId, input.name, input.parentId);
  if (existingByName?.source === "system") return existingByName;

  const [created] = await db.insert(labels).values({
    scopeType: SCOPE_TYPE,
    scopeId: input.spaceId,
    name: input.name,
    slug: slugifyLabelName(input.name),
    parentId: input.parentId,
    depth: input.depth,
    rank: await nextLabelRank(db, input.spaceId, input.parentId),
    source: "system",
    systemKey: input.systemKey,
    createdBy: input.userId,
  }).onConflictDoNothing().returning();
  if (created) return created;

  const raced = await findLabelBySystemKey(db, input.spaceId, input.systemKey) ?? await findLabelByName(db, input.spaceId, input.name, input.parentId);
  if (!raced) throw new Error("failed to create user label");
  return raced;
}

export async function assignSessionParticipantSystemLabels(input: SessionUserLabelInput) {
  const userUuids = normalizeUserUuids(input.userUuids);
  if (userUuids.length === 0) return [];

  const rootLabel = await getOrCreateSystemLabel(input.db, {
    spaceId: input.spaceId,
    name: ROOT_LABEL_NAME,
    parentId: null,
    depth: 0,
    systemKey: SESSION_USER_ROOT_LABEL_SYSTEM_KEY,
    userId: input.userId ?? null,
  });

  const childLabels = await Promise.all(userUuids.map((userUuid) => getOrCreateSystemLabel(input.db, {
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
