import { and, inArray, isNotNull } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { labels } from "@cohub/db";
import { LIKE_RESOURCE_TYPES, LIKED_LABEL_SYSTEM_KEY, type LikeResourceType } from "@cohub/protocol";
import { adjustLikeCounts } from "./likes.js";
import type { LabelResourceType } from "./resource-events.js";

type LabelsDb = PostgresJsDatabase<Record<string, unknown>>;

export type SystemLabelChanges = { added: string[]; removed: string[] };

type SystemLabelEffect<T extends LabelResourceType = LabelResourceType> = {
  name: string;
  resourceTypes: readonly T[];
  apply(db: LabelsDb, resourceType: T, changes: SystemLabelChanges): Promise<void>;
};

const likedEffect: SystemLabelEffect<LikeResourceType> = {
  name: "Liked",
  resourceTypes: LIKE_RESOURCE_TYPES,
  async apply(db, resourceType, { added, removed }) {
    await adjustLikeCounts(db, resourceType, removed, -1);
    await adjustLikeCounts(db, resourceType, added, 1);
  },
};

// Every user-scope assignment write must go through `patchUserResourcesLabels` to apply these.
const SYSTEM_LABEL_EFFECTS: Record<string, SystemLabelEffect> = {
  [LIKED_LABEL_SYSTEM_KEY]: likedEffect as SystemLabelEffect,
};

export type SystemLabelEffects = Map<string, SystemLabelEffect>;

export async function loadSystemLabelEffects(db: LabelsDb, labelIds: string[]): Promise<SystemLabelEffects> {
  const effects: SystemLabelEffects = new Map();
  if (!labelIds.length) return effects;
  const rows = await db
    .select({ id: labels.id, systemKey: labels.systemKey })
    .from(labels)
    .where(and(inArray(labels.id, labelIds), isNotNull(labels.systemKey)));
  for (const row of rows) {
    const effect = row.systemKey ? SYSTEM_LABEL_EFFECTS[row.systemKey] : undefined;
    if (effect) effects.set(row.id, effect);
  }
  return effects;
}

export function assertSystemLabelsApplicable(effects: SystemLabelEffects, labelIds: string[], resourceType: LabelResourceType) {
  for (const labelId of labelIds) {
    const effect = effects.get(labelId);
    if (effect && !effect.resourceTypes.includes(resourceType)) {
      throw new Error(`${effect.name} cannot be applied to ${resourceType}`);
    }
  }
}

export async function applySystemLabelEffects(
  db: LabelsDb,
  effects: SystemLabelEffects,
  resourceType: LabelResourceType,
  changes: { added: Array<{ labelId: string; resourceRef: string }>; removed: Array<{ labelId: string; resourceRef: string }> },
) {
  for (const [labelId, effect] of effects) {
    const refsOf = (rows: Array<{ labelId: string; resourceRef: string }>) =>
      rows.filter((row) => row.labelId === labelId).map((row) => row.resourceRef);
    const added = refsOf(changes.added);
    const removed = refsOf(changes.removed);
    if (added.length || removed.length) await effect.apply(db, resourceType, { added, removed });
  }
}
