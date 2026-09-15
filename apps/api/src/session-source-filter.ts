import { getSessionSourceLabelSystemKey } from "@cohub/core/labels/session-source";
import { labelAssignments, labels, spaceSessions } from "@cohub/db";
import { or, sql, type SQL } from "drizzle-orm";
import type { SessionSourceFilter } from "./session-list.js";

/**
 * Sessions are filtered by their source **system label**, not by the raw
 * `space_sessions.source` string.
 *
 * Labels are the attribution that is actually correct: they are assigned
 * provider-aware at creation (`assignSessionSourceSystemLabel`), they are what
 * the space sidebar shows, and they survive the `source` column being retired.
 * Matching the raw string meant re-deriving that attribution in SQL — channel
 * sessions are stored as `feishu:dm:…` / `channel:feishu`, so an exact match on
 * the kind dropped them, and `other` claimed them in the same breath.
 *
 * Probes `(scope, resourceType, resourceRef)` on label_assignments, which
 * `v2_idx_label_assignments_scope_resource` covers, then the label by primary
 * key. Sessions with no source label match no kind and only appear under "All".
 */
export function sessionSourceKindCondition(key: string): SQL {
  const systemKey = getSessionSourceLabelSystemKey(key);
  return sql`exists (
    select 1 from ${labelAssignments}
    inner join ${labels} on ${labels.id} = ${labelAssignments.labelId}
    where ${labelAssignments.scopeType} = 'space'
      and ${labelAssignments.scopeId} = ${spaceSessions.spaceId}::text
      and ${labelAssignments.resourceType} = 'session'
      and ${labelAssignments.resourceRef} = ${spaceSessions.id}::text
      and ${labels.systemKey} = ${systemKey}
  )`;
}

/** SQL predicate for `?source=`. Unknown kinds are rejected by the route first. */
export function sessionListSourceCondition(
  source: SessionSourceFilter | null,
): SQL | undefined {
  if (!source || source.keys.length === 0) return undefined;
  const clauses = source.keys.map((key) => sessionSourceKindCondition(key));
  return clauses.length === 1 ? clauses[0] : or(...clauses);
}
