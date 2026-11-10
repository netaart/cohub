import type { BillingBalanceActivityFilter } from "@neta-art/cohub";
import type { Command } from "commander";
import { createClient } from "../client.js";
import { formatLocalDateTime, handleHttp, json as outJson, jsonRequested, table } from "../output.js";
import { SESSION_STATUS_COLUMN, sessionArchiveFilter } from "../session-status.js";

function parseInteger(value: string, name: string, min: number): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed) || parsed < min) {
    process.stderr.write(`\n  ✗ Invalid ${name}\n    ${name} must be an integer ≥ ${min}\n\n`);
    process.exit(1);
  }
  return parsed;
}

const usd = (value: number) => `${value < 0 ? "-" : ""}$${Math.abs(value).toFixed(2)}`;

export function registerMe(program: Command): void {
  const meCmd = program.command("me").description("Account-level data across your spaces");

  meCmd
    .command("sessions")
    .alias("list-sessions")
    .description("List sessions you created across all spaces (archived sessions are hidden by default)")
    .option("--limit <n>", "Maximum number of sessions (default 20)")
    .option("--cursor <cursor>", "Pagination cursor from a previous result")
    .option("--archived", "List only archived sessions")
    .option("--all", "Include archived sessions")
    .option("--json", "Output as JSON")
    .action(async (opts: { limit?: string; cursor?: string; archived?: boolean; all?: boolean; json?: boolean }) => {
      const client = createClient();
      try {
        const result = await client.user.listSessions({
          limit: opts.limit ? parseInteger(opts.limit, "limit", 1) : undefined,
          cursor: opts.cursor ?? null,
          archived: sessionArchiveFilter(opts),
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
    .command("billing")
    .description("Show your balance, current plan, and credits expiring soon")
    .option("--json", "Output as JSON")
    .action(async (opts: { json?: boolean }) => {
      const client = createClient();
      try {
        const [credits, { catalog }] = await Promise.all([client.billing.getCredits(), client.billing.getCatalog()]);
        const plan =
          catalog.currentSubscriptions.find((item) => item.status === "active" || item.status === "trialing") ??
          catalog.currentSubscriptions.find((item) => item.status === "past_due") ??
          null;
        if (jsonRequested(opts)) return outJson({ credits, plan });
        if (!catalog.billing.configured) {
          console.log("  Billing is not enabled on this server");
          return;
        }
        console.log(`  Balance   ${usd(credits.netUsd)}`);
        const period = plan?.currentPeriodEnd
          ? `, ${plan.cancelAtPeriodEnd ? "ends" : "renews"} ${formatLocalDateTime(plan.currentPeriodEnd)}`
          : "";
        console.log(`  Plan      ${plan ? `${plan.productName ?? plan.productKey} (${plan.status}${period})` : "Free"}`);
        for (const group of credits.groups) {
          if (group.key === "lt_7d" || group.key === "lt_30d") {
            console.log(`  Expiring  ${usd(group.remainingAmountUsd)} within ${group.key === "lt_7d" ? 7 : 30} days`);
          }
        }
      } catch (e: unknown) {
        handleHttp(e);
      }
    });

  meCmd
    .command("billing-activity")
    .description("List your personal wallet activity, newest first")
    .option("--filter <filter>", "Only show usage, grant, or refund activity")
    .option("--limit <n>", "Activities per page (default 50, max 100)")
    .option("--cursor <cursor>", "Pagination cursor from a previous result")
    .option("--json", "Output as JSON")
    .action(async (opts: { filter?: string; limit?: string; cursor?: string; json?: boolean }) => {
      if (opts.filter && !["usage", "grant", "refund"].includes(opts.filter)) {
        process.stderr.write("\n  ✗ Invalid filter\n    filter must be usage, grant, or refund\n\n");
        process.exit(1);
      }
      const client = createClient();
      try {
        const { activities } = await client.billing.getBalanceActivities({
          filter: opts.filter as BillingBalanceActivityFilter | undefined,
          limit: opts.limit ? parseInteger(opts.limit, "limit", 1) : undefined,
          cursor: opts.cursor ?? null,
        });
        if (jsonRequested(opts)) return outJson(activities);
        table(activities.items, [
          { key: "title", label: "Activity" },
          { key: "description", label: "Detail" },
          { key: "amountUsd", label: "Amount (USD)" },
          { key: "createdAt", label: "Date" },
        ]);
        if (activities.nextCursor) console.log(`\n  More: --cursor ${activities.nextCursor}`);
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
}
