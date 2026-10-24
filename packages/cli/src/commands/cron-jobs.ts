import { readFileSync } from "node:fs";
import { Option, type Command } from "commander";
import { createClient } from "../client.js";
import { table, json as outJson, jsonRequested, ok, error, handleHttp } from "../output.js";

function readJsonObject(pathOrJson: string): Record<string, unknown> {
  const raw = pathOrJson.trim().startsWith("{") ? pathOrJson : readFileSync(pathOrJson, "utf8");
  const parsed = JSON.parse(raw) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) error("Invalid payload", "Expected a JSON object");
  return parsed as Record<string, unknown>;
}

export function registerCronJobs(program: Command): void {
  const cmd = program.command("cron-jobs").description("Scheduled jobs");

  cmd
    .command("ls [spaceId]")
    .alias("list")
    .description("List scheduled jobs")
    .option("--json", "Output as JSON")
    .action(async (spaceId: string | undefined, opts: { json?: boolean }) => {
      const client = createClient();
      try {
        const result = await client.cronJobs.list(spaceId);
        if (jsonRequested(opts)) return outJson(result);
        if (result.jobs.length === 0) return console.log("  (empty)");
        table(result.jobs, [
          { key: "id", label: "ID" },
          { key: "title", label: "Title" },
          { key: "taskType", label: "Type" },
          { key: "cronExpression", label: "Schedule" },
          { key: "enabled", label: "Enabled" },
          { key: "spaceId", label: "Space" },
        ]);
      } catch (e: unknown) {
        handleHttp(e);
      }
    });

  cmd
    .command("get <id>")
    .description("Show scheduled job")
    .option("--json", "Output as JSON")
    .action(async (id: string, opts: { json?: boolean }) => {
      const client = createClient();
      try {
        const result = await client.cronJobs.get(id);
        if (jsonRequested(opts)) return outJson(result);
        table([result.job], [
          { key: "id", label: "ID" },
          { key: "title", label: "Title" },
          { key: "taskType", label: "Type" },
          { key: "cronExpression", label: "Schedule" },
          { key: "timezone", label: "Timezone" },
          { key: "enabled", label: "Enabled" },
          { key: "spaceId", label: "Space" },
        ]);
      } catch (e: unknown) {
        handleHttp(e);
      }
    });

  cmd
    .command("update <id>")
    .description("Update scheduled job")
    .option("--title <title>", "Update title")
    .option("--cron <expression>", "Update cron expression")
    .option("--timezone <timezone>", "Update timezone")
    .option("--payload <jsonOrPath>", "Update payload from JSON string or file")
    .addOption(new Option("--notify-on-success <on|off>", "Notify when the scheduled prompt succeeds").choices(["on", "off"]))
    .option("--json", "Output as JSON")
    .action(async (id: string, opts: { title?: string; cron?: string; timezone?: string; payload?: string; notifyOnSuccess?: "on" | "off"; json?: boolean }) => {
      const client = createClient();
      try {
        const patch: Record<string, unknown> = {};
        if (opts.title !== undefined) patch.title = opts.title;
        if (opts.cron !== undefined) patch.cronExpression = opts.cron;
        if (opts.timezone !== undefined) patch.timezone = opts.timezone;
        if (opts.payload !== undefined) patch.payload = readJsonObject(opts.payload);
        if (opts.notifyOnSuccess !== undefined) patch.notifyOnSuccess = opts.notifyOnSuccess === "on";
        if (Object.keys(patch).length === 0) error("No changes provided", "Use --title, --cron, --timezone, --payload, or --notify-on-success");
        const result = await client.cronJobs.update(id, patch);
        if (jsonRequested(opts)) return outJson(result);
        ok(`Cron job updated: ${result.job.id}`);
      } catch (e: unknown) {
        if (e instanceof Error && /ENOENT|Unexpected token|JSON/.test(e.message)) {
          error("Invalid payload", e.message);
        }
        handleHttp(e);
      }
    });

  cmd
    .command("delete <id>")
    .description("Delete scheduled job")
    .action(async (id: string) => {
      const client = createClient();
      try {
        await client.cronJobs.delete(id);
        ok(`Cron job deleted: ${id}`);
      } catch (e: unknown) {
        handleHttp(e);
      }
    });

  cmd
    .command("toggle <id> <on|off>")
    .description("Enable or pause scheduled job")
    .action(async (id: string, state: string) => {
      if (state !== "on" && state !== "off") return error("Invalid state", "Use on or off");
      const enabled = state === "on";
      const client = createClient();
      try {
        await client.cronJobs.toggle(id, enabled);
        ok(`Cron job ${enabled ? "enabled" : "disabled"}: ${id}`);
      } catch (e: unknown) {
        handleHttp(e);
      }
    });

  cmd
    .command("runs <id>")
    .description("List scheduled job runs")
    .option("--limit <limit>", "Page size", "20")
    .option("--cursor <cursor>", "Pagination cursor")
    .option("--json", "Output as JSON")
    .action(async (id: string, opts: { limit?: string; cursor?: string; json?: boolean }) => {
      const client = createClient();
      const limit = Number(opts.limit ?? 20);
      try {
        const result = await client.cronJobs.runs(id, { limit: Number.isFinite(limit) ? limit : 20, cursor: opts.cursor });
        if (jsonRequested(opts)) return outJson(result);
        if (result.runs.length === 0) return console.log("  (empty)");
        table(result.runs, [
          { key: "id", label: "ID" },
          { key: "status", label: "Status" },
          { key: "scheduledAt", label: "Scheduled" },
          { key: "startedAt", label: "Started" },
          { key: "finishedAt", label: "Finished" },
        ]);
        if (result.pageInfo.hasMore && result.pageInfo.nextCursor) console.log(`\nNext cursor: ${result.pageInfo.nextCursor}`);
      } catch (e: unknown) {
        handleHttp(e);
      }
    });
}
