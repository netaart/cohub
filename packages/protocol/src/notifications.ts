import type { SessionTurnRecord } from "./model/session.js";

export const NOTIFICATION_CATEGORIES = ["mention", "activity", "system"] as const;
export type NotificationCategory = (typeof NOTIFICATION_CATEGORIES)[number];

export const NOTIFICATION_CHANNELS = ["push", "email"] as const;
export type NotificationChannel = (typeof NOTIFICATION_CHANNELS)[number];
export type NotificationChannelSettings = Record<NotificationChannel, boolean>;

export const NOTIFICATION_CATEGORY_DEFAULTS: Record<NotificationCategory, NotificationChannelSettings> = {
  mention: { push: true, email: true },
  activity: { push: true, email: false },
  system: { push: false, email: false },
};

export type NotificationPayloads = {
  "mention.user": { spaceTitle: string | null; sessionTitle: string | null; preview: string | null };
  "turn.finished": {
    spaceTitle: string | null;
    sessionTitle: string | null;
    preview: string | null;
    status: SessionTurnRecord["status"];
    durationMs: number | null;
    stepCount: number | null;
  };
};

export const NOTIFICATION_KINDS = {
  "mention.user": { category: "mention" },
  "turn.finished": { category: "activity" },
} as const satisfies { [K in keyof NotificationPayloads]: { category: NotificationCategory } };
export type NotificationKind = keyof NotificationPayloads;

export const isNotificationKind = (value: unknown): value is NotificationKind =>
  typeof value === "string" && Object.hasOwn(NOTIFICATION_KINDS, value);
export const isNotificationCategory = (value: unknown): value is NotificationCategory =>
  typeof value === "string" && (NOTIFICATION_CATEGORIES as readonly string[]).includes(value);
export const notificationCategoryOf = (kind: NotificationKind): NotificationCategory =>
  NOTIFICATION_KINDS[kind].category;

export type NotificationActor = {
  userUuid: string;
  username: string | null;
  displayName: string;
  avatarUrl: string | null;
};

type NotificationRecordOf<K extends NotificationKind> = {
  id: string;
  kind: K;
  category: NotificationCategory;
  spaceId: string | null;
  sessionId: string | null;
  turnId: string | null;
  actors: NotificationActor[];
  payload: NotificationPayloads[K];
  count: number;
  revision: number;
  readAt: string | null;
  createdAt: string;
  updatedAt: string;
};
export type NotificationRecord = { [K in NotificationKind]: NotificationRecordOf<K> }[NotificationKind];

export const NOTIFICATION_UNREAD_CAP = 99;

export type NotificationSummary = {
  unread: number;
  byCategory: Record<NotificationCategory, number>;
};

export type NotificationReadTarget =
  | { ids: string[] }
  | { category: NotificationCategory }
  | { sessionId: string }
  | { all: true };

export type NotificationListResponse = {
  items: NotificationRecord[];
  pageInfo: { hasMore: boolean; nextCursor: string | null };
};

export type NotificationPreferences = {
  categories: Record<NotificationCategory, NotificationChannelSettings>;
};

export type NotificationPreferencesPatch = {
  categories: Partial<Record<NotificationCategory, Partial<NotificationChannelSettings>>>;
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

export const notificationPath = (record: Pick<NotificationRecord, "spaceId" | "sessionId">) =>
  record.spaceId && record.sessionId
    ? `/spaces/${record.spaceId}/sessions/${record.sessionId}`
    : record.spaceId
      ? `/spaces/${record.spaceId}`
      : "/spaces/inbox";

export const notificationTag = (id: string) => `notification:${id}`;

export const USER_MENTION_URI_PREFIX = "cohub://users/";
export const buildUserMentionMarkdown = (input: { userUuid: string; label: string }) =>
  `@[${input.label.replace(/[[\]\\]/g, "").replace(/\s+/g, " ").trim() || "user"}](${USER_MENTION_URI_PREFIX}${input.userUuid})`;

export const NOTIFICATION_TURN_JOB = "notifications.turn";
export type NotificationTurnJobData = {
  turnId: string;
  event: "written" | "settled";
  trace?: Record<string, unknown>;
};
export const NOTIFICATION_DELIVER_JOB = "notifications.deliver";
export type NotificationDeliverJobData = {
  notificationId: string;
  revision: number;
  targetIds?: string[];
  attempt?: number;
};
export const NOTIFICATION_EMAIL_JOB = "notifications.email";
export type NotificationEmailJobData = { userId: string };

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
