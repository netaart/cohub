import type { NotificationConfig } from "@cohub/protocol";
import { readPushConfig } from "./push.js";

export * from "./email.js";
export * from "./push.js";

export function readNotificationConfig(env: NodeJS.ProcessEnv = process.env): NotificationConfig {
  const push = readPushConfig(env);
  return {
    email: Boolean(env.EMAIL_URL?.trim() && env.EMAIL_FROM?.trim()),
    push: {
      webpush: push.webPush ? { publicKey: push.webPush.publicKey } : null,
      fcm: Boolean(push.fcmServiceAccount),
      apns: false,
    },
  };
}
