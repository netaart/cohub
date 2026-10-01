import { and, desc, eq, gte, inArray, sql } from "drizzle-orm";
import { db } from "./db/index.js";
import * as schema from "@cohub/db";
import type { ReferenceKind, ReferenceResourceType } from "@cohub/db";

/** A resource selector like "turn:<id>" parsed into its parts. */
export type ResourceRef = {
  type: QueryableResourceType;
  id: string;
};

/**
 * Resource types usable as a query `source`: they resolve to an owning space to
 * authorize against. `turn` gives the finest precision (a single turn's edges);
 * session/space roll up via the denormalized ancestry columns. file/user appear
 * only as edge targets, never as a queryable source.
 */
export type QueryableResourceType = "turn" | "session" | "space" | "checkpoint";

const QUERYABLE_RESOURCE_TYPES: readonly QueryableResourceType[] = [
  "turn",
  "session",
  "space",
  "checkpoint",
];

const REFERENCE_KINDS: readonly ReferenceKind[] = [
  "session_fork",
  "space_fork",
  "checkpoint_fork",
  "mod",
  "mention",
  "tool_call",
  "turn_trigger",
  "agent_tool_file_read",
  "agent_tool_file_write",
  "agent_tool_file_edit",
  "agent_tool_file_ls",
  "agent_tool_file_find",
  "agent_tool_file_grep",
];

export type ReferenceDirection = "out" | "in" | "both";

/** Parse "type:id" into a validated resource ref, or null if malformed. */
export const parseResourceRef = (value: string | undefined | null): ResourceRef | null => {
  if (!value) return null;
  const idx = value.indexOf(":");
  if (idx <= 0) return null;
  const type = value.slice(0, idx) as QueryableResourceType;
  const id = value.slice(idx + 1).trim();
  if (!id || !QUERYABLE_RESOURCE_TYPES.includes(type)) return null;
  return { type, id };
};

/**
 * Parse a comma-separated list of kinds. Returns the valid kinds and any
 * unrecognized tokens so callers can reject bad input rather than silently
 * widening the query to all kinds.
 */
export const parseKinds = (
  value: string | undefined | null,
): { kinds: ReferenceKind[]; invalid: string[] } => {
  if (!value) return { kinds: [], invalid: [] };
  const kinds: ReferenceKind[] = [];
  const invalid: string[] = [];
  for (const raw of value.split(",")) {
    const part = raw.trim();
    if (!part) continue;
    if (REFERENCE_KINDS.includes(part as ReferenceKind)) kinds.push(part as ReferenceKind);
    else invalid.push(part);
  }
  return { kinds, invalid };
};

export const parseDirection = (value: string | undefined | null): ReferenceDirection =>
  value === "in" || value === "both" ? value : value === "out" ? "out" : "both";

export type ReferenceRow = {
  kind: ReferenceKind;
  sourceType: ReferenceResourceType;
  sourceId: string;
  targetType: ReferenceResourceType;
  targetId: string;
  sourceSpaceId: string;
  sourceSessionId: string | null;
  count: number;
  createdAt: Date;
  updatedAt: Date;
  meta: Record<string, unknown> | null;
};

const REFERENCE_COLUMNS = {
  kind: schema.resourceReferences.kind,
  sourceType: schema.resourceReferences.sourceType,
  sourceId: schema.resourceReferences.sourceId,
  targetType: schema.resourceReferences.targetType,
  targetId: schema.resourceReferences.targetId,
  sourceSpaceId: schema.resourceReferences.sourceSpaceId,
  sourceSessionId: schema.resourceReferences.sourceSessionId,
  count: schema.resourceReferences.count,
  createdAt: schema.resourceReferences.createdAt,
  updatedAt: schema.resourceReferences.updatedAt,
  meta: schema.resourceReferences.meta,
} as const;

/**
 * Match a resource as the *source* of an edge. `turn`/`checkpoint` pin the exact
 * source endpoint; `session`/`space` roll up every edge under that ancestry via
 * the denormalized columns, so one query serves all three granularities.
 */
const outgoingWhere = (ref: ResourceRef) => {
  switch (ref.type) {
    case "turn":
      return and(
        eq(schema.resourceReferences.sourceType, "turn"),
        eq(schema.resourceReferences.sourceId, ref.id),
      );
    case "session":
      return eq(schema.resourceReferences.sourceSessionId, ref.id);
    case "space":
      return eq(schema.resourceReferences.sourceSpaceId, ref.id);
    case "checkpoint":
      return and(
        eq(schema.resourceReferences.sourceType, "checkpoint"),
        eq(schema.resourceReferences.sourceId, ref.id),
      );
  }
};

/** Match a resource as the *target* of an edge ("who references me"). */
const incomingWhere = (ref: ResourceRef) =>
  and(
    eq(schema.resourceReferences.targetType, ref.type),
    eq(schema.resourceReferences.targetId, ref.id),
  );

/**
 * List reference edges touching a resource. Direction selects whether the
 * resource is the source ("out": what it references), the target ("in": what
 * references it), or both. Neutral by design: callers assemble graphs, lists,
 * rankings, or file-heat views from the returned rows.
 *
 * All edges are recorded in full, including self-references (e.g. a turn whose
 * tool call targets its own space). Consumers that render collaboration graphs
 * should drop self-loops client-side by comparing each row's target against its
 * `sourceSpaceId` / `sourceSessionId`.
 */
