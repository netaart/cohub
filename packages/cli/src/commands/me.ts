import type { Command } from "commander";
import { createClient } from "../client.js";
import { formatLocalDateTime, handleHttp, json as outJson, jsonRequested, ok, error, table } from "../output.js";
import { SESSION_STATUS_COLUMN } from "../session-status.js";

function parseInteger(value: string, name: string, min: number): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed) || parsed < min) {
    process.stderr.write(`\n  ✗ Invalid ${name}\n    ${name} must be an integer ≥ ${min}\n\n`);
    process.exit(1);
  }
  return parsed;
}

function parseSwitch(value: string, name: string): boolean {
  if (value === "on") return true;
  if (value === "off") return false;
  return error(`Invalid --${name}`, "Use on or off");
}

export function registerMe(program: Command): void {
  const meCmd = program.command("me").description("Account-level data across your spaces");

  meCmd
    .command("sessions")
    .alias("list-sessions")
    .description("List sessions you created across all spaces")
    .option("--limit <n>", "Maximum number of sessions (default 20)")
    .option("--cursor <cursor>", "Pagination cursor from a previous result")
    .option("--json", "Output as JSON")
    .action(async (opts: { limit?: string; cursor?: string; json?: boolean }) => {
      const client = createClient();
      try {
        const result = await client.user.listSessions({
          limit: opts.limit ? parseInteger(opts.limit, "limit", 1) : undefined,
          cursor: opts.cursor ?? null,
        });
        if (jsonRequested(opts)) return outJson(result);
        if (result.sessions.length === 0) {
          console.log("  (empty)");
          return;
        }
        table(result.sessions, [
          { key: "id", label: "ID" },
          { key: "spaceId", label: "Space" },
          { key: "title", label: "Title" },
          SESSION_STATUS_COLUMN,
          { key: "totalMessages", label: "Messages" },
          { key: "createdAt", label: "Created" },
        ]);
      } catch (e: unknown) {
        handleHttp(e);
      }
    });

  meCmd
    .command("activity")
    .description("Show your activity across all spaces")
    .option("--days <n>", "Show the last N days (default: 30)")
    .option("--from <date>", "Start at this ISO 8601 date")
    .option("--to <date>", "Stop before this ISO 8601 date")
    .option("--json", "Output as JSON")
    .addHelpText("after", "\nExamples:\n  $ cohub me activity --days 7\n  $ cohub me activity --from 2026-01-01 --to 2026-02-01")
    .action(async (opts: { days?: string; from?: string; to?: string; json?: boolean }) => {
      if (opts.days && (opts.from || opts.to)) {
        process.stderr.write("\n  ✗ Invalid range\n    --days cannot be combined with --from or --to\n\n");
        process.exitCode = 1;
        return;
      }
      if (opts.to && !opts.from) {
        process.stderr.write("\n  ✗ Invalid range\n    --from is required when --to is provided\n\n");
        process.exitCode = 1;
        return;
      }

      const client = createClient();
      try {
        const activity = await client.user.getActivity({
          days: opts.days ? parseInteger(opts.days, "days", 1) : undefined,
          from: opts.from,
          to: opts.to,
        });
        if (jsonRequested(opts)) return outJson(activity);
        console.log(`\n  ${formatLocalDateTime(activity.range.from)} → ${formatLocalDateTime(activity.range.to)}`);
        table([activity.totals], [
          { key: "totalTokens", label: "Tokens" },
          { key: "costTotal", label: "Cost ($)" },
          { key: "requestCount", label: "Requests" },
          { key: "successCount", label: "Success" },
          { key: "errorCount", label: "Errors" },
        ]);
      } catch (e: unknown) {
        handleHttp(e);
      }
    });

  const notificationsCmd = meCmd
    .command("notifications")
    .description("Completion popups for scheduled prompts, hooks, and background tasks");

  notificationsCmd
    .command("get")
    .description("Show when successful completions notify you")
    .option("--json", "Output as JSON")
    .action(async (opts: { json?: boolean }) => {
      const client = createClient();
      try {
        const { preferences } = await client.user.getPreferences();
        if (jsonRequested(opts)) return outJson(preferences);
        const { success, cronJobs } = preferences.notifications;
        table(Object.entries(success).map(([source, enabled]) => ({ source, notify: enabled ? "on" : "off" })), [
          { key: "source", label: "Source" },
          { key: "notify", label: "Notify on success" },
        ]);
        const overrides = Object.entries(cronJobs);
        if (overrides.length) {
          console.log("");
          table(overrides.map(([id, enabled]) => ({ id, notify: enabled ? "on" : "off" })), [
            { key: "id", label: "Scheduled task" },
            { key: "notify", label: "Notify on success" },
          ]);
        }
        console.log("\n  Failed and interrupted runs always notify.");
      } catch (e: unknown) {
        handleHttp(e);
      }
    });

  notificationsCmd
    .command("set")
    .description("Turn success notifications on or off per source")
    .option("--scheduled <on|off>", "Scheduled prompts")
    .option("--hook <on|off>", "Space hooks")
    .option("--background <on|off>", "Background tasks")
    .addHelpText("after", "\nPer-task settings override these; see `cohub cron-jobs notify`.\n\nExample:\n  $ cohub me notifications set --scheduled off")
    .action(async (opts: { scheduled?: string; hook?: string; background?: string }) => {
      const success: Partial<Record<"scheduled" | "hook" | "background", boolean>> = {};
      if (opts.scheduled !== undefined) success.scheduled = parseSwitch(opts.scheduled, "scheduled");
      if (opts.hook !== undefined) success.hook = parseSwitch(opts.hook, "hook");
      if (opts.background !== undefined) success.background = parseSwitch(opts.background, "background");
      if (Object.keys(success).length === 0) error("No changes provided", "Use --scheduled, --hook, or --background");
      const client = createClient();
      try {
        await client.user.updatePreferences({ notifications: { success } });
        ok("Notification settings updated");
      } catch (e: unknown) {
        handleHttp(e);
      }
    });
}
