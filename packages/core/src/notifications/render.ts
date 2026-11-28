import { notificationPath, type NotificationRecord } from "@cohub/protocol";

export type NotificationLocale = "en" | "zh-CN";

export const resolveNotificationLocale = (value: string | null | undefined): NotificationLocale =>
  value?.toLowerCase().startsWith("zh") ? "zh-CN" : "en";

const MESSAGES = {
  en: {
    someone: "Someone",
    mentioned: (actor: string) => `${actor} mentioned you`,
    mentionedIn: (where: string) => `in ${where}`,
    finished: (where: string) => `${where} finished`,
    failed: (where: string) => `${where} failed`,
    aSession: "Your task",
    digestSubject: (count: number) => count === 1 ? "1 new notification on Cohub" : `${count} new notifications on Cohub`,
    digestIntro: "Here is what you missed:",
    open: "Open Cohub",
    unsubscribe: "Unsubscribe from these emails",
    footer: "You receive this because email notifications are on for your Cohub account.",
  },
  "zh-CN": {
    someone: "有人",
    mentioned: (actor: string) => `${actor} 提到了你`,
    mentionedIn: (where: string) => `在「${where}」`,
    finished: (where: string) => `${where} 已完成`,
    failed: (where: string) => `${where} 运行失败`,
    aSession: "你的任务",
    digestSubject: (count: number) => `Cohub 有 ${count} 条新通知`,
    digestIntro: "你错过了这些消息：",
    open: "打开 Cohub",
    unsubscribe: "退订此类邮件",
    footer: "你收到这封邮件，是因为你的 Cohub 账号开启了邮件通知。",
  },
} as const;

export const notificationMessages = (locale: NotificationLocale) => MESSAGES[locale];

const clip = (text: string | null | undefined, max: number) => {
  const value = text?.replace(/\s+/g, " ").trim() ?? "";
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
};

export function renderNotification(record: NotificationRecord, locale: NotificationLocale) {
  const t = MESSAGES[locale];
  const where = record.payload.sessionTitle || record.payload.spaceTitle;
  switch (record.kind) {
    case "mention.user": {
      const actor = record.actors[0]?.displayName ?? t.someone;
      return {
        title: clip(t.mentioned(actor), 120),
        body: clip(record.payload.preview || (where ? t.mentionedIn(where) : ""), 240),
        path: notificationPath(record),
      };
    }
    case "turn.finished": {
      const subject = clip(where || t.aSession, 80);
      return {
        title: record.payload.status === "failed" ? t.failed(subject) : t.finished(subject),
        body: clip(record.payload.preview, 240),
        path: notificationPath(record),
      };
    }
  }
}
