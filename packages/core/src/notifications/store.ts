import { and, desc, eq, inArray, isNull, sql, type SQL } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import {
  notificationPreferences,
  notifications,
  pushTargets,
  userProfiles,
} from "@cohub/db";
import {
  NOTIFICATION_CATEGORIES,
  NOTIFICATION_CATEGORY_DEFAULTS,
  NOTIFICATION_CHANNELS,
  notificationCategoryOf,
  type NotificationActor,
  type NotificationCategory,
  type NotificationChannel,
  type NotificationKind,
  type NotificationPayloads,
  type NotificationPreferences,
  type NotificationPreferencesPatch,
  type NotificationReadTarget,
  type NotificationRecord,
  type NotificationSummary,
  type PushTargetInput,
} from "@cohub/protocol";

export type NotificationDb = PostgresJsDatabase<Record<string, unknown>>;
export type NotificationRow = typeof notifications.$inferSelect;
export type PushTargetRow = typeof pushTargets.$inferSelect;

export type NotifyItem<K extends NotificationKind = NotificationKind> = {
  recipientId: string;
  kind: K;
  groupKey: string;
  spaceId?: string | null;
  sessionId?: string | null;
  turnId?: string | null;
  actorId?: string | null;
  payload: NotificationPayloads[K];
};

const MAX_ACTORS = 5;
const UNREAD_SCAN_LIMIT = 1_000;

export async function upsertNotifications(db: NotificationDb, items: readonly NotifyItem[]): Promise<NotificationRow[]> {
  const unique = new Map<string, NotifyItem>();
  for (const item of items) unique.set(`${item.recipientId}\u0000${item.groupKey}`, item);
  if (unique.size === 0) return [];
  const now = new Date();
  return db.insert(notifications).values([...unique.values()].map((item) => ({
    recipientId: item.recipientId,
    category: notificationCategoryOf(item.kind),
    kind: item.kind,
    groupKey: item.groupKey,
    spaceId: item.spaceId ?? null,
    sessionId: item.sessionId ?? null,
    turnId: item.turnId ?? null,
    actorIds: item.actorId ? [item.actorId] : [],
    payload: item.payload as Record<string, unknown>,
    createdAt: now,
    updatedAt: now,
  }))).onConflictDoUpdate({
    target: [notifications.recipientId, notifications.groupKey],
    set: {
      kind: sql`excluded.kind`,
      category: sql`excluded.category`,
      turnId: sql`excluded.turn_id`,
      payload: sql`excluded.payload`,
      actorIds: sql`case when ${notifications.readAt} is not null or cardinality(excluded.actor_ids) = 0 then excluded.actor_ids
        else (excluded.actor_ids || array_remove(${notifications.actorIds}, excluded.actor_ids[1]))[1:${sql.raw(String(MAX_ACTORS))}] end`,
      count: sql`case when ${notifications.readAt} is null then ${notifications.count} + 1 else 1 end`,
      revision: sql`${notifications.revision} + 1`,
      readAt: null,
      updatedAt: now,
    },
  }).returning();
}

export async function loadNotificationActors(db: NotificationDb, ids: readonly string[]) {
  const unique = [...new Set(ids)];
  const actors = new Map<string, NotificationActor>();
  if (unique.length === 0) return actors;
  const rows = await db.select({
    userUuid: userProfiles.userUuid,
    username: userProfiles.username,
    displayName: userProfiles.displayName,
    avatarUrl: userProfiles.avatarUrl,
  }).from(userProfiles).where(inArray(userProfiles.userUuid, unique));
  for (const row of rows) actors.set(row.userUuid, { ...row, avatarUrl: row.avatarUrl ?? null });
  return actors;
}

export async function toNotificationRecords(db: NotificationDb, rows: readonly NotificationRow[]): Promise<NotificationRecord[]> {
  const actors = await loadNotificationActors(db, rows.flatMap((row) => row.actorIds));
  return rows.map((row) => ({
    id: row.id,
    kind: row.kind,
    category: row.category,
    spaceId: row.spaceId,
    sessionId: row.sessionId,
    turnId: row.turnId,
    actors: row.actorIds.flatMap((id) => {
      const actor = actors.get(id);
      return actor ? [actor] : [];
    }),
    payload: row.payload,
    count: row.count,
    revision: row.revision,
    readAt: row.readAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  }) as NotificationRecord);
}

export async function readNotificationSummary(db: NotificationDb, recipientId: string): Promise<NotificationSummary> {
  const unread = db.select({ category: notifications.category })
    .from(notifications)
    .where(and(eq(notifications.recipientId, recipientId), isNull(notifications.readAt)))
    .limit(UNREAD_SCAN_LIMIT)
    .as("unread");
  const rows = await db.select({ category: unread.category, count: sql<number>`count(*)::int` })
    .from(unread)
    .groupBy(unread.category);
  const byCategory = Object.fromEntries(NOTIFICATION_CATEGORIES.map((category) => [category, 0])) as Record<NotificationCategory, number>;
  for (const row of rows) if (row.category in byCategory) byCategory[row.category] = row.count;
  return { unread: rows.reduce((sum, row) => sum + row.count, 0), byCategory };
}

export class InvalidNotificationCursorError extends Error {}

