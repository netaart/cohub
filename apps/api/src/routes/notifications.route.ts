import { Hono } from "hono";
import { NOTIFICATION_CATEGORIES } from "@cohub/protocol";
import { updateNotificationPreferences, verifyUnsubscribeToken } from "@cohub/core/notifications";
import { readNotificationConfig } from "@cohub/infra/notifications";
import { config } from "../config.js";
import { db } from "../db/index.js";

const router = new Hono();
const notificationConfig = readNotificationConfig();

router.get("/config", (c) => {
  c.header("Cache-Control", "public, max-age=300");
  return c.json(notificationConfig);
});

router.post("/unsubscribe", async (c) => {
  const body = await c.req.json<{ token?: unknown }>().catch(() => null);
  const token = c.req.query("token") ?? (typeof body?.token === "string" ? body.token : "");
  const userId = token && config.appEncryptionKey ? verifyUnsubscribeToken(config.appEncryptionKey, token) : null;
  if (!userId) return c.json({ message: "invalid unsubscribe link" }, 400);
  await updateNotificationPreferences(db, userId, {
    categories: Object.fromEntries(NOTIFICATION_CATEGORIES.map((category) => [category, { email: false }])),
  });
  return c.json({ ok: true });
});

export default router;
