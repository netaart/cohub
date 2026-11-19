import { getSessionInitiatorLabelSystemKey, getSessionSourceLabelSystemKey } from "@cohub/core/labels/session-attribution";
import { labelAssignments, labels, spaceSessions } from "@cohub/db";
import { and, inArray, sql, type SQL } from "drizzle-orm";
import type { SessionAttributionFilter } from "./session-list.js";

/** Filters by system labels; `v2_idx_label_assignments_scope_resource` covers the probe. */
function sessionSystemLabelCondition(systemKeys: string[]): SQL {
  return sql`exists (
    select 1 from ${labelAssignments}
    inner join ${labels} on ${labels.id} = ${labelAssignments.labelId}
    where ${labelAssignments.scopeType} = 'space'
      and ${labelAssignments.scopeId} = ${spaceSessions.spaceId}::text
      and ${labelAssignments.resourceType} = 'session'
      and ${labelAssignments.resourceRef} = ${spaceSessions.id}::text
      and ${inArray(labels.systemKey, systemKeys)}
  )`;
}

export function sessionAttributionCondition(filter: SessionAttributionFilter | null): SQL | undefined {
  if (!filter) return undefined;
  const clauses = [
    filter.source.length > 0 ? sessionSystemLabelCondition(filter.source.map(getSessionSourceLabelSystemKey)) : undefined,
    filter.initiator.length > 0 ? sessionSystemLabelCondition(filter.initiator.map(getSessionInitiatorLabelSystemKey)) : undefined,
  ].filter((clause): clause is SQL => Boolean(clause));
  return clauses.length > 1 ? and(...clauses) : clauses[0];
}
