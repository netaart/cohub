import {
  isUuid,
  type ReferenceAggregateGroupBy,
  type ReferenceDirection,
  type ReferenceKind,
  type ReferenceQueryableType,
} from "@neta-art/cohub";
import type { Command } from "commander";
import { createClient } from "../client.js";
import { formatLocalDateTime, table, json as outJson, jsonRequested, error, handleHttp, type Row } from "../output.js";

const RESOURCE_TYPES = new Set<ReferenceQueryableType>([
  "turn",
  "session",
  "space",
  "checkpoint",
]);
const REFERENCE_KINDS = new Set<ReferenceKind>([
  "session_fork",
  "space_fork",
  "checkpoint_fork",
  "mod",
  "mention",
  "tool_call",
  "agent_tool_file_read",
  "agent_tool_file_write",
  "agent_tool_file_edit",
  "agent_tool_file_ls",
  "agent_tool_file_find",
  "agent_tool_file_grep",
]);
const DIRECTIONS = new Set<ReferenceDirection>(["out", "in", "both"]);
const GROUP_BYS = new Set<ReferenceAggregateGroupBy>(["kind", "targetType", "target", "sourceType", "day"]);

type QueryOpts = {
  direction?: string;
  kinds?: string;
  days?: string;
  limit?: string;
  json?: boolean;
};

type AggregateOpts = {
  groupBy?: string;
  kinds?: string;
  days?: string;
  limit?: string;
  json?: boolean;
};

function parseSource(value: string): { type: ReferenceQueryableType; id: string } {
  const idx = value.indexOf(":");
  if (idx <= 0) throw new Error("Source must be <type>:<id>, e.g. session:<uuid>");
  const type = value.slice(0, idx) as ReferenceQueryableType;
  const id = value.slice(idx + 1).trim();
  if (!RESOURCE_TYPES.has(type)) throw new Error(`Invalid resource type: ${type}`);
  if (!id) throw new Error("Missing resource id");
  return { type, id };
}

function parseKinds(value: string | undefined): ReferenceKind[] | undefined {
  const kinds = value?.split(",").map((k) => k.trim()).filter(Boolean);
  if (!kinds?.length) return undefined;
  const invalid = kinds.find((k) => !REFERENCE_KINDS.has(k as ReferenceKind));
  if (invalid) throw new Error(`Invalid reference kind: ${invalid}`);
  return [...new Set(kinds)] as ReferenceKind[];
}

function clampNumber(value: string | undefined, fallback: number, min: number, max: number): number {
  const parsed = Number(value ?? fallback);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(Math.floor(parsed), min), max);
}

const KINDS_HELP = `Kinds:
  structural:  session_fork, space_fork, checkpoint_fork, mod
  content:     mention, tool_call
  file access: agent_tool_file_read, agent_tool_file_write, agent_tool_file_edit,
               agent_tool_file_ls, agent_tool_file_find, agent_tool_file_grep`;

