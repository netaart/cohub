import { and, asc, eq, inArray, max, sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { labelAssignments, labels } from "@cohub/db";
import { parseLabelRef, parseLabelRefs, resolveLabelPaths, resolveOrCreateLabelPaths } from "./index.js";
import type { LabelResourceType } from "./resource-events.js";

type LabelsDb = PostgresJsDatabase<Record<string, unknown>>;
export const USER_LABEL_SCOPE_TYPE = "user";
export const PINNED_LABEL_NAME = "Pinned";
export const PINNED_LABEL_SYSTEM_KEY = "user:pinned";
export const ARCHIVED_LABEL_SYSTEM_KEY = "user:archived";
export const USER_SYSTEM_LABELS = { pinned: PINNED_LABEL_SYSTEM_KEY, archived: ARCHIVED_LABEL_SYSTEM_KEY } as const;
export type UserLabelAssignment = typeof labelAssignments.$inferSelect & {
  labelSystemKey: string | null;
  labelName: string;
};

export const userLabelScope = (userUuid: string) => and(eq(labels.scopeType, "user"), eq(labels.scopeId, userUuid));

export async function resolveUserLabelRef(db: LabelsDb, userUuid: string, labelRef: string) {
  const { labelIds } = await resolveLabelPaths({ db, spaceId: userUuid, scopeType: "user", paths: [parseLabelRef(labelRef)] });
  if (!labelIds[0]) return null;
  const [label] = await db.select().from(labels).where(and(userLabelScope(userUuid), eq(labels.id, labelIds[0])));
  return label ?? null;
}

export async function resolveOrCreateUserLabelRefs(db: LabelsDb, userUuid: string, labelRefs: string[]) {
  const { labelIds } = await resolveOrCreateLabelPaths({
    db,
    spaceId: userUuid,
    scopeType: "user",
    userId: userUuid,
    paths: parseLabelRefs(labelRefs),
    systemKeys: USER_SYSTEM_LABELS,
  });
  const reservedNames = new Map(Object.entries(USER_SYSTEM_LABELS).map(([name, systemKey]) => [name.toLowerCase(), systemKey]));
  const reservedRefs = parseLabelRefs(labelRefs).filter((path) => reservedNames.has(path[0].toLowerCase()));
  if (reservedRefs.length) {
    const rows = await db.select({ name: labels.name, systemKey: labels.systemKey }).from(labels).where(and(userLabelScope(userUuid), inArray(labels.id, labelIds)));
    if (rows.some((row) => {
      const expectedSystemKey = reservedNames.get(row.name.toLowerCase());
      return expectedSystemKey !== undefined && row.systemKey !== expectedSystemKey;
    })) {
      throw new Error("label name is reserved for system use");
    }
  }
  return labelIds;
}

export async function ensurePinnedLabel(db: LabelsDb, userUuid: string) {
  await resolveOrCreateUserLabelRefs(db, userUuid, [PINNED_LABEL_NAME]);
  const label = await resolveUserLabelRef(db, userUuid, PINNED_LABEL_NAME);
  if (!label) throw new Error("failed to create pinned label");
  return label;
}

export function listUserLabels(db: LabelsDb, userUuid: string) {
  return db.select().from(labels).where(userLabelScope(userUuid)).orderBy(asc(labels.rank), asc(labels.name));
}

export async function getPinnedSpaceIds(db: LabelsDb, userUuid: string): Promise<Set<string>> {
  return getSystemSpaceIds(db, userUuid, PINNED_LABEL_SYSTEM_KEY);
}

export async function getArchivedSpaceIds(db: LabelsDb, userUuid: string): Promise<Set<string>> {
  return getSystemSpaceIds(db, userUuid, ARCHIVED_LABEL_SYSTEM_KEY);
}

async function getSystemSpaceIds(db: LabelsDb, userUuid: string, systemKey: string): Promise<Set<string>> {
  const rows = await db.select({ resourceRef: labelAssignments.resourceRef }).from(labelAssignments)
    .innerJoin(labels, eq(labels.id, labelAssignments.labelId))
    .where(and(userLabelScope(userUuid), eq(labels.systemKey, systemKey), eq(labelAssignments.resourceType, "space")));
  return new Set(rows.map((row) => row.resourceRef));
}

export async function getUserResourceLabelAssignments(db: LabelsDb, userUuid: string, resourceType: LabelResourceType, resourceRef: string): Promise<UserLabelAssignment[]> {
  const rows = await db.select({ assignment: labelAssignments, labelSystemKey: labels.systemKey, labelName: labels.name })
    .from(labelAssignments).innerJoin(labels, eq(labels.id, labelAssignments.labelId))
    .where(and(userLabelScope(userUuid), eq(labelAssignments.scopeType, "user"), eq(labelAssignments.scopeId, userUuid),
      eq(labelAssignments.resourceType, resourceType), eq(labelAssignments.resourceRef, resourceRef)))
    .orderBy(sql`${labelAssignments.rank} asc nulls last`, asc(labelAssignments.createdAt), asc(labelAssignments.id));
  return rows.map((row) => ({ ...row.assignment, labelSystemKey: row.labelSystemKey, labelName: row.labelName }));
}

export type UserLabelPatch = { addLabelRefs?: string[]; removeLabelRefs?: string[] };

export async function patchUserResourcesLabels(db: LabelsDb, userUuid: string, resourceType: LabelResourceType, resourceRefs: string[], input: UserLabelPatch) {
  const refs = [...new Set(resourceRefs)].sort();
  if (!refs.length || refs.length > 200) throw new Error("resourceRefs must contain 1-200 items");
  await db.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`user-labels:${userUuid}`}, 0))`);
  const adds = parseLabelRefs(input.addLabelRefs).map((path) => path.join("/"));
  const removes = parseLabelRefs(input.removeLabelRefs).map((path) => path.join("/"));
  if (adds.some((ref) => ref.toLowerCase() === "archived")) {
    if (adds.some((ref) => ref.toLowerCase() === "pinned")) throw new Error("cannot pin and archive together");
    removes.push("Pinned");
  } else if (adds.some((ref) => ref.toLowerCase() === "pinned")) {
    removes.push("Archived");
  }
  const addIds = await resolveOrCreateUserLabelRefs(db, userUuid, adds);
  const { labelIds: removeIds } = await resolveLabelPaths({ db, spaceId: userUuid, scopeType: "user", paths: parseLabelRefs([...new Set(removes)]) });
  if (removeIds.length) await db.delete(labelAssignments).where(and(
    eq(labelAssignments.scopeType, "user"), eq(labelAssignments.scopeId, userUuid),
    eq(labelAssignments.resourceType, resourceType), inArray(labelAssignments.resourceRef, refs), inArray(labelAssignments.labelId, removeIds),
  ));
  if (addIds.length) {
    const ranks = await db.select({ labelId: labelAssignments.labelId, rank: max(labelAssignments.rank) }).from(labelAssignments)
      .where(inArray(labelAssignments.labelId, addIds)).groupBy(labelAssignments.labelId);
    const byLabel = new Map(ranks.map((row) => [row.labelId, row.rank ?? 0]));
    await db.insert(labelAssignments).values(addIds.filter((id) => !removeIds.includes(id)).flatMap((labelId) => refs.map((resourceRef, i) => ({
      labelId, scopeType: "user", scopeId: userUuid, resourceType, resourceRef,
      rank: (byLabel.get(labelId) ?? 0) + (i + 1) * 10, source: "user", createdBy: userUuid,
    })))).onConflictDoNothing();
  }
  const rows = await db.select({ resourceRef: labelAssignments.resourceRef, labelSystemKey: labels.systemKey, labelName: labels.name, labelId: labelAssignments.labelId, rank: labelAssignments.rank, createdAt: labelAssignments.createdAt })
    .from(labelAssignments).innerJoin(labels, eq(labels.id, labelAssignments.labelId))
    .where(and(eq(labelAssignments.scopeType, "user"), eq(labelAssignments.scopeId, userUuid), eq(labelAssignments.resourceType, resourceType), inArray(labelAssignments.resourceRef, refs)))
    .orderBy(asc(labelAssignments.resourceRef), sql`${labelAssignments.rank} asc nulls last`, asc(labelAssignments.createdAt));
  const grouped = new Map<string, typeof rows>();
  for (const row of rows) grouped.set(row.resourceRef, [...(grouped.get(row.resourceRef) ?? []), row]);
  const assignmentsByRef = refs.map((resourceRef) => ({
    resourceRef,
    assignments: (grouped.get(resourceRef) ?? []).map(({ resourceRef: _resourceRef, ...assignment }) => assignment),
  }));
  return { resourceRefs: refs, affectedLabelIds: [...new Set([...addIds, ...removeIds])], assignmentsByRef };
}

export async function patchUserResourceLabels(db: LabelsDb, userUuid: string, resourceType: LabelResourceType, resourceRef: string, input: UserLabelPatch) {
  await patchUserResourcesLabels(db, userUuid, resourceType, [resourceRef], input);
  return getUserResourceLabelAssignments(db, userUuid, resourceType, resourceRef);
}
