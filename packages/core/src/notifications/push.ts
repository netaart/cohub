import { and, eq, gt, inArray, isNull, sql } from "drizzle-orm";
import { inboxItems, pushTargets, userProfiles } from "@cohub/db";
import { isNotificationKind, notificationTag, type NotificationPushJobData, type PushTargetInput, type PushTransport } from "@cohub/protocol";
import type { PushResult, PushSender } from "@cohub/infra/notifications";
import { readInboxSummary } from "./inbox.js";
import { renderNotice, resolveNotificationLocale } from "./render.js";
import { readNotificationPreferences, type NotificationDb } from "./store.js";

const MAX_PUSH_FAILURES = 10;

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

export type PushDeliveryDeps = {
  db: NotificationDb;
  senders: Partial<Record<PushTransport, PushSender>>;
  visibleDevices: (userId: string) => Promise<Set<string>>;
  logger?: Pick<Console, "warn">;
};

const NOTHING = { pushed: 0, retryTargetIds: [] as string[] };

async function stillPending(deps: PushDeliveryDeps, job: NotificationPushJobData, visible: Set<string>) {
  if (!isNotificationKind(job.notice.kind) || (job.revision === null && visible.size > 0)) return false;
  const preferences = await readNotificationPreferences(deps.db, job.recipientId);
  if (!preferences.kinds[job.notice.kind].push) return false;
  if (job.revision === null) return true;
  const [row] = await deps.db.select({ readAt: inboxItems.readAt, revision: inboxItems.revision })
    .from(inboxItems).where(eq(inboxItems.id, job.notice.id)).limit(1);
  return Boolean(row && !row.readAt && row.revision === job.revision);
}

export async function deliverPush(deps: PushDeliveryDeps, job: NotificationPushJobData) {
  const { recipientId, notice } = job;
  const [targets, visible] = await Promise.all([
    deps.db.select().from(pushTargets).where(and(eq(pushTargets.userId, recipientId), isNull(pushTargets.disabledAt))),
    deps.visibleDevices(recipientId),
  ]);
  const reachable = targets.filter((target) =>
    deps.senders[target.transport] && !visible.has(target.deviceId) && (!job.targetIds || job.targetIds.includes(target.id)));
  if (reachable.length === 0 || !(await stillPending(deps, job, visible))) return NOTHING;

  const [summary, [profile]] = await Promise.all([
    readInboxSummary(deps.db, recipientId),
    deps.db.select({ locale: userProfiles.locale, subject: userProfiles.logtoUserId }).from(userProfiles).where(eq(userProfiles.userUuid, recipientId)).limit(1),
  ]);
  const results = await Promise.all(reachable.map(async (target) => {
    const rendered = renderNotice(notice, resolveNotificationLocale(target.locale ?? profile?.locale));
    const message = { id: notice.id, subject: profile?.subject ?? null, ...rendered, tag: notificationTag(notice), unread: summary.unread };
    const send = deps.senders[target.transport];
    const result: PushResult = send ? await send(target, message).catch(() => "retry" as const) : "error";
    return { target, result };
  }));
  const ids = (keep: (entry: (typeof results)[number]) => boolean) => results.filter(keep).map(({ target }) => target.id);
  const gone = ids(({ result, target }) => result === "gone" || (result === "retry" && target.failureCount + 1 >= MAX_PUSH_FAILURES));
  const failed = ids(({ result }) => result === "retry");
  const delivered = ids(({ result }) => result === "ok");
  const refused = results.filter(({ result }) => result === "error");
  if (refused.length > 0) deps.logger?.warn("[Notifications] push refused", { noticeId: notice.id, transports: [...new Set(refused.map(({ target }) => target.transport))] });
  await Promise.all([
    gone.length > 0 && deps.db.update(pushTargets).set({ disabledAt: new Date() }).where(inArray(pushTargets.id, gone)),
    failed.length > 0 && deps.db.update(pushTargets).set({ failureCount: sql`${pushTargets.failureCount} + 1` }).where(inArray(pushTargets.id, failed)),
    delivered.length > 0 && deps.db.update(pushTargets).set({ failureCount: 0 }).where(and(inArray(pushTargets.id, delivered), gt(pushTargets.failureCount, 0))),
  ]);
  return { pushed: delivered.length, retryTargetIds: failed.filter((id) => !gone.includes(id)) };
}
