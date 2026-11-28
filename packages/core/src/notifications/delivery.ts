import { createHmac, timingSafeEqual } from "node:crypto";
import { and, asc, eq, gt, inArray, isNull, sql } from "drizzle-orm";
import { notifications, notificationUserState, pushTargets, userProfiles } from "@cohub/db";
import {
  NOTIFICATION_CATEGORIES,
  notificationTag,
  type NotificationCategory,
  type NotificationDeliverJobData,
  type PushTransport,
} from "@cohub/protocol";
import { type EmailTransport, PermanentEmailError, type PushResult, type PushSender } from "@cohub/infra/notifications";
import { notificationMessages, renderNotification, resolveNotificationLocale } from "./render.js";
import {
  listActivePushTargets,
  readNotificationPreferences,
  readNotificationSummary,
  toNotificationRecords,
  type NotificationDb,
} from "./store.js";

const MAX_PUSH_FAILURES = 10;
const DIGEST_LIMIT = 20;
const FIRST_DIGEST_WINDOW_MS = 24 * 3_600_000;

export type PushDeliveryDeps = {
  db: NotificationDb;
  senders: Partial<Record<PushTransport, PushSender>>;
  visibleDevices: (userId: string) => Promise<Set<string>>;
  scheduleEmail?: (userId: string) => Promise<unknown>;
  logger?: Pick<Console, "warn">;
};

export async function deliverNotification(deps: PushDeliveryDeps, job: NotificationDeliverJobData) {
  const [row] = await deps.db.select().from(notifications).where(eq(notifications.id, job.notificationId)).limit(1);
  if (!row || row.readAt || row.revision !== job.revision) return { pushed: 0, retryTargetIds: [] };
  const prefs = (await readNotificationPreferences(deps.db, row.recipientId)).categories[row.category];
  const firstTry = !job.targetIds;
  if (firstTry && prefs.email && deps.scheduleEmail) await deps.scheduleEmail(row.recipientId);
  if (!prefs.push) return { pushed: 0, retryTargetIds: [] };

  const [targets, visible] = await Promise.all([
    listActivePushTargets(deps.db, row.recipientId),
    deps.visibleDevices(row.recipientId),
  ]);
  const reachable = targets.filter((target) =>
    deps.senders[target.transport] && !visible.has(target.deviceId) && (firstTry || job.targetIds?.includes(target.id)));
  if (reachable.length === 0) return { pushed: 0, retryTargetIds: [] };

  const [[record], summary, [profile]] = await Promise.all([
    toNotificationRecords(deps.db, [row]),
    readNotificationSummary(deps.db, row.recipientId),
    deps.db.select({ locale: userProfiles.locale, subject: userProfiles.logtoUserId }).from(userProfiles).where(eq(userProfiles.userUuid, row.recipientId)).limit(1),
  ]);
  if (!record) return { pushed: 0, retryTargetIds: [] };
  const results = await Promise.all(reachable.map(async (target) => {
    const rendered = renderNotification(record, resolveNotificationLocale(target.locale ?? profile?.locale));
    const message = { id: row.id, subject: profile?.subject ?? null, ...rendered, tag: notificationTag(row.id), unread: summary.unread };
    const send = deps.senders[target.transport];
    const result: PushResult = send ? await send(target, message).catch(() => "retry" as const) : "error";
    return { target, result };
  }));
  const ids = (keep: (entry: (typeof results)[number]) => boolean) => results.filter(keep).map(({ target }) => target.id);
  const gone = ids(({ result, target }) => result === "gone" || (result === "retry" && target.failureCount + 1 >= MAX_PUSH_FAILURES));
  const failed = ids(({ result }) => result === "retry");
  const delivered = ids(({ result }) => result === "ok");
  const refused = results.filter(({ result }) => result === "error");
  if (refused.length > 0) deps.logger?.warn("[Notifications] push refused", { notificationId: row.id, transports: [...new Set(refused.map(({ target }) => target.transport))] });
  await Promise.all([
    gone.length > 0 && deps.db.update(pushTargets).set({ disabledAt: new Date() }).where(inArray(pushTargets.id, gone)),
    failed.length > 0 && deps.db.update(pushTargets).set({ failureCount: sql`${pushTargets.failureCount} + 1` }).where(inArray(pushTargets.id, failed)),
    delivered.length > 0 && deps.db.update(pushTargets).set({ failureCount: 0 }).where(and(inArray(pushTargets.id, delivered), gt(pushTargets.failureCount, 0))),
  ]);
  return { pushed: delivered.length, retryTargetIds: failed.filter((id) => !gone.includes(id)) };
}

const signature = (key: string, userId: string) => createHmac("sha256", key).update(`unsubscribe:${userId}`).digest("base64url");

export const signUnsubscribeToken = (key: string, userId: string) =>
  `${Buffer.from(userId).toString("base64url")}.${signature(key, userId)}`;

export function verifyUnsubscribeToken(key: string, token: string): string | null {
  const [encoded, mac] = token.split(".");
  if (!encoded || !mac) return null;
  const userId = Buffer.from(encoded, "base64url").toString("utf8");
  const expected = Buffer.from(signature(key, userId));
  const actual = Buffer.from(mac);
  return expected.length === actual.length && timingSafeEqual(expected, actual) ? userId : null;
}

