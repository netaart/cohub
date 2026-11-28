import {
  isNotificationChannel,
  isNotificationKind,
  NOTIFICATION_CHANNELS,
  NOTIFICATION_KINDS,
  type NotificationPreferencesPatch,
} from "@neta-art/cohub";
import type { Command } from "commander";
import { createClient } from "../client.js";
import { error, handleHttp, json as outJson, jsonRequested, table } from "../output.js";

const CHANNEL_LABELS = { inbox: "Inbox", push: "Push", email: "Email" } as const;

export function registerNotifications(program: Command): void {
  const cmd = program.command("notifications").description("Where each kind of notification reaches you");

  cmd
    .command("prefs", { isDefault: true })
    .description("Show or change channels per kind, e.g. --set turn.finished.inbox=on")
    .option("--set <rules...>", `kind.channel=on|off; kinds: ${NOTIFICATION_KINDS.join(", ")}; channels: ${NOTIFICATION_CHANNELS.join(", ")}`)
    .option("--json", "Output as JSON")
    .action(async (opts: { set?: string[]; json?: boolean }) => {
      const patch: NotificationPreferencesPatch["kinds"] = {};
      for (const rule of opts.set ?? []) {
        const [, kind, channel, state] = /^([a-z.]+)\.([a-z]+)=(on|off)$/.exec(rule.trim()) ?? [];
        if (!isNotificationKind(kind) || !isNotificationChannel(channel)) {
          error(`Invalid rule: ${rule}`, "Use kind.channel=on|off, e.g. mention.email=off");
        }
        patch[kind] = { ...patch[kind], [channel]: state === "on" };
      }
      const client = createClient();
      try {
        const preferences = Object.keys(patch).length
          ? await client.notifications.updatePreferences({ kinds: patch })
          : await client.notifications.preferences();
        if (jsonRequested(opts)) return outJson(preferences);
        table(NOTIFICATION_KINDS.map((kind) => ({
          kind,
          ...Object.fromEntries(NOTIFICATION_CHANNELS.map((channel) => [channel, preferences.kinds[kind][channel] ? "on" : "off"])),
        })), [
          { key: "kind", label: "Kind" },
          ...NOTIFICATION_CHANNELS.map((channel) => ({ key: channel, label: CHANNEL_LABELS[channel] })),
        ]);
      } catch (e: unknown) {
        handleHttp(e);
      }
    });
}
