import { and, eq, max, sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { labels } from "@cohub/db";

type LabelsDb = PostgresJsDatabase<Record<string, unknown>>;

const SCOPE_TYPE = "space";
const CUSTOM_LABEL_NAME_SUFFIX = " (Custom)";

const slugifyLabelName = (name: string) => {
  const slug = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return slug || "label";
};

const siblingOf = (parentId: string | null) => parentId ? eq(labels.parentId, parentId) : sql`${labels.parentId} is null`;

async function findLabelByName(db: LabelsDb, spaceId: string, name: string, parentId: string | null) {
  const [row] = await db.select().from(labels).where(and(
    eq(labels.scopeType, SCOPE_TYPE),
    eq(labels.scopeId, spaceId),
    siblingOf(parentId),
    sql`lower(${labels.name}) = lower(${name})`,
  )).limit(1);
  return row ?? null;
}

export async function findSpaceSystemLabel(db: LabelsDb, spaceId: string, systemKey: string) {
  const [row] = await db.select().from(labels)
    .where(and(eq(labels.scopeType, SCOPE_TYPE), eq(labels.scopeId, spaceId), eq(labels.systemKey, systemKey)))
    .limit(1);
  return row ?? null;
}

async function nextLabelRank(db: LabelsDb, spaceId: string, parentId: string | null) {
  const [{ value } = { value: 0 }] = await db.select({ value: max(labels.rank) }).from(labels)
    .where(and(eq(labels.scopeType, SCOPE_TYPE), eq(labels.scopeId, spaceId), siblingOf(parentId)));
  return Number(value ?? 0) + 10;
}

function customFallbackLabelName(name: string, suffix: string) {
  return `${name.length + suffix.length <= 80 ? name : name.slice(0, 80 - suffix.length)}${suffix}`;
}

async function moveConflictingUserLabel(db: LabelsDb, input: { spaceId: string; name: string; parentId: string | null }) {
  const existing = await findLabelByName(db, input.spaceId, input.name, input.parentId);
  if (!existing || existing.source === "system") return;
  for (let index = 0; index < 100; index += 1) {
    const name = customFallbackLabelName(input.name, index === 0 ? CUSTOM_LABEL_NAME_SUFFIX : ` (Custom ${index + 1})`);
    if (await findLabelByName(db, input.spaceId, name, input.parentId)) continue;
    await db.update(labels)
      .set({ name, slug: slugifyLabelName(name), updatedAt: new Date() })
      .where(and(eq(labels.id, existing.id), eq(labels.source, "user")));
    return;
  }
  throw new Error(`failed to rename conflicting user label: ${input.name}`);
}

export async function getOrCreateSpaceSystemLabel(db: LabelsDb, input: {
  spaceId: string;
  name: string;
  parentId: string | null;
  depth: 0 | 1;
  systemKey: string;
  userId?: string | null;
}) {
  const existingBySystemKey = await findSpaceSystemLabel(db, input.spaceId, input.systemKey);
  if (existingBySystemKey) return existingBySystemKey;

  await moveConflictingUserLabel(db, input);
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
    createdBy: input.userId ?? null,
  }).onConflictDoNothing().returning();
  if (created) return created;

  const raced = await findSpaceSystemLabel(db, input.spaceId, input.systemKey)
    ?? await findLabelByName(db, input.spaceId, input.name, input.parentId);
  if (!raced) throw new Error(`failed to create system label ${input.systemKey}`);
  return raced;
}