export const queryReferences = async (input: {
  ref: ResourceRef;
  direction: ReferenceDirection;
  kinds?: ReferenceKind[];
  since?: Date | null;
  limit: number;
  /**
   * Gate for incoming references, which originate in other spaces. Return the
   * subset of candidate space ids the caller may view, so "who references me"
   * never leaks source ids from private spaces. Implemented as a *batch* so a
   * single query can authorize hundreds of source spaces without fanning out
   * into N membership lookups. Outgoing references share the authorized
   * resource's own space and are always allowed.
   */
  canViewSpaces?: (spaceIds: readonly string[]) => Promise<ReadonlySet<string>>;
}): Promise<ReferenceRow[]> => {
  const { ref, direction, kinds, since, limit, canViewSpaces } = input;
  const kindFilter = kinds && kinds.length > 0 ? inArray(schema.resourceReferences.kind, kinds) : undefined;
  const sinceFilter = since ? gte(schema.resourceReferences.updatedAt, since) : undefined;

  const runQuery = (where: ReturnType<typeof and>) =>
    db
      .select(REFERENCE_COLUMNS)
      .from(schema.resourceReferences)
      .where(where)
      .orderBy(desc(schema.resourceReferences.updatedAt))
      .limit(limit);

  // Incoming references come from other spaces, so filter them by visibility
  // in one batch rather than one authz call per distinct source space.
  const filterVisible = async (rows: ReferenceRow[]): Promise<ReferenceRow[]> => {
    if (!canViewSpaces) return rows;
    const distinct = [...new Set(rows.map((row) => row.sourceSpaceId))];
    if (distinct.length === 0) return rows;
    const allowed = await canViewSpaces(distinct);
    return rows.filter((row) => allowed.has(row.sourceSpaceId));
  };

  const outWhere = and(outgoingWhere(ref), kindFilter, sinceFilter);
  const inWhere = and(incomingWhere(ref), kindFilter, sinceFilter);

  if (direction === "out") return runQuery(outWhere) as Promise<ReferenceRow[]>;
  if (direction === "in") return filterVisible((await runQuery(inWhere)) as ReferenceRow[]);

  const [out, incomingRaw] = await Promise.all([runQuery(outWhere), runQuery(inWhere)]);
  const incoming = await filterVisible(incomingRaw as ReferenceRow[]);
  // Merge, de-dupe by edge identity, keep most recent first, cap at limit.
  const seen = new Set<string>();
  const merged: ReferenceRow[] = [];
  for (const row of [...(out as ReferenceRow[]), ...incoming]) {
    const key = `${row.kind}|${row.sourceType}:${row.sourceId}|${row.targetType}:${row.targetId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(row);
  }
  merged.sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
  return merged.slice(0, limit);
};

export type AggregateGroupBy = "kind" | "targetType" | "target" | "sourceType" | "day";

export const parseGroupBy = (value: string | undefined | null): AggregateGroupBy => {
  if (
    value === "targetType" ||
    value === "target" ||
    value === "sourceType" ||
    value === "day"
  ) {
    return value;
  }
  return "kind";
};

export type AggregateRow = {
  group: string;
  references: number;
  total: number;
};

/**
 * Aggregate reference edges for a space into grouped counts. `references` is the
 * row count, `total` sums the per-row occurrence counts. Powers distributions,
 * influence rankings, file-heat leaderboards, and time trends from one endpoint.
 *
 * `groupBy=target` ranks concrete target ids as `{targetType}:{targetId}` (e.g.
 * hottest file paths). File targets carry their own `{spaceId}:` prefix, so a
 * group can contain multiple colons — split only on the FIRST colon to recover
 * `targetType`. For big spaces, pair this with `kinds` and/or `since` so the
 * scan stays on the `spaceKindIdx` range rather than aggregating the whole space.
 */
export const aggregateReferences = async (input: {
  spaceId: string;
  groupBy: AggregateGroupBy;
  kinds?: ReferenceKind[];
  since?: Date | null;
  limit?: number;
}): Promise<AggregateRow[]> => {
  const { spaceId, groupBy, kinds, since, limit } = input;
  const kindFilter = kinds && kinds.length > 0 ? inArray(schema.resourceReferences.kind, kinds) : undefined;
  const sinceFilter = since ? gte(schema.resourceReferences.updatedAt, since) : undefined;
  const where = and(eq(schema.resourceReferences.sourceSpaceId, spaceId), kindFilter, sinceFilter);

  const groupExpr =
    groupBy === "targetType"
      ? sql<string>`${schema.resourceReferences.targetType}`
      : groupBy === "target"
        ? sql<string>`(${schema.resourceReferences.targetType} || ':' || ${schema.resourceReferences.targetId})`
        : groupBy === "sourceType"
          ? sql<string>`${schema.resourceReferences.sourceType}`
          : groupBy === "day"
            ? sql<string>`to_char(date_trunc('day', ${schema.resourceReferences.updatedAt}), 'YYYY-MM-DD')`
            : sql<string>`${schema.resourceReferences.kind}`;

  const query = db
    .select({
      group: groupExpr.as("group"),
      references: sql<number>`count(*)::int`,
      total: sql<number>`coalesce(sum(${schema.resourceReferences.count}), 0)::int`,
    })
    .from(schema.resourceReferences)
    .where(where)
    .groupBy(groupExpr)
    .orderBy(desc(sql`count(*)`));

  const rows = limit ? await query.limit(limit) : await query;
  return rows as AggregateRow[];
};
