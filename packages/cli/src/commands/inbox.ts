import { notificationPath, type InboxItem, type InboxReadTarget } from "@neta-art/cohub";
import type { Command } from "commander";
import { createClient } from "../client.js";
import { error, formatLocalDateTime, handleHttp, json as outJson, jsonRequested, ok, table } from "../output.js";
import { webUrl } from "../web.js";

function describe(item: InboxItem) {
  const actor = item.actors[0]?.displayName ?? "Someone";
  const where = item.payload.sessionTitle || item.payload.spaceTitle || "";
  const repeated = item.count > 1 ? ` (${item.count}×)` : "";
  switch (item.kind) {
    case "mention":
      return `${actor} mentioned you${where ? ` in ${where}` : ""}${repeated}`;
    case "turn.finished":
      return `${where || "Your task"} ${item.payload.status === "failed" ? "failed" : "finished"}${repeated}`;
  }
}

export function registerInbox(program: Command): void {
  const cmd = program.command("inbox").description("Notifications kept for you to read later");

  cmd
    .command("list", { isDefault: true })
    .description("List inbox items, newest first")
    .option("--unread", "Only unread items")
    .option("--limit <n>", "Maximum number of items (default 30)")
    .option("--cursor <cursor>", "Pagination cursor from a previous result")
    .option("--json", "Output as JSON")
    .action(async (opts: { unread?: boolean; limit?: string; cursor?: string; json?: boolean }) => {
      const limit = opts.limit ? Number.parseInt(opts.limit, 10) : undefined;
      if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 1)) error("Invalid limit", "limit must be an integer ≥ 1");
      const client = createClient();
      try {
        const page = await client.inbox.list({ unread: opts.unread, cursor: opts.cursor ?? null, limit });
        if (jsonRequested(opts)) return outJson(page);
        table(page.items.map((item) => ({
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
        if (page.pageInfo.nextCursor) {
          console.log(`\n  More: cohub inbox list${opts.unread ? " --unread" : ""} --cursor '${page.pageInfo.nextCursor}'\n`);
        }
      } catch (e: unknown) {
        handleHttp(e);
      }
    });

  cmd
    .command("read [ids...]")
    .description("Mark inbox items read: by id, by --session, or --all")
    .option("--session <sessionId>", "Every item about one session")
    .option("--all", "Everything")
    .option("--json", "Output as JSON")
    .action(async (ids: string[], opts: { session?: string; all?: boolean; json?: boolean }) => {
      const targets: InboxReadTarget[] = [
        ...(ids.length ? [{ ids }] : []),
        ...(opts.session ? [{ sessionId: opts.session }] : []),
        ...(opts.all ? [{ all: true as const }] : []),
      ];
      const [target] = targets;
      if (!target || targets.length > 1) error("Choose exactly one of: ids, --session, --all");
      const client = createClient();
      try {
        const result = await client.inbox.markRead(target);
        if (jsonRequested(opts)) return outJson(result);
        ok(`Marked ${result.changed} read · ${result.summary.unread} unread left`);
      } catch (e: unknown) {
        handleHttp(e);
      }
    });
}
