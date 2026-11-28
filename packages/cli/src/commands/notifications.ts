import {
  isNotificationCategory,
  NOTIFICATION_CATEGORIES,
  NOTIFICATION_CHANNELS,
  notificationPath,
  type NotificationCategory,
  type NotificationChannel,
  type NotificationReadTarget,
  type NotificationRecord,
} from "@neta-art/cohub";
import type { Command } from "commander";
import { createClient } from "../client.js";
import { error, formatLocalDateTime, handleHttp, json as outJson, jsonRequested, ok, table } from "../output.js";
import { webUrl } from "../web.js";

function parseCategory(value: string | undefined): NotificationCategory | null {
  if (!value) return null;
  if (!isNotificationCategory(value)) error(`Unknown category: ${value}`, `Use one of: ${NOTIFICATION_CATEGORIES.join(", ")}`);
  return value;
}

function describe(record: NotificationRecord) {
  const actor = record.actors[0]?.displayName ?? "Someone";
  const where = record.payload.sessionTitle || record.payload.spaceTitle || "";
  switch (record.kind) {
    case "mention.user":
      return `${actor} mentioned you${where ? ` in ${where}` : ""}`;
    case "turn.finished":
      return `${where || "Your task"} ${record.payload.status === "failed" ? "failed" : "finished"}${record.count > 1 ? ` (${record.count}×)` : ""}`;
  }
}

export function registerNotifications(program: Command): void {
  const cmd = program.command("notifications").description("Your inbox: mentions and finished tasks");

  cmd
    .command("list", { isDefault: true })
    .description("List notifications, newest first")
    .option("--category <category>", `Only one tab: ${NOTIFICATION_CATEGORIES.join(", ")}`)
    .option("--unread", "Only unread notifications")
    .option("--limit <n>", "Maximum number of notifications (default 30)")
    .option("--cursor <cursor>", "Pagination cursor from a previous result")
    .option("--json", "Output as JSON")
    .action(async (opts: { category?: string; unread?: boolean; limit?: string; cursor?: string; json?: boolean }) => {
      const client = createClient();
      try {
        const limit = opts.limit ? Number.parseInt(opts.limit, 10) : undefined;
        if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 1)) error("Invalid limit", "limit must be an integer ≥ 1");
        const page = await client.notifications.list({ category: parseCategory(opts.category), cursor: opts.cursor ?? null, limit });
        const items = opts.unread ? page.items.filter((item) => !item.readAt) : page.items;
        if (jsonRequested(opts)) return outJson({ ...page, items });
        table(items.map((item) => ({
          id: item.id,
          state: item.readAt ? "" : "●",
          what: describe(item),
          preview: item.payload.preview ?? "",
          when: formatLocalDateTime(item.updatedAt),
          link: webUrl(notificationPath(item)),
        })), [
          { key: "state", label: "" },
          { key: "id", label: "ID" },
          { key: "what", label: "Notification" },
          { key: "preview", label: "Preview" },
          { key: "when", label: "Updated" },
          { key: "link", label: "Open" },
        ]);
        if (page.pageInfo.nextCursor) console.log(`\n  More: cohub notifications list --cursor ${page.pageInfo.nextCursor}\n`);
      } catch (e: unknown) {
        handleHttp(e);
      }
    });

  cmd
    .command("read [ids...]")
    .description("Mark notifications read: by id, by --category, by --session, or --all")
    .option("--category <category>", "Every notification in one tab")
    .option("--session <sessionId>", "Every notification about one session")
    .option("--all", "Everything")
    .option("--json", "Output as JSON")
    .action(async (ids: string[], opts: { category?: string; session?: string; all?: boolean; json?: boolean }) => {
      const targets: NotificationReadTarget[] = [
        ...(ids.length ? [{ ids }] : []),
        ...(opts.category ? [{ category: parseCategory(opts.category) as NotificationCategory }] : []),
        ...(opts.session ? [{ sessionId: opts.session }] : []),
        ...(opts.all ? [{ all: true as const }] : []),
      ];
      const [target] = targets;
      if (!target || targets.length > 1) error("Choose exactly one of: ids, --category, --session, --all");
      const client = createClient();
      try {
        const result = await client.notifications.markRead(target);
        if (jsonRequested(opts)) return outJson(result);
        ok(`Marked ${result.changed} read · ${result.summary.unread} unread left`);
      } catch (e: unknown) {
        handleHttp(e);
      }
    });

  cmd
    .command("prefs")
    .description("Show or change where notifications reach you, e.g. --set mention.email=off")
    .option("--set <rules...>", `category.channel=on|off; categories: ${NOTIFICATION_CATEGORIES.join(", ")}; channels: ${NOTIFICATION_CHANNELS.join(", ")}`)
    .option("--json", "Output as JSON")
    .action(async (opts: { set?: string[]; json?: boolean }) => {
      const client = createClient();
      try {
        const patch: Partial<Record<NotificationCategory, Partial<Record<NotificationChannel, boolean>>>> = {};
        for (const rule of opts.set ?? []) {
          const match = /^([a-z]+)\.([a-z]+)=(on|off)$/.exec(rule.trim());
          const [, category, channel, state] = match ?? [];
          if (!category || !channel || !isNotificationCategory(category) || !(NOTIFICATION_CHANNELS as readonly string[]).includes(channel)) {
            error(`Invalid rule: ${rule}`, "Use category.channel=on|off, e.g. activity.push=off");
          }
          patch[category] = { ...patch[category], [channel]: state === "on" };
        }
        const preferences = Object.keys(patch).length
          ? await client.notifications.updatePreferences({ categories: patch })
          : await client.notifications.preferences();
        if (jsonRequested(opts)) return outJson(preferences);
        table(NOTIFICATION_CATEGORIES.map((category) => ({
          category,
          inbox: "on",
          ...Object.fromEntries(NOTIFICATION_CHANNELS.map((channel) => [channel, preferences.categories[category][channel] ? "on" : "off"])),
        })), [
          { key: "category", label: "Category" },
          { key: "inbox", label: "Inbox" },
          ...NOTIFICATION_CHANNELS.map((channel) => ({ key: channel, label: channel === "push" ? "Push" : "Email" })),
        ]);
      } catch (e: unknown) {
        handleHttp(e);
      }
    });
}
