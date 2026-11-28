import { and, eq, inArray, sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { notificationPreferences, userProfiles } from "@cohub/db";
import {
  isNotificationChannel,
  isNotificationKind,
  NOTIFICATION_DEFAULTS,
  NOTIFICATION_KINDS,
  type NotificationActor,
  type NotificationChannelSettings,
  type NotificationKind,
  type NotificationPreferences,
  type NotificationPreferencesPatch,
} from "@cohub/protocol";

export type NotificationDb = PostgresJsDatabase<Record<string, unknown>>;

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

const resolveChannels = (kind: NotificationKind, override: Partial<NotificationChannelSettings> | undefined): NotificationChannelSettings => {
  const defaults = NOTIFICATION_DEFAULTS[kind];
  return {
    inbox: override?.inbox ?? defaults.inbox,
    push: override?.push ?? defaults.push,
    email: override?.email ?? defaults.email,
  };
};

const resolvePreferences = (overrides?: Map<string, Partial<NotificationChannelSettings>>): NotificationPreferences => ({
  kinds: Object.fromEntries(NOTIFICATION_KINDS.map((kind) => [kind, resolveChannels(kind, overrides?.get(kind))])) as NotificationPreferences["kinds"],
});

export async function readNotificationPreferencesFor(db: NotificationDb, userIds: readonly string[]) {
  const unique = [...new Set(userIds)];
  const overrides = new Map<string, Map<string, Partial<NotificationChannelSettings>>>();
  if (unique.length > 0) {
    const rows = await db.select({ userId: notificationPreferences.userId, kind: notificationPreferences.kind, channels: notificationPreferences.channels })
      .from(notificationPreferences)
      .where(and(inArray(notificationPreferences.userId, unique), eq(notificationPreferences.scopeType, "global")));
    for (const row of rows) overrides.set(row.userId, (overrides.get(row.userId) ?? new Map()).set(row.kind, row.channels));
  }
  return new Map(unique.map((userId) => [userId, resolvePreferences(overrides.get(userId))]));
}

export async function readNotificationPreferences(db: NotificationDb, userId: string): Promise<NotificationPreferences> {
  return (await readNotificationPreferencesFor(db, [userId])).get(userId) ?? resolvePreferences();
}

export function parseNotificationPreferencesPatch(value: unknown): NotificationPreferencesPatch | null {
  const kinds = (value as { kinds?: unknown } | null)?.kinds;
  if (!kinds || typeof kinds !== "object" || Array.isArray(kinds)) return null;
  const patch: NotificationPreferencesPatch["kinds"] = {};
  for (const [kind, channels] of Object.entries(kinds)) {
    if (!isNotificationKind(kind) || !channels || typeof channels !== "object" || Array.isArray(channels)) return null;
    const next: Partial<NotificationChannelSettings> = {};
    for (const [channel, enabled] of Object.entries(channels)) {
      if (!isNotificationChannel(channel) || typeof enabled !== "boolean") return null;
      next[channel] = enabled;
    }
    patch[kind] = next;
  }
  return { kinds: patch };
}

export async function updateNotificationPreferences(db: NotificationDb, userId: string, patch: NotificationPreferencesPatch) {
  const updatedAt = new Date();
  const rows = Object.entries(patch.kinds).map(([kind, channels]) => ({
    userId,
    scopeType: "global" as const,
    scopeId: "",
    kind: kind as NotificationKind,
    channels: channels ?? {},
    updatedAt,
  }));
  if (rows.length > 0) {
    await db.insert(notificationPreferences).values(rows).onConflictDoUpdate({
      target: [notificationPreferences.userId, notificationPreferences.scopeType, notificationPreferences.scopeId, notificationPreferences.kind],
      set: { channels: sql`${notificationPreferences.channels} || excluded.channels`, updatedAt: sql`excluded.updated_at` },
    });
  }
  return readNotificationPreferences(db, userId);
}