export async function listNotifications(db: NotificationDb, recipientId: string, options: {
  category?: NotificationCategory | null;
  cursor?: string | null;
  limit: number;
}) {
  const conditions: SQL[] = [eq(notifications.recipientId, recipientId)];
  if (options.category) conditions.push(eq(notifications.category, options.category));
  if (options.cursor) {
    const [at, id] = options.cursor.split("|");
    const date = new Date(at ?? "");
    if (Number.isNaN(date.getTime()) || !id) throw new InvalidNotificationCursorError("invalid cursor");
    conditions.push(sql`(${notifications.updatedAt}, ${notifications.id}) < (${date.toISOString()}::timestamptz, ${id}::uuid)`);
  }
  const rows = await db.select().from(notifications)
    .where(and(...conditions))
    .orderBy(desc(notifications.updatedAt), desc(notifications.id))
    .limit(options.limit + 1);
  const items = rows.slice(0, options.limit);
  const last = items.at(-1);
  const hasMore = rows.length > options.limit && last !== undefined;
  return { items, hasMore, nextCursor: hasMore && last ? `${last.updatedAt.toISOString()}|${last.id}` : null };
}

export function parseNotificationReadTarget(value: unknown): NotificationReadTarget | null {
  if (!value || typeof value !== "object") return null;
  const body = value as Record<string, unknown>;
  const present = ["ids", "category", "sessionId", "all"].filter((key) => body[key] !== undefined);
  if (present.length !== 1) return null;
  if (Array.isArray(body.ids)) {
    const ids = body.ids.filter((id): id is string => typeof id === "string" && /^[0-9a-f-]{36}$/i.test(id));
    return ids.length > 0 && ids.length <= 200 && ids.length === body.ids.length ? { ids } : null;
  }
  if (typeof body.category === "string") {
    return (NOTIFICATION_CATEGORIES as readonly string[]).includes(body.category) ? { category: body.category as NotificationCategory } : null;
  }
  if (typeof body.sessionId === "string") return /^[0-9a-f-]{36}$/i.test(body.sessionId) ? { sessionId: body.sessionId } : null;
  return body.all === true ? { all: true } : null;
}

export async function markNotificationsRead(db: NotificationDb, recipientId: string, target: NotificationReadTarget, readAt = new Date()) {
  const scope = "ids" in target
    ? inArray(notifications.id, target.ids)
    : "category" in target
      ? eq(notifications.category, target.category)
      : "sessionId" in target
        ? eq(notifications.sessionId, target.sessionId)
        : undefined;
  const changed = await db.update(notifications)
    .set({ readAt })
    .where(and(eq(notifications.recipientId, recipientId), isNull(notifications.readAt), scope))
    .returning({ id: notifications.id });
  return changed.length;
}

export async function readNotificationPreferences(db: NotificationDb, userId: string): Promise<NotificationPreferences> {
  const rows = await db.select({ category: notificationPreferences.category, channels: notificationPreferences.channels })
    .from(notificationPreferences)
    .where(and(eq(notificationPreferences.userId, userId), eq(notificationPreferences.scopeType, "global")));
  const overrides = new Map(rows.map((row) => [row.category, row.channels]));
  return {
    categories: Object.fromEntries(NOTIFICATION_CATEGORIES.map((category) => [
      category,
      { ...NOTIFICATION_CATEGORY_DEFAULTS[category], ...overrides.get(category) },
    ])) as NotificationPreferences["categories"],
  };
}

export function parseNotificationPreferencesPatch(value: unknown): NotificationPreferencesPatch | null {
  const categories = (value as { categories?: unknown } | null)?.categories;
  if (!categories || typeof categories !== "object" || Array.isArray(categories)) return null;
  const patch: NotificationPreferencesPatch["categories"] = {};
  for (const [category, channels] of Object.entries(categories)) {
    if (!(NOTIFICATION_CATEGORIES as readonly string[]).includes(category)) return null;
    if (!channels || typeof channels !== "object" || Array.isArray(channels)) return null;
    const next: Partial<Record<NotificationChannel, boolean>> = {};
    for (const [channel, enabled] of Object.entries(channels)) {
      if (!(NOTIFICATION_CHANNELS as readonly string[]).includes(channel) || typeof enabled !== "boolean") return null;
      next[channel as NotificationChannel] = enabled;
    }
    patch[category as NotificationCategory] = next;
  }
  return { categories: patch };
}

export async function updateNotificationPreferences(db: NotificationDb, userId: string, patch: NotificationPreferencesPatch) {
  const rows = Object.entries(patch.categories).map(([category, channels]) => ({
    userId,
    scopeType: "global" as const,
    scopeId: "",
    category: category as NotificationCategory,
    channels: channels ?? {},
    updatedAt: new Date(),
  }));
  if (rows.length > 0) {
    await db.insert(notificationPreferences).values(rows).onConflictDoUpdate({
      target: [notificationPreferences.userId, notificationPreferences.scopeType, notificationPreferences.scopeId, notificationPreferences.category],
      set: { channels: sql`${notificationPreferences.channels} || excluded.channels`, updatedAt: sql`excluded.updated_at` },
    });
  }
  return readNotificationPreferences(db, userId);
}

export async function registerPushTarget(db: NotificationDb, userId: string, input: PushTargetInput) {
  const now = new Date();
  await db.insert(pushTargets).values({
    userId,
    deviceId: input.deviceId,
    transport: input.transport,
    token: input.token,
    keys: input.keys ?? null,
    locale: input.locale ?? null,
    lastSeenAt: now,
  }).onConflictDoUpdate({
    target: [pushTargets.transport, pushTargets.token],
    set: { userId, deviceId: input.deviceId, keys: input.keys ?? null, locale: input.locale ?? null, lastSeenAt: now, disabledAt: null, failureCount: 0 },
  });
}

export async function unregisterPushTarget(db: NotificationDb, userId: string, deviceId: string) {
  await db.delete(pushTargets).where(and(eq(pushTargets.userId, userId), eq(pushTargets.deviceId, deviceId)));
}

export function listActivePushTargets(db: NotificationDb, userId: string) {
  return db.select().from(pushTargets).where(and(eq(pushTargets.userId, userId), isNull(pushTargets.disabledAt)));
}
