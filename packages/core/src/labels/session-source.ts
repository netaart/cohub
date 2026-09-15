import { and, eq, max, sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { labels } from "@cohub/db";
import { assignLabelsToSession } from "./index.js";

type LabelsDb = PostgresJsDatabase<Record<string, unknown>>;

export type SessionSourceLabelInput = {
  source?: string | null;
  provider?: string | null;
};

type SourceLabelDefinition = {
  key: string;
  ref: string;
};

const SCOPE_TYPE = "space";
const ROOT_LABEL_NAME = "Source";
const CUSTOM_LABEL_NAME_SUFFIX = " (Custom)";

const SOURCE_LABELS: Record<string, string> = {
  public_api: "Source/Public API",
  scheduled_task: "Source/Scheduled Task",
  space_hook: "Source/Hook",
  web: "Source/Web App",
  web_app: "Source/Web App",
  websocket: "Source/Websocket",
  cli: "Source/CLI",
  feishu: "Source/Feishu",
  wechat: "Source/WeChat",
  discord: "Source/Discord",
  qq: "Source/QQ",
};

const normalizeKey = (value: string | null | undefined) => value?.trim().toLowerCase().replace(/[\s-]+/g, "_") || null;
const slugifyLabelName = (name: string) => {
  const slug = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return slug || "label";
};

const SOURCE_LABEL_REF_TO_KEY = new Map<string, string>();
for (const [key, ref] of Object.entries(SOURCE_LABELS)) {
  if (!SOURCE_LABEL_REF_TO_KEY.has(ref)) SOURCE_LABEL_REF_TO_KEY.set(ref, key);
}

export const SESSION_SOURCE_LABEL_SYSTEM_KEY_PREFIX = "session-source:";
export const SESSION_SOURCE_ROOT_LABEL_SYSTEM_KEY = `${SESSION_SOURCE_LABEL_SYSTEM_KEY_PREFIX}root`;

export function getSessionSourceLabelSystemKey(sourceKey: string) {
  return `${SESSION_SOURCE_LABEL_SYSTEM_KEY_PREFIX}${sourceKey}`;
}

export function resolveKnownSessionSourceLabelSystemKey(labelRef: string) {
  const sourceKey = SOURCE_LABEL_REF_TO_KEY.get(labelRef);
  return sourceKey ? getSessionSourceLabelSystemKey(sourceKey) : null;
}

export function resolveSessionSourceLabelSystemKey(labelRef: string) {
  return resolveKnownSessionSourceLabelSystemKey(labelRef) ?? getSessionSourceLabelSystemKey("other");
}

/**
 * Stable key for a raw `space_sessions.source` value, used both by the source
 * labels above and by cross-space session filtering. A null source means a
 * legacy web chat, matching the historical client-side default. Aliases that
 * share a label (`web` / `web_app`) collapse to the first key in the table.
 */
export function resolveSessionSourceKey(source: string | null | undefined): string {
  const sourceKey = normalizeKey(source) ?? "web";
  const direct = SOURCE_LABEL_REF_TO_KEY.get(SOURCE_LABELS[sourceKey] ?? "");
  if (direct) return direct;
  const channelPrefixMatch = sourceKey.match(/^channel[:_](.+)$/);
  const channelKey = channelPrefixMatch?.[1] ?? (sourceKey.includes(":") ? sourceKey.split(":")[0] : null);
  const channelRef = channelKey ? SOURCE_LABELS[channelKey] : undefined;
  return (channelRef && SOURCE_LABEL_REF_TO_KEY.get(channelRef)) || "other";
}

/** Selectable kinds, vocabulary order with `other` last. */
export const SESSION_SOURCE_KEYS: readonly string[] = [
  ...new Set(Object.keys(SOURCE_LABELS).map(resolveSessionSourceKey)),
  "other",
];

export function resolveSessionSourceLabelRef(input: SessionSourceLabelInput): string {
  const providerKey = normalizeKey(input.provider);
  if (providerKey && SOURCE_LABELS[providerKey]) return SOURCE_LABELS[providerKey];

  const sourceKey = normalizeKey(input.source);
  if (!sourceKey) return "Source/Other";
  if (SOURCE_LABELS[sourceKey]) return SOURCE_LABELS[sourceKey];

  const channelPrefixMatch = sourceKey.match(/^channel[:_](.+)$/);
  const channelKey = channelPrefixMatch?.[1] ?? (sourceKey.includes(":") ? sourceKey.split(":")[0] : null);
  if (channelKey && SOURCE_LABELS[channelKey]) return SOURCE_LABELS[channelKey];

  return "Source/Other";
}

function resolveSessionSourceLabelDefinition(input: SessionSourceLabelInput): SourceLabelDefinition {
  const labelRef = resolveSessionSourceLabelRef(input);
  const key = SOURCE_LABEL_REF_TO_KEY.get(labelRef) ?? "other";
  return { key, ref: labelRef };
}

async function findLabelBySystemKey(db: LabelsDb, spaceId: string, systemKey: string) {
  const [row] = await db
    .select()
    .from(labels)
    .where(and(eq(labels.scopeType, SCOPE_TYPE), eq(labels.scopeId, spaceId), eq(labels.systemKey, systemKey)))
    .limit(1);
  return row ?? null;
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

function customFallbackLabelName(name: string, suffix: string) {
  const base = name.length + suffix.length <= 80
    ? name
    : name.slice(0, 80 - suffix.length);
  return `${base}${suffix}`;
}

async function nextAvailableCustomLabelName(db: LabelsDb, input: { spaceId: string; name: string; parentId: string | null }) {
  for (let index = 0; index < 100; index += 1) {
    const suffix = index === 0 ? CUSTOM_LABEL_NAME_SUFFIX : ` (Custom ${index + 1})`;
    const candidate = customFallbackLabelName(input.name, suffix);
    const existing = await findLabelByName(db, input.spaceId, candidate, input.parentId);
    if (!existing) return candidate;
  }
  throw new Error(`failed to rename conflicting user label: ${input.name}`);
}

async function moveConflictingUserLabel(db: LabelsDb, input: { spaceId: string; name: string; parentId: string | null }) {
  const existing = await findLabelByName(db, input.spaceId, input.name, input.parentId);
  if (!existing || existing.source === "system") return;
  const name = await nextAvailableCustomLabelName(db, input);
  await db
    .update(labels)
    .set({ name, slug: slugifyLabelName(name), updatedAt: new Date() })
    .where(and(eq(labels.id, existing.id), eq(labels.source, "user")));
}

async function getOrCreateSystemLabel(db: LabelsDb, input: {
  spaceId: string;
  name: string;
  parentId: string | null;
  depth: 0 | 1;
  systemKey: string;
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
    createdBy: null,
  }).onConflictDoNothing().returning();
  if (created) return created;

  const raced = await findLabelBySystemKey(db, input.spaceId, input.systemKey) ?? await findLabelByName(db, input.spaceId, input.name, input.parentId);
  if (!raced) throw new Error("failed to create source label");
  return raced;
}

export async function assignSessionSourceSystemLabel(input: {
  db: LabelsDb;
  spaceId: string;
  sessionId: string;
  source?: string | null;
  provider?: string | null;
}) {
  const labelDefinition = resolveSessionSourceLabelDefinition({ source: input.source, provider: input.provider });
  const [, childName] = labelDefinition.ref.split("/") as [string, string];
  const rootLabel = await getOrCreateSystemLabel(input.db, {
    spaceId: input.spaceId,
    name: ROOT_LABEL_NAME,
    parentId: null,
    depth: 0,
    systemKey: SESSION_SOURCE_ROOT_LABEL_SYSTEM_KEY,
  });
  const childLabel = await getOrCreateSystemLabel(input.db, {
    spaceId: input.spaceId,
    name: childName,
    parentId: rootLabel.id,
    depth: 1,
    systemKey: getSessionSourceLabelSystemKey(labelDefinition.key),
  });
  await assignLabelsToSession({
    db: input.db,
    spaceId: input.spaceId,
    sessionId: input.sessionId,
    labelIds: [childLabel.id],
    userId: null,
    source: "system",
  });
}
