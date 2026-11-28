import { Hono, type Context } from "hono";
import {
  InvalidNotificationCursorError,
  listNotifications,
  parseNotificationPreferencesPatch,
  parseNotificationReadTarget,
  readNotificationPreferences,
  readNotificationSummary,
  registerPushTarget,
  toNotificationRecords,
  unregisterPushTarget,
  updateNotificationPreferences,
} from "@cohub/core/notifications";
import { isNotificationCategory, isPushTransport, isWebPushEndpoint, type NotificationCategory, type NotificationListResponse, type PushTargetInput } from "@cohub/protocol";
import { userProfiles } from "@cohub/db";
import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import type { AuthUser, RequestPrincipal } from "../lib/middleware.js";
import { notifier } from "../notifications.js";

const router = new Hono();
const PAGE_SIZE = 30;
const MAX_PAGE_SIZE = 100;
const DEVICE_ID = /^[A-Za-z0-9_-]{8,64}$/;
const LOCALE = /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/;

function inboxOwner(c: Context): AuthUser | Response {
  const principal = c.get("principal") as RequestPrincipal | null | undefined;
  if (principal?.type === "user") return principal.user;
  return principal ? c.json({ message: "forbidden" }, 403) : c.json({ message: "unauthorized" }, 401);
}

router.get("/notifications", async (c) => {
  const user = inboxOwner(c);
  if (user instanceof Response) return user;
  const rawCategory = c.req.query("category") || null;
  if (rawCategory && !isNotificationCategory(rawCategory)) return c.json({ message: "invalid category" }, 400);
  const category = rawCategory as NotificationCategory | null;
  const limit = Math.min(Math.max(Number(c.req.query("limit") ?? PAGE_SIZE) || PAGE_SIZE, 1), MAX_PAGE_SIZE);
  try {
    const page = await listNotifications(db, user.uuid, { category, cursor: c.req.query("cursor") ?? null, limit });
    const response: NotificationListResponse = {
      items: await toNotificationRecords(db, page.items),
      pageInfo: { hasMore: page.hasMore, nextCursor: page.nextCursor },
    };
    return c.json(response);
  } catch (error) {
    if (error instanceof InvalidNotificationCursorError) return c.json({ message: error.message }, 400);
    throw error;
  }
});

router.get("/notifications/summary", async (c) => {
  const user = inboxOwner(c);
  if (user instanceof Response) return user;
  return c.json(await readNotificationSummary(db, user.uuid));
});

router.post("/notifications/read", async (c) => {
  const user = inboxOwner(c);
  if (user instanceof Response) return user;
  const target = parseNotificationReadTarget(await c.req.json().catch(() => null));
  if (!target) return c.json({ message: "body must set exactly one of: ids, category, sessionId, all" }, 400);
  return c.json(await notifier.markRead(user.uuid, target));
});

router.get("/notification-preferences", async (c) => {
  const user = inboxOwner(c);
  if (user instanceof Response) return user;
  return c.json(await readNotificationPreferences(db, user.uuid));
});

router.patch("/notification-preferences", async (c) => {
  const user = inboxOwner(c);
  if (user instanceof Response) return user;
  const patch = parseNotificationPreferencesPatch(await c.req.json().catch(() => null));
  if (!patch) return c.json({ message: "categories must map categories to { push?, email? } booleans" }, 400);
  return c.json(await updateNotificationPreferences(db, user.uuid, patch));
});

function parsePushTarget(value: unknown): PushTargetInput | null {
  const body = value as Partial<PushTargetInput> | null;
  if (!body || typeof body.deviceId !== "string" || !DEVICE_ID.test(body.deviceId)) return null;
  if (!isPushTransport(body.transport) || typeof body.token !== "string" || !body.token || body.token.length > 4_096) return null;
  if (body.locale != null && (typeof body.locale !== "string" || !LOCALE.test(body.locale))) return null;
  const target = { deviceId: body.deviceId, transport: body.transport, token: body.token, locale: body.locale ?? null };
  if (body.transport !== "webpush") return target;
  const keys = body.keys;
  if (!isWebPushEndpoint(body.token) || typeof keys?.p256dh !== "string" || typeof keys.auth !== "string") return null;
  return { ...target, keys: { p256dh: keys.p256dh, auth: keys.auth } };
}

router.put("/push-targets", async (c) => {
  const user = inboxOwner(c);
  if (user instanceof Response) return user;
  const target = parsePushTarget(await c.req.json().catch(() => null));
  if (!target) return c.json({ message: "invalid push target" }, 400);
  await registerPushTarget(db, user.uuid, target);
  return c.json({ ok: true });
});

router.delete("/push-targets/:deviceId", async (c) => {
  const user = inboxOwner(c);
  if (user instanceof Response) return user;
  const deviceId = c.req.param("deviceId");
  if (!DEVICE_ID.test(deviceId)) return c.json({ message: "invalid deviceId" }, 400);
  await unregisterPushTarget(db, user.uuid, deviceId);
  return c.json({ ok: true });
});

router.put("/locale", async (c) => {
  const user = inboxOwner(c);
  if (user instanceof Response) return user;
  const body = await c.req.json<{ locale?: unknown }>().catch(() => null);
  if (typeof body?.locale !== "string" || !LOCALE.test(body.locale) || body.locale.length > 16) return c.json({ message: "invalid locale" }, 400);
  await db.update(userProfiles).set({ locale: body.locale }).where(eq(userProfiles.userUuid, user.uuid));
  return c.json({ ok: true });
});

export default router;
