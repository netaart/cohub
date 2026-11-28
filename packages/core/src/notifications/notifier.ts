import { randomUUID } from "node:crypto";
import type { NotificationReadTarget, NotificationRecord, NotificationSummary } from "@cohub/protocol";
import { getRealtimeUserRoom, type NotificationChangedEvent } from "@cohub/protocol/realtime";
import {
  markNotificationsRead,
  readNotificationSummary,
  toNotificationRecords,
  upsertNotifications,
  type NotificationDb,
  type NotificationRow,
  type NotifyItem,
} from "./store.js";

export type NotifierDeps = {
  db: NotificationDb;
  publish: (event: NotificationChangedEvent) => Promise<unknown>;
  deliver?: (rows: readonly NotificationRow[]) => Promise<unknown>;
  logger?: Pick<Console, "warn">;
};

export const notificationChangedEvent = (
  recipientId: string,
  payload: NotificationChangedEvent["payload"],
): NotificationChangedEvent => ({
  id: randomUUID(),
  timestamp: Date.now(),
  domain: "notification",
  type: "notification.changed",
  rooms: [getRealtimeUserRoom(recipientId)],
  payload,
});

export function createNotifier(deps: NotifierDeps) {
  const logger = deps.logger ?? console;

  async function publishTo(recipientId: string, payload: Omit<NotificationChangedEvent["payload"], "summary">, summary?: NotificationSummary) {
    try {
      await deps.publish(notificationChangedEvent(recipientId, { ...payload, summary: summary ?? await readNotificationSummary(deps.db, recipientId) }));
    } catch (error) {
      logger.warn("[Notifications] failed to publish change", { recipientId, error });
    }
  }

  return {
    async notify(items: readonly NotifyItem[]): Promise<NotificationRecord[]> {
      const rows = await upsertNotifications(deps.db, items);
      if (rows.length === 0) return [];
      const records = await toNotificationRecords(deps.db, rows);
      const byRecipient = new Map<string, NotificationRecord[]>();
      rows.forEach((row, index) => {
        const record = records[index];
        if (!record) return;
        byRecipient.set(row.recipientId, [...(byRecipient.get(row.recipientId) ?? []), record]);
      });
      await Promise.all([...byRecipient].map(([recipientId, upserted]) => publishTo(recipientId, { upserted })));
      await deps.deliver?.(rows).catch((error) => logger.warn("[Notifications] failed to schedule delivery", { count: rows.length, error }));
      return records;
    },

    async markRead(recipientId: string, target: NotificationReadTarget) {
      const readAt = new Date();
      const changed = await markNotificationsRead(deps.db, recipientId, target, readAt);
      const summary = await readNotificationSummary(deps.db, recipientId);
      if (changed > 0) await publishTo(recipientId, { read: { ...target, readAt: readAt.toISOString() } }, summary);
      return { changed, summary };
    },
  };
}

export type Notifier = ReturnType<typeof createNotifier>;
