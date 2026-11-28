import type { SessionTurnRecord } from "./model/session.js";

export const NOTIFICATION_CHANNELS = ["inbox", "push", "email"] as const;
export type NotificationChannel = (typeof NOTIFICATION_CHANNELS)[number];
export type NotificationChannelSettings = Record<NotificationChannel, boolean>;

export type NotificationPayloads = {
  mention: { spaceTitle: string | null; sessionTitle: string | null; preview: string | null };
  "turn.finished": {
    spaceTitle: string | null;
    sessionTitle: string | null;
    preview: string | null;
    status: SessionTurnRecord["status"];
    durationMs: number | null;
    stepCount: number | null;
  };
};
export type NotificationKind = keyof NotificationPayloads;

export const NOTIFICATION_DEFAULTS: Record<NotificationKind, NotificationChannelSettings> = {
  mention: { inbox: true, push: true, email: true },
  "turn.finished": { inbox: false, push: true, email: false },
};
export const NOTIFICATION_KINDS = Object.keys(NOTIFICATION_DEFAULTS) as NotificationKind[];

export const isNotificationKind = (value: unknown): value is NotificationKind =>
  typeof value === "string" && Object.hasOwn(NOTIFICATION_DEFAULTS, value);
export const isNotificationChannel = (value: unknown): value is NotificationChannel =>
  typeof value === "string" && (NOTIFICATION_CHANNELS as readonly string[]).includes(value);

export type NotificationActor = {
  userUuid: string;
  username: string | null;
  displayName: string;
  avatarUrl: string | null;
};

type NoticeOf<K extends NotificationKind> = {
  id: string;
  kind: K;
  groupKey: string;
  spaceId: string | null;
  sessionId: string | null;
  turnId: string | null;
  actors: NotificationActor[];
  payload: NotificationPayloads[K];
  createdAt: string;
};
export type Notice = { [K in NotificationKind]: NoticeOf<K> }[NotificationKind];

export type InboxItem = Notice & {
  count: number;
  revision: number;
  readAt: string | null;
  updatedAt: string;
};

export const INBOX_UNREAD_CAP = 99;

export type InboxSummary = { unread: number };

export type InboxReadTarget =
  | { ids: string[] }
  | { sessionId: string }
  | { all: true };

export type InboxListResponse = {
  items: InboxItem[];
  pageInfo: { hasMore: boolean; nextCursor: string | null };
};

export type NotificationPreferences = {
  kinds: Record<NotificationKind, NotificationChannelSettings>;
};

export type NotificationPreferencesPatch = {
  kinds: Partial<Record<NotificationKind, Partial<NotificationChannelSettings>>>;
};

export const PUSH_TRANSPORTS = ["webpush", "fcm", "apns"] as const;
export type PushTransport = (typeof PUSH_TRANSPORTS)[number];
export const isPushTransport = (value: unknown): value is PushTransport =>
  typeof value === "string" && (PUSH_TRANSPORTS as readonly string[]).includes(value);

export type PushTargetInput = {
  deviceId: string;
  transport: PushTransport;
  token: string;
  keys?: { p256dh: string; auth: string };
  locale?: string | null;
};

export type NotificationConfig = {
  email: boolean;
  push: { webpush: { publicKey: string } | null; fcm: boolean; apns: boolean };
};

export type NotificationPushMessage = {
  id: string;
  subject: string | null;
  title: string;
  body: string;
  path: string;
  tag: string;
  unread: number;
};

export const notificationPath = (notice: Pick<Notice, "spaceId" | "sessionId">) =>
  notice.spaceId && notice.sessionId
    ? `/spaces/${notice.spaceId}/sessions/${notice.sessionId}`
    : notice.spaceId
      ? `/spaces/${notice.spaceId}`
      : "/spaces/inbox";

export const notificationTag = (notice: Pick<Notice, "groupKey">) => `notification:${notice.groupKey}`;

export const USER_MENTION_URI_PREFIX = "cohub://users/";
export const buildUserMentionMarkdown = (input: { userUuid: string; label: string }) =>
  `@[${input.label.replace(/[[\]\\]/g, "").replace(/\s+/g, " ").trim() || "user"}](${USER_MENTION_URI_PREFIX}${input.userUuid})`;

export const NOTIFICATION_TURN_JOB = "notifications.turn";
export type NotificationTurnJobData = {
  turnId: string;
  event: "written" | "settled";
  trace?: Record<string, unknown>;
};
export const NOTIFICATION_PUSH_JOB = "notifications.push";
export type NotificationPushJobData = {
  recipientId: string;
  notice: Notice;
  revision: number | null;
  targetIds?: string[];
  attempt?: number;
};
export const NOTIFICATION_EMAIL_JOB = "notifications.email";
export type NotificationEmailJobData = { userId: string };
export type NotificationEmailEntry = { id: string; notice: Notice; inbox: boolean };

export const visibleDevicesKey = (userId: string) => `notifications:visible-devices:${userId}`;
export const VISIBLE_DEVICE_TTL_MS = 60_000;
export const visibleDeviceIds = (entries: Record<string, string>, now = Date.now()) =>
  new Set(Object.entries(entries).flatMap(([field, expiresAt]) =>
    Number(expiresAt) > now ? [field.slice(0, field.lastIndexOf(":"))] : []));

export function isWebPushEndpoint(value: string) {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  const host = url.hostname.toLowerCase();
  return url.protocol === "https:" && !url.port && (
    host === "fcm.googleapis.com" ||
    host === "web.push.apple.com" ||
    host.endsWith(".push.apple.com") ||
    host.endsWith(".push.services.mozilla.com") ||
    host.endsWith(".notify.windows.com")
  );
}
