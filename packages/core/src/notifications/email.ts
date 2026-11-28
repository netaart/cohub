import { createHmac, timingSafeEqual } from "node:crypto";
import { eq } from "drizzle-orm";
import { userProfiles } from "@cohub/db";
import { isNotificationKind, type NotificationEmailEntry } from "@cohub/protocol";
import { type EmailOutbox, type EmailTransport, PermanentEmailError } from "@cohub/infra/notifications";
import { unreadInboxIds } from "./inbox.js";
import { notificationMessages, renderNotice, resolveNotificationLocale } from "./render.js";
import { readNotificationPreferences, type NotificationDb } from "./store.js";

const DIGEST_LIMIT = 20;

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
  outbox: Pick<EmailOutbox, "take" | "restore">;
  webOrigin: string;
  apiOrigin?: string | null;
  signingKey: string;
};

const escapeHtml = (value: string) => value.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);

async function pendingEntries(db: NotificationDb, userId: string, entries: readonly NotificationEmailEntry[]) {
  const latest = new Map<string, NotificationEmailEntry>();
  for (const entry of entries) {
    if (!isNotificationKind(entry.notice.kind)) continue;
    latest.delete(entry.notice.id);
    latest.set(entry.notice.id, entry);
  }
  const [prefs, unread] = await Promise.all([
    readNotificationPreferences(db, userId),
    unreadInboxIds(db, userId, [...latest.values()].flatMap((entry) => entry.inbox ? [entry.notice.id] : [])),
  ]);
  return [...latest.values()]
    .filter((entry) => prefs.kinds[entry.notice.kind].email && (!entry.inbox || unread.has(entry.notice.id)))
    .reverse();
}

export async function sendNotificationDigest(deps: EmailDeliveryDeps, userId: string): Promise<{ sent: number; more: boolean }> {
  const { entries, more } = await deps.outbox.take(userId, DIGEST_LIMIT);
  if (entries.length === 0) return { sent: 0, more };
  try {
    return { sent: await mailDigest(deps, userId, entries), more };
  } catch (error) {
    if (!(error instanceof PermanentEmailError && error.recipient)) await deps.outbox.restore(userId, entries);
    throw error;
  }
}

async function mailDigest(deps: EmailDeliveryDeps, userId: string, taken: readonly NotificationEmailEntry[]) {
  const [[profile], entries] = await Promise.all([
    deps.db.select({ email: userProfiles.email, locale: userProfiles.locale }).from(userProfiles).where(eq(userProfiles.userUuid, userId)).limit(1),
    pendingEntries(deps.db, userId, taken),
  ]);
  const [first] = entries;
  if (!profile?.email || !first) return 0;

  const locale = resolveNotificationLocale(profile.locale);
  const t = notificationMessages(locale);
  const items = entries.map(({ notice }) => {
    const rendered = renderNotice(notice, locale);
    return { ...rendered, url: new URL(rendered.path, deps.webOrigin).href };
  });
  const token = signUnsubscribeToken(deps.signingKey, userId);
  const unsubscribeUrl = new URL(`/settings/notifications?unsubscribe=${encodeURIComponent(token)}`, deps.webOrigin).href;
  const subject = items.length > 1 ? t.digestSubject(items.length) : (items[0]?.title ?? "");
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
    idempotencyKey: `notification-digest:${userId}:${first.id}`,
    headers: deps.apiOrigin
      ? {
        "List-Unsubscribe": `<${new URL(`/api/notifications/unsubscribe?token=${encodeURIComponent(token)}`, deps.apiOrigin).href}>`,
        "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
      }
      : undefined,
  });
  return entries.length;
}
