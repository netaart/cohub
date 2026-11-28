import { and, desc, eq, inArray, isNull, sql, type SQL } from "drizzle-orm";
import { inboxItems } from "@cohub/db";
import {
  NOTIFICATION_KINDS,
  type InboxItem,
  type InboxReadTarget,
  type InboxSummary,
  type NotificationKind,
  type NotificationPayloads,
} from "@cohub/protocol";
import { loadNotificationActors, type NotificationDb } from "./store.js";

export type InboxItemRow = typeof inboxItems.$inferSelect;

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
const UUID = /^[0-9a-f-]{36}$/i;

const knownKind = inArray(inboxItems.kind, NOTIFICATION_KINDS);

export const notifyKey = (item: Pick<NotifyItem, "recipientId" | "groupKey">) => `${item.recipientId}\u0000${item.groupKey}`;

export async function upsertInboxItems(db: NotificationDb, items: readonly NotifyItem[]): Promise<InboxItemRow[]> {
  if (items.length === 0) return [];
  const now = new Date();
  return db.insert(inboxItems).values(items.map((item) => ({
    recipientId: item.recipientId,
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
    target: [inboxItems.recipientId, inboxItems.groupKey],
    set: {
      kind: sql`excluded.kind`,
      turnId: sql`excluded.turn_id`,
      payload: sql`excluded.payload`,
      actorIds: sql`case when ${inboxItems.readAt} is not null or cardinality(excluded.actor_ids) = 0 then excluded.actor_ids
        else (excluded.actor_ids || array_remove(${inboxItems.actorIds}, excluded.actor_ids[1]))[1:${sql.raw(String(MAX_ACTORS))}] end`,
      count: sql`case when ${inboxItems.readAt} is null then ${inboxItems.count} + 1 else 1 end`,
      revision: sql`${inboxItems.revision} + 1`,
      readAt: null,
      updatedAt: now,
    },
  }).returning();
}

export async function toInboxItems(db: NotificationDb, rows: readonly InboxItemRow[]): Promise<InboxItem[]> {
  const actors = await loadNotificationActors(db, rows.flatMap((row) => row.actorIds));
  return rows.map((row) => ({
    id: row.id,
    kind: row.kind,
    groupKey: row.groupKey,
    spaceId: row.spaceId,
    sessionId: row.sessionId,
    turnId: row.turnId,
    actors: row.actorIds.flatMap((id) => actors.get(id) ?? []),
    payload: row.payload,
    count: row.count,
    revision: row.revision,
    readAt: row.readAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  }) as InboxItem);
}

export async function readInboxSummary(db: NotificationDb, recipientId: string): Promise<InboxSummary> {
  const unread = db.select({ id: inboxItems.id })
    .from(inboxItems)
    .where(and(eq(inboxItems.recipientId, recipientId), isNull(inboxItems.readAt), knownKind))
    .limit(UNREAD_SCAN_LIMIT)
    .as("unread");
  const [row] = await db.select({ count: sql<number>`count(*)::int` }).from(unread);
  return { unread: row?.count ?? 0 };
}

export class InvalidInboxCursorError extends Error {}

export async function listInboxItems(db: NotificationDb, recipientId: string, options: {
  unread?: boolean;
  cursor?: string | null;
  limit: number;
}) {
  const conditions: SQL[] = [eq(inboxItems.recipientId, recipientId), knownKind];
  if (options.unread) conditions.push(isNull(inboxItems.readAt));
  if (options.cursor) {
    const [at, id] = options.cursor.split("|");
    const date = new Date(at ?? "");
    if (Number.isNaN(date.getTime()) || !id || !UUID.test(id)) throw new InvalidInboxCursorError("invalid cursor");
    conditions.push(sql`(${inboxItems.updatedAt}, ${inboxItems.id}) < (${date.toISOString()}::timestamptz, ${id}::uuid)`);
  }
  const rows = await db.select().from(inboxItems)
    .where(and(...conditions))
    .orderBy(desc(inboxItems.updatedAt), desc(inboxItems.id))
    .limit(options.limit + 1);
  const items = rows.slice(0, options.limit);
  const last = items.at(-1);
  const hasMore = rows.length > options.limit && last !== undefined;
  return { items, hasMore, nextCursor: hasMore && last ? `${last.updatedAt.toISOString()}|${last.id}` : null };
}

export function parseInboxReadTarget(value: unknown): InboxReadTarget | null {
  if (!value || typeof value !== "object") return null;
  const body = value as Record<string, unknown>;
  const present = ["ids", "sessionId", "all"].filter((key) => body[key] !== undefined);
  if (present.length !== 1) return null;
  if (Array.isArray(body.ids)) {
    const ids = body.ids.filter((id): id is string => typeof id === "string" && UUID.test(id));
    return ids.length > 0 && ids.length <= 200 && ids.length === body.ids.length ? { ids } : null;
  }
  if (typeof body.sessionId === "string") return UUID.test(body.sessionId) ? { sessionId: body.sessionId } : null;
  return body.all === true ? { all: true } : null;
}

export async function markInboxRead(db: NotificationDb, recipientId: string, target: InboxReadTarget, readAt = new Date()) {
  const scope = "ids" in target
    ? inArray(inboxItems.id, target.ids)
    : "sessionId" in target
      ? eq(inboxItems.sessionId, target.sessionId)
      : undefined;
  const changed = await db.update(inboxItems)
    .set({ readAt })
    .where(and(eq(inboxItems.recipientId, recipientId), isNull(inboxItems.readAt), scope))
    .returning({ id: inboxItems.id });
  return changed.length;
}

export async function unreadInboxIds(db: NotificationDb, recipientId: string, ids: readonly string[]) {
  if (ids.length === 0) return new Set<string>();
  const rows = await db.select({ id: inboxItems.id }).from(inboxItems)
    .where(and(eq(inboxItems.recipientId, recipientId), inArray(inboxItems.id, [...new Set(ids)]), isNull(inboxItems.readAt)));
  return new Set(rows.map((row) => row.id));
}