export function registerReferences(program: Command): void {
  const references = program
    .command("references")
    .description("Inspect resource references (forks, mentions, tool calls, mods, file access)")
    .addHelpText(
      "after",
      "\nAnalysis index for collaboration edges and file heat.\n",
    );

  references
    .command("query")
    .description("List references touching a resource")
    .argument("<source>", "turn:<uuid> | session:<uuid> | space:<uuid> | checkpoint:<uuid>")
    .option("--direction <dir>", "out | in | both", "both")
    .option("--kinds <kinds>", "Comma-separated kinds (see list below)")
    .option("--days <n>", "Only references seen within the last N days")
    .option("--limit <n>", "Maximum rows, 1-500", "200")
    .option("--json", "Output as JSON")
    .addHelpText("after", `

${KINDS_HELP}

Examples:
  cohub references query turn:<uuid> --kinds agent_tool_file_read,agent_tool_file_write
  cohub references query session:<uuid> --json
  cohub references query checkpoint:<uuid> --direction out
  cohub references query space:<uuid> --direction in --kinds mention,tool_call
  cohub references query space:<uuid> --kinds agent_tool_file_read --days 30
`)
    .action(async (source: string, opts: QueryOpts) => {
      const client = createClient();
      try {
        const ref = parseSource(source);
        const direction = (opts.direction ?? "both") as ReferenceDirection;
        if (!DIRECTIONS.has(direction)) return error(`Invalid direction: ${opts.direction}`);
        const kinds = parseKinds(opts.kinds);
        const days = opts.days ? clampNumber(opts.days, 30, 1, 365) : undefined;
        const limit = clampNumber(opts.limit, 200, 1, 500);
        const result = await client.references.query({
          source: `${ref.type}:${ref.id}`,
          direction,
          kinds,
          days,
          limit,
        });
        if (jsonRequested(opts)) return outJson(result);
        const rows: Row[] = result.references.map((r) => ({
          kind: r.kind,
          source: `${r.sourceType}:${r.sourceId.slice(0, 8)}`,
          target: formatTarget(r.targetType, r.targetId),
          count: r.count,
          lastSeen: formatLocalDateTime(r.updatedAt).slice(0, 10),
        }));
        table(rows, [
          { key: "kind", label: "Kind" },
          { key: "source", label: "Source" },
          { key: "target", label: "Target" },
          { key: "count", label: "Count" },
          { key: "lastSeen", label: "Last Seen" },
        ]);
      } catch (e: unknown) {
        if (e instanceof Error && (e.message.startsWith("Invalid") || e.message.startsWith("Source must") || e.message.startsWith("Missing"))) {
          return error(e.message);
        }
        handleHttp(e);
      }
    });

  references
    .command("aggregate")
    .description("Grouped reference counts for a space")
    .argument("<spaceId>", "Space id")
    .option("--group-by <field>", "kind | targetType | target | sourceType | day", "kind")
    .option("--kinds <kinds>", "Comma-separated kinds (see list below)")
    .option("--days <n>", "Only references seen within the last N days")
    .option("--limit <n>", "Maximum groups, 1-500", "200")
    .option("--json", "Output as JSON")
    .addHelpText("after", `

${KINDS_HELP}

Notes:
  --group-by target: file targets look like {spaceId}:{path}

Examples:
  cohub references aggregate <spaceId> --json
  cohub references aggregate <spaceId> --group-by targetType
  cohub references aggregate <spaceId> --group-by target --kinds agent_tool_file_read --limit 20
  cohub references aggregate <spaceId> --group-by day --days 30
`)
    .action(async (spaceId: string, opts: AggregateOpts) => {
      const client = createClient();
      try {
        if (!isUuid(spaceId.trim())) return error("Invalid space id");
        const groupBy = (opts.groupBy ?? "kind") as ReferenceAggregateGroupBy;
        if (!GROUP_BYS.has(groupBy)) return error(`Invalid group-by: ${opts.groupBy}`);
        const kinds = parseKinds(opts.kinds);
        const days = opts.days ? clampNumber(opts.days, 30, 1, 365) : undefined;
        const limit = clampNumber(opts.limit, 200, 1, 500);
        const result = await client.references.aggregate({ spaceId: spaceId.trim(), groupBy, kinds, days, limit });
        if (jsonRequested(opts)) return outJson(result);
        const rows: Row[] = result.groups.map((g) => ({
          group: g.group,
          references: g.references,
          total: g.total,
        }));
        table(rows, [
          { key: "group", label: "Group" },
          { key: "references", label: "References" },
          { key: "total", label: "Total" },
        ]);
      } catch (e: unknown) {
        if (e instanceof Error && e.message.startsWith("Invalid")) return error(e.message);
        handleHttp(e);
      }
    });
}

/**
 * Render a target for the table. File targets are `{spaceId}:{path}`; show the
 * short space id plus the full path rather than blindly truncating.
 */
function formatTarget(targetType: string, targetId: string): string {
  if (targetType === "file") {
    const idx = targetId.indexOf(":");
    if (idx > 0) return `file:${targetId.slice(0, 8)}…${targetId.slice(idx)}`;
    return `file:${targetId}`;
  }
  return `${targetType}:${targetId.slice(0, 8)}`;
}
