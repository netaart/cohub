import { createSign } from "node:crypto";
import webpush from "web-push";
import { isWebPushEndpoint, type NotificationPushMessage, type PushTransport } from "@cohub/protocol";

export type PushTarget = {
  transport: PushTransport;
  token: string;
  keys: { p256dh: string; auth: string } | null;
};

export type PushResult = "ok" | "gone" | "retry" | "error";

export type PushSender = (target: PushTarget, message: NotificationPushMessage) => Promise<PushResult>;

export type PushConfig = {
  webPush?: { publicKey: string; privateKey: string; subject: string } | null;
  fcmServiceAccount?: string | null;
};

const PUSH_TTL_SECONDS = 24 * 3600;
const REQUEST_TIMEOUT_MS = 10_000;

function createWebPushSender(config: NonNullable<PushConfig["webPush"]>): PushSender {
  const vapidDetails = { subject: config.subject, publicKey: config.publicKey, privateKey: config.privateKey };
  return async (target, message) => {
    if (!target.keys || !isWebPushEndpoint(target.token)) return "gone";
    try {
      await webpush.sendNotification(
        { endpoint: target.token, keys: target.keys },
        JSON.stringify(message),
        { vapidDetails, timeout: REQUEST_TIMEOUT_MS, TTL: PUSH_TTL_SECONDS, urgency: "high", topic: message.tag.replace(/[^A-Za-z0-9_-]/g, "").slice(-32) },
      );
      return "ok";
    } catch (error) {
      const status = (error as { statusCode?: number }).statusCode;
      if (status === 404 || status === 410) return "gone";
      if (status && status >= 400 && status < 500 && status !== 429) return "error";
      return "retry";
    }
  };
}

type ServiceAccount = { project_id: string; client_email: string; private_key: string };

function createFcmSender(raw: string): PushSender {
  const account = JSON.parse(raw.trim().startsWith("{") ? raw : Buffer.from(raw, "base64").toString("utf8")) as ServiceAccount;
  if (!account.project_id || !account.client_email || !account.private_key) throw new Error("FCM_SERVICE_ACCOUNT is not a service account");
  let token: { value: string; expiresAt: number } | null = null;

  const accessToken = async () => {
    if (token && token.expiresAt > Date.now() + 60_000) return token.value;
    const now = Math.floor(Date.now() / 1000);
    const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
    const unsigned = `${encode({ alg: "RS256", typ: "JWT" })}.${encode({
      iss: account.client_email,
      scope: "https://www.googleapis.com/auth/firebase.messaging",
      aud: "https://oauth2.googleapis.com/token",
      iat: now,
      exp: now + 3600,
    })}`;
    const signature = createSign("RSA-SHA256").update(unsigned).sign(account.private_key, "base64url");
    const response = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: `${unsigned}.${signature}` }),
    });
    if (!response.ok) throw new Error(`FCM token exchange failed (${response.status})`);
    const body = await response.json() as { access_token: string; expires_in: number };
    token = { value: body.access_token, expiresAt: Date.now() + body.expires_in * 1000 };
    return token.value;
  };

  const endpoint = `https://fcm.googleapis.com/v1/projects/${account.project_id}/messages:send`;
  return async (target, message) => {
    const response = await fetch(endpoint, {
      method: "POST",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      headers: { Authorization: `Bearer ${await accessToken()}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        message: {
          token: target.token,
          data: { id: message.id, subject: message.subject ?? "", title: message.title, body: message.body, path: message.path, tag: message.tag, unread: String(message.unread) },
          android: { priority: "high", ttl: `${PUSH_TTL_SECONDS}s` },
        },
      }),
    });
    if (response.ok) return "ok";
    if (response.status === 404) return "gone";
    if (response.status === 400) {
      const detail = await response.text().catch(() => "");
      return /UNREGISTERED|not a valid FCM registration token/.test(detail) ? "gone" : "error";
    }
    if (response.status === 401) {
      token = null;
      return "retry";
    }
    return response.status === 429 || response.status >= 500 ? "retry" : "error";
  };
}

export function createPushSenders(config: PushConfig): Partial<Record<PushTransport, PushSender>> {
  return {
    ...(config.webPush ? { webpush: createWebPushSender(config.webPush) } : {}),
    ...(config.fcmServiceAccount ? { fcm: createFcmSender(config.fcmServiceAccount) } : {}),
  };
}

export function readPushConfig(env: NodeJS.ProcessEnv = process.env): PushConfig {
  const publicKey = env.WEB_PUSH_VAPID_PUBLIC_KEY?.trim();
  const privateKey = env.WEB_PUSH_VAPID_PRIVATE_KEY?.trim();
  return {
    webPush: publicKey && privateKey
      ? { publicKey, privateKey, subject: env.WEB_PUSH_SUBJECT?.trim() || "mailto:notifications@cohub.live" }
      : null,
    fcmServiceAccount: env.FCM_SERVICE_ACCOUNT?.trim() || null,
  };
}