export type EmailDeliveryDeps = {
  db: NotificationDb;
  email: EmailTransport;
  webOrigin: string;
  apiOrigin?: string | null;
  signingKey: string;
};

const escapeHtml = (value: string) => value.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);

export async function sendNotificationDigest(deps: EmailDeliveryDeps, userId: string): Promise<{ sent: number; more: boolean }> {
  const [[profile], [state], prefs] = await Promise.all([
    deps.db.select({ email: userProfiles.email, locale: userProfiles.locale }).from(userProfiles).where(eq(userProfiles.userUuid, userId)).limit(1),
    deps.db.select().from(notificationUserState).where(eq(notificationUserState.userId, userId)).limit(1),
    readNotificationPreferences(deps.db, userId),
  ]);
  if (!profile?.email) return { sent: 0, more: false };
  const categories = NOTIFICATION_CATEGORIES.filter((category) => prefs.categories[category].email) as NotificationCategory[];
  if (categories.length === 0) return { sent: 0, more: false };

  const after = (at: Date, id: string | null) => id
    ? sql`(${notifications.updatedAt}, ${notifications.id}) > (${at.toISOString()}::timestamptz, ${id}::uuid)`
    : gt(notifications.updatedAt, at);
  const pending = (at: Date, id: string | null) => and(
    eq(notifications.recipientId, userId),
    isNull(notifications.readAt),
    inArray(notifications.category, categories),
    after(at, id),
  );
  const batch = await deps.db.select().from(notifications)
    .where(state?.emailLastSentAt
      ? pending(state.emailLastSentAt, state.emailLastSentId)
      : pending(new Date(Date.now() - FIRST_DIGEST_WINDOW_MS), null))
    .orderBy(asc(notifications.updatedAt), asc(notifications.id))
    .limit(DIGEST_LIMIT);
  const last = batch.at(-1);
  if (!last) return { sent: 0, more: false };
  const rows = [...batch].reverse();
  const cursor = { emailLastSentAt: last.updatedAt, emailLastSentId: last.id };
  const advance = async () => {
    await deps.db.insert(notificationUserState).values({ userId, ...cursor })
      .onConflictDoUpdate({ target: notificationUserState.userId, set: { ...cursor, updatedAt: new Date() } });
    const [next] = await deps.db.select({ id: notifications.id }).from(notifications).where(pending(last.updatedAt, last.id)).limit(1);
    return Boolean(next);
  };

  const locale = resolveNotificationLocale(profile.locale);
  const t = notificationMessages(locale);
  const records = await toNotificationRecords(deps.db, rows);
  const items = records.map((record) => {
    const rendered = renderNotification(record, locale);
    return { ...rendered, url: new URL(rendered.path, deps.webOrigin).href };
  });
  const token = signUnsubscribeToken(deps.signingKey, userId);
  const unsubscribeUrl = new URL(`/settings/notifications?unsubscribe=${encodeURIComponent(token)}`, deps.webOrigin).href;
  const [first] = items;
  if (!first) return { sent: 0, more: await advance() };
  const subject = items.length === 1 ? first.title : t.digestSubject(items.length);
  const text = [
    t.digestIntro,
    "",
    ...items.flatMap((item) => [item.title, item.body, item.url, ""]),
    `${t.unsubscribe}: ${unsubscribeUrl}`,
  ].join("\n");
  const html = `<!doctype html><html><body style="margin:0;padding:24px;background:#f6f6f4;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#1f1f1e">
<div style="max-width:560px;margin:0 auto;background:#fff;border-radius:12px;padding:24px">
<p style="margin:0 0 16px;font-size:14px;color:#6b6b68">${escapeHtml(t.digestIntro)}</p>
${items.map((item) => `<a href="${escapeHtml(item.url)}" style="display:block;padding:12px 0;border-top:1px solid #eee;text-decoration:none;color:inherit">
<div style="font-size:15px;font-weight:600">${escapeHtml(item.title)}</div>${item.body ? `<div style="margin-top:4px;font-size:14px;color:#55554f">${escapeHtml(item.body)}</div>` : ""}</a>`).join("")}
<a href="${escapeHtml(deps.webOrigin)}/inbox" style="display:inline-block;margin-top:16px;padding:8px 14px;border-radius:8px;background:#ff4500;color:#fff;text-decoration:none;font-size:14px">${escapeHtml(t.open)}</a>
</div>
<p style="max-width:560px;margin:16px auto 0;font-size:12px;color:#8a8a85">${escapeHtml(t.footer)} <a href="${escapeHtml(unsubscribeUrl)}" style="color:#8a8a85">${escapeHtml(t.unsubscribe)}</a></p>
</body></html>`;

  await deps.email.send({
    to: profile.email,
    subject,
    text,
    html,
    idempotencyKey: `notification-digest:${userId}:${last.id}:${last.revision}`,
    headers: deps.apiOrigin
      ? {
        "List-Unsubscribe": `<${new URL(`/api/notifications/unsubscribe?token=${encodeURIComponent(token)}`, deps.apiOrigin).href}>`,
        "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
      }
      : undefined,
  }).catch(async (error) => {
    if (error instanceof PermanentEmailError && error.recipient) await advance();
    throw error;
  });
  return { sent: rows.length, more: await advance() };
}
