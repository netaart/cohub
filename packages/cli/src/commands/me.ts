import type { Command } from "commander";
import { createClient } from "../client.js";
import { formatLocalDateTime, handleHttp, json as outJson, jsonRequested, table } from "../output.js";

function parseInteger(value: string, name: string, min: number): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed) || parsed < min) {
    process.stderr.write(`\n  ✗ Invalid ${name}\n    ${name} must be an integer ≥ ${min}\n\n`);
    process.exit(1);
  }
  return parsed;
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
        table([activity.summary], [
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
}
