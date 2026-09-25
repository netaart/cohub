import { isUuid, type GlobalSearchResult, type GlobalSearchType } from "@neta-art/cohub";
import type { Command } from "commander";
import { createClient } from "../client.js";
import { formatLocalDateTime, table, json as outJson, jsonRequested, error, handleHttp, truncateText, type Row } from "../output.js";

const DEFAULT_LIMIT = 20;
const MAX_TITLE_LENGTH = 72;
const MAX_CONTEXT_LENGTH = 42;

const SEARCH_TYPES = new Set<GlobalSearchType>(["turn", "session", "space", "label"]);

type SearchCliOptions = {
  limit?: string;
  types?: string;
  spaceId?: string;
  labelRef?: string;
  json?: boolean;
};

function clampLimit(value: string | undefined): number {
  const parsed = Number(value ?? DEFAULT_LIMIT);
  if (!Number.isFinite(parsed)) return DEFAULT_LIMIT;
  return Math.min(Math.max(Math.floor(parsed), 1), 50);
}

function contextFor(item: GlobalSearchResult): string {
  const owner = item.ownerProfile;
  if (owner?.username) return `@${owner.username}`;
  if (owner?.displayName) return owner.displayName;
  return item.href;
}

function parseTypes(value: string | undefined): GlobalSearchType[] | undefined {
  const types = value
    ?.split(",")
    .map((type) => type.trim())
    .filter(Boolean);
  if (!types?.length) return undefined;
  const invalidType = types.find((type) => !SEARCH_TYPES.has(type as GlobalSearchType));
  if (invalidType) throw new Error(`Invalid search type: ${invalidType}`);
  return [...new Set(types)] as GlobalSearchType[];
}

function parseSearchInput(opts: SearchCliOptions) {
  const types = parseTypes(opts.types);
  const spaceId = opts.spaceId?.trim();
  if (spaceId && !isUuid(spaceId)) throw new Error("Invalid space id");
  return { types, spaceId: spaceId || undefined, labelRef: opts.labelRef?.trim() || undefined };
}

function rowsFor(items: GlobalSearchResult[]): Row[] {
  return items.map((item) => ({
    type: item.type,
    title: truncateText(item.title, MAX_TITLE_LENGTH),
    context: truncateText(contextFor(item), MAX_CONTEXT_LENGTH),
    match: item.matchedField,
    updated: item.updatedAt ? formatLocalDateTime(item.updatedAt).slice(0, 10) : "",
    href: item.href,
  }));
}

export function registerSearch(program: Command): void {
  program
    .command("search")
    .description("Search spaces, chats, turns, and label items")
    .argument("[query]", "Search query")
    .option("--limit <n>", "Maximum results, 1-50", String(DEFAULT_LIMIT))
    .option("--types <types>", "Comma-separated result types: turn,session,space,label")
    .option("--space-id <id>", "Limit search to a space")
    .option("--label-ref <ref>", "Search items under an exact label ref")
    .option("--json", "Output as JSON")
    .addHelpText("after", `

Examples:
  cohub search "release notes"
  cohub search "failing tests" --limit 10
  cohub search "bug" --types turn,session --space-id <spaceId>
  cohub search --types label --label-ref bug
  cohub search "login" --types label --label-ref bug
  cohub search "design review" --json
`)
    .action(async (query: string | undefined, opts: SearchCliOptions) => {
      const client = createClient();
      try {
        const input = parseSearchInput(opts);
        const q = query ?? "";
        if (!q.trim() && !input.labelRef) return error("Search query is required unless --label-ref is provided.");
        const result = await client.search.query({
          q,
          limit: clampLimit(opts.limit),
          types: input.types,
          spaceId: input.spaceId,
          labelRef: input.labelRef,
        });
        if (jsonRequested(opts)) return outJson(result);

        if (result.degraded) {
          process.stderr.write("  Search is temporarily degraded; results may be incomplete.\n");
        }

        table(rowsFor(result.items), [
          { key: "type", label: "Type" },
          { key: "title", label: "Title" },
          { key: "context", label: "Context" },
          { key: "match", label: "Match" },
          { key: "updated", label: "Updated" },
          { key: "href", label: "Href" },
        ]);
      } catch (e: unknown) {
        if (e instanceof Error && (e.message === "Invalid space id" || e.message.startsWith("Invalid search type:"))) {
          return error(e.message);
        }
        handleHttp(e);
      }
    });
}
