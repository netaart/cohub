import { and, asc, eq, inArray, max, sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { labelAssignments, labels } from "@cohub/db";

export type LabelPath = readonly [string] | readonly [string, string];

type LabelsDb = PostgresJsDatabase<Record<string, unknown>>;
export type LabelSource = "user" | "system";

const SCOPE_TYPE = "space";
const MAX_LABEL_NAME_LENGTH = 80;
const MAX_LABEL_REFS = 20;
const RESERVED_SYSTEM_ROOT_LABELS = new Set(["source", "user", "channel"]);
const pathKey = (path: LabelPath) => path.map((part) => part.toLowerCase()).join("/");
const hasControlCharacter = (value: string) => [...value].some((char) => {
  const code = char.charCodeAt(0);
  return code <= 0x1f || code === 0x7f;
});

export function normalizeLabelName(value: unknown): string {
  if (typeof value !== "string") throw new Error("label name must be a string");
  if (hasControlCharacter(value)) throw new Error("label name cannot contain control characters");
  const name = value.replace(/\s+/g, " ").trim();
  if (!name || name.length > MAX_LABEL_NAME_LENGTH) throw new Error(`label name must be 1-${MAX_LABEL_NAME_LENGTH} characters`);
  if (name.includes("/")) throw new Error('label name cannot contain "/"');
  return name;
}

export function parseLabelRef(value: unknown): LabelPath {
  if (typeof value !== "string") throw new Error("labelRef must be a string");
  const ref = value.trim();
  if (!ref) throw new Error("labelRef must be non-empty");
  const parts = ref.split("/");
  if (parts.length > 2) throw new Error("label path supports at most 2 segments");
  if (parts.some((part) => !part.trim())) throw new Error('labelRef must be "Name" or "Parent/Child"');
  const path = parts.map((part) => normalizeLabelName(part));
  return path.length === 1 ? [path[0] as string] : [path[0] as string, path[1] as string];
}

export function parseLabelRefs(value: unknown): LabelPath[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new Error("labelRefs must be an array");
  if (value.length > MAX_LABEL_REFS) throw new Error(`labelRefs must contain at most ${MAX_LABEL_REFS} items`);
  const byKey = new Map<string, LabelPath>();
  for (const item of value) {
    const path = parseLabelRef(item);
    byKey.set(pathKey(path), path);
  }
  return [...byKey.values()];
}

export function slugifyLabelName(name: string) {
  const slug = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return slug || "label";
}

async function findLabelByName(db: LabelsDb, spaceId: string, name: string, parentId: string | null) {
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

async function nextLabelRank(db: LabelsDb, spaceId: string, parentId: string | null) {
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

async function getOrCreateLabel(db: LabelsDb, input: {
  spaceId: string;
  name: string;
  parentId: string | null;
  depth: 0 | 1;
  userId: string | null;
  source: LabelSource;
}) {
  const existing = await findLabelByName(db, input.spaceId, input.name, input.parentId);
  if (existing) return existing;

  const [created] = await db.insert(labels).values({
    scopeType: SCOPE_TYPE,
    scopeId: input.spaceId,
    name: input.name,
    slug: slugifyLabelName(input.name),
    parentId: input.parentId,
    depth: input.depth,
    rank: await nextLabelRank(db, input.spaceId, input.parentId),
    source: input.source,
    createdBy: input.userId,
  }).onConflictDoNothing().returning();
  if (created) return created;

  const raced = await findLabelByName(db, input.spaceId, input.name, input.parentId);
  if (!raced) throw new Error("failed to create label");
  return raced;
}

export async function resolveLabelPaths(input: { db: LabelsDb; spaceId: string; paths: LabelPath[] }) {
  const labelIds: string[] = [];
  const missingPaths: LabelPath[] = [];
  for (const path of input.paths) {
    const parent = await findLabelByName(input.db, input.spaceId, path[0], null);
    if (!parent) {
      missingPaths.push(path);
      continue;
    }
    if (path.length === 1) {
      labelIds.push(parent.id);
      continue;
    }
    const child = await findLabelByName(input.db, input.spaceId, path[1], parent.id);
    if (child) labelIds.push(child.id);
    else missingPaths.push(path);
  }
  return { labelIds: [...new Set(labelIds)], missingPaths };
}

export async function resolveOrCreateLabelPaths(input: {
  db: LabelsDb;
  spaceId: string;
  paths: LabelPath[];
  userId: string | null;
  source?: LabelSource;
}) {
  const source = input.source ?? "user";
  const labelIds: string[] = [];
  for (const path of input.paths) {
    if (source === "user" && RESERVED_SYSTEM_ROOT_LABELS.has(path[0].toLowerCase())) {
      throw new Error(`label path "${path[0]}" is reserved`);
    }
    const parent = await getOrCreateLabel(input.db, {
      spaceId: input.spaceId,
      name: path[0],
      parentId: null,
      depth: 0,
      userId: input.userId,
      source,
    });
    if (path.length === 1) {
      labelIds.push(parent.id);
      continue;
    }
    const child = await getOrCreateLabel(input.db, {
      spaceId: input.spaceId,
      name: path[1],
      parentId: parent.id,
      depth: 1,
      userId: input.userId,
      source,
    });
    labelIds.push(child.id);
  }
  return { labelIds: [...new Set(labelIds)] };
}

export async function assignLabelsToSession(input: {
  db: LabelsDb;
  spaceId: string;
  sessionId: string;
  labelIds: string[];
  userId: string | null;
  source?: LabelSource;
}) {
  const source = input.source ?? "user";
  const labelIds = [...new Set(input.labelIds)].filter(Boolean);
  if (labelIds.length === 0) return;
  const existing = await input.db
    .select({ id: labels.id })
    .from(labels)
    .where(and(eq(labels.scopeType, SCOPE_TYPE), eq(labels.scopeId, input.spaceId), inArray(labels.id, labelIds)));
  const existingIds = existing.map((label) => label.id);
  if (existingIds.length === 0) return;
  const rows = await Promise.all(existingIds.map(async (labelId) => {
    const rank = source === "user"
      ? Number((await input.db
        .select({ value: max(labelAssignments.rank) })
        .from(labelAssignments)
        .where(eq(labelAssignments.labelId, labelId)))[0]?.value ?? 0) + 10
      : null;
    return {
      labelId,
      scopeType: SCOPE_TYPE,
      scopeId: input.spaceId,
      resourceType: "session",
      resourceRef: input.sessionId,
      rank,
      source,
      createdBy: input.userId,
    };
  }));
  await input.db.insert(labelAssignments).values(rows).onConflictDoNothing();
}

export function formatLabelPath(path: LabelPath) {
  return path.join("/");
}

export async function listLabelsByRank(db: LabelsDb, spaceId: string) {
  return db
    .select()
    .from(labels)
    .where(and(eq(labels.scopeType, SCOPE_TYPE), eq(labels.scopeId, spaceId)))
    .orderBy(asc(labels.rank), asc(labels.name));
}

export { assignSessionParticipantSystemLabels, getSessionUserLabelSystemKey, parseSessionUserLabelSystemKey, SESSION_USER_LABEL_SYSTEM_KEY_PREFIX, SESSION_USER_ROOT_LABEL_SYSTEM_KEY } from "./session-user.js";
export { assignSessionSourceSystemLabel, getSessionSourceLabelSystemKey, resolveKnownSessionSourceLabelSystemKey, resolveSessionSourceKey, resolveSessionSourceLabelRef, resolveSessionSourceLabelSystemKey, SESSION_SOURCE_KEYS, SESSION_SOURCE_LABEL_SYSTEM_KEY_PREFIX, SESSION_SOURCE_ROOT_LABEL_SYSTEM_KEY } from "./session-source.js";
export { assignSessionChannelSystemLabel, getSessionChannelLabelSystemKey, parseSessionChannelLabelSystemKey, SESSION_CHANNEL_LABEL_SYSTEM_KEY_PREFIX, SESSION_CHANNEL_ROOT_LABEL_SYSTEM_KEY } from "./session-channel.js";
export { listResourceLabelRefs } from "./resource-events.js";
export type { LabelResourceType } from "./resource-events.js";
export type { UserLabelAssignment } from "./user-labels.js";
export {
  ensurePinnedLabel,
  getPinnedSpaceIds,
  getUserResourceLabelAssignments,
  patchUserResourceLabels,
  PINNED_LABEL_NAME,
  PINNED_LABEL_SYSTEM_KEY,
  USER_LABEL_SCOPE_TYPE,
} from "./user-labels.js";
