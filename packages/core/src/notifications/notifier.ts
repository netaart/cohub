import { randomUUID } from "node:crypto";
import type {
  InboxItem,
  InboxReadTarget,
  InboxSummary,
  Notice,
  NotificationChannelSettings,
  NotificationEmailEntry,
  NotificationPushJobData,
} from "@cohub/protocol";
import { getRealtimeUserRoom, type InboxChangedEvent, type NotificationSentEvent } from "@cohub/protocol/realtime";
import {
  markInboxRead,
  notifyKey,
  readInboxSummary,
  toInboxItems,
  upsertInboxItems,
  type NotifyItem,
} from "./inbox.js";
import { loadNotificationActors, readNotificationPreferencesFor, type NotificationDb } from "./store.js";

export type NotificationEvent = InboxChangedEvent | NotificationSentEvent;

export type NotifierDeps = {
  db: NotificationDb;
  publish: (event: NotificationEvent) => Promise<unknown>;
  push?: (jobs: NotificationPushJobData[]) => Promise<unknown>;
  email?: (entries: { userId: string; entry: NotificationEmailEntry }[]) => Promise<unknown>;
  logger?: Pick<Console, "warn">;
};

export type SentNotice = {
  recipientId: string;
  notice: Notice;
  channels: NotificationChannelSettings;
  inboxItem: InboxItem | null;
};

export const notificationEvent = <E extends NotificationEvent>(recipientId: string, type: E["type"], payload: E["payload"]) => ({
  id: randomUUID(),
  timestamp: Date.now(),
  domain: "notification",
  type,
  rooms: [getRealtimeUserRoom(recipientId)],
  payload,
}) as E;

const toNotice = (item: InboxItem) => ({
  id: item.id,
  kind: item.kind,
  groupKey: item.groupKey,
  spaceId: item.spaceId,
  sessionId: item.sessionId,
  turnId: item.turnId,
  actors: item.actors,
  payload: item.payload,
  createdAt: item.updatedAt,
}) as Notice;

export function createNotifier(deps: NotifierDeps) {
  const logger = deps.logger ?? console;
  const attempt = (label: string, work: Promise<unknown> | undefined) =>
    work?.catch((error) => logger.warn(`[Notifications] failed to ${label}`, { error }));

  const publishInbox = (recipientId: string, payload: Omit<InboxChangedEvent["payload"], "summary">, summary?: InboxSummary) =>
    attempt("publish inbox change", (async () => {
      const current = summary ?? await readInboxSummary(deps.db, recipientId);
      await deps.publish(notificationEvent<InboxChangedEvent>(recipientId, "inbox.changed", { ...payload, summary: current }));
    })());

  return {
    async notify(items: readonly NotifyItem[]): Promise<SentNotice[]> {
      const unique = [...new Map(items.map((item) => [notifyKey(item), item])).values()];
      if (unique.length === 0) return [];
      const preferences = await readNotificationPreferencesFor(deps.db, unique.map((item) => item.recipientId));
      const plans = unique.flatMap((item) => {
        const channels = preferences.get(item.recipientId)?.kinds[item.kind];
        return channels && (channels.inbox || channels.push || channels.email) ? [{ item, channels }] : [];
      });
      const kept = plans.filter((plan) => plan.channels.inbox).map((plan) => plan.item);
      const passingActorIds = plans.filter((plan) => !plan.channels.inbox).flatMap((plan) => plan.item.actorId ?? []);
      const rows = await upsertInboxItems(deps.db, kept);
      const [records, actors] = await Promise.all([toInboxItems(deps.db, rows), loadNotificationActors(deps.db, passingActorIds)]);
      const stored = new Map(rows.map((row, index) => [notifyKey(row), records[index]]));
      const createdAt = new Date().toISOString();

      const sent = plans.map(({ item, channels }): SentNotice => {
        const record = channels.inbox ? stored.get(notifyKey(item)) ?? null : null;
        const actor = item.actorId ? actors.get(item.actorId) : undefined;
        const notice = record ? toNotice(record) : {
          id: randomUUID(),
          kind: item.kind,
          groupKey: item.groupKey,
          spaceId: item.spaceId ?? null,
          sessionId: item.sessionId ?? null,
          turnId: item.turnId ?? null,
          actors: actor ? [actor] : [],
          payload: item.payload,
          createdAt,
        } as Notice;
        return { recipientId: item.recipientId, notice, channels, inboxItem: record };
      });

      const upserted = new Map<string, InboxItem[]>();
      for (const { recipientId, inboxItem } of sent) if (inboxItem) upserted.set(recipientId, [...(upserted.get(recipientId) ?? []), inboxItem]);
      const pushing = sent.filter((entry) => entry.channels.push);
      const emailing = sent.filter((entry) => entry.channels.email);
      await Promise.all([...upserted].map(([recipientId, records]) => publishInbox(recipientId, { upserted: records })));
      await Promise.all([
        ...pushing.map(({ recipientId, notice, inboxItem }) => attempt("publish notice", deps.publish(
          notificationEvent<NotificationSentEvent>(recipientId, "notification.sent", { notice, inbox: inboxItem !== null }),
        ))),
        pushing.length > 0 && attempt("schedule push", deps.push?.(pushing.map(({ recipientId, notice, inboxItem }) => ({
          recipientId,
          notice,
          revision: inboxItem?.revision ?? null,
        })))),
        emailing.length > 0 && attempt("queue email", deps.email?.(emailing.map(({ recipientId, notice, inboxItem }) => ({
          userId: recipientId,
          entry: { id: randomUUID(), notice, inbox: inboxItem !== null },
        })))),
      ]);
      return sent;
    },

    async markRead(recipientId: string, target: InboxReadTarget) {
      const readAt = new Date();
      const changed = await markInboxRead(deps.db, recipientId, target, readAt);
      const summary = await readInboxSummary(deps.db, recipientId);
      if (changed > 0) await publishInbox(recipientId, { read: { ...target, readAt: readAt.toISOString() } }, summary);
      return { changed, summary };
    },
  };
}

export type Notifier = ReturnType<typeof createNotifier>;
