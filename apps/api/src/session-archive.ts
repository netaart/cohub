import { sql, type SQL } from "drizzle-orm";
import { ARCHIVED_LABEL_SYSTEM_KEY } from "@cohub/core/labels";

export const ARCHIVED_SESSION_SYSTEM_KEY = ARCHIVED_LABEL_SYSTEM_KEY;

/** The viewer archived the session identified by `sessionId`. */
export function hasArchivedSessionLabel(viewerUuid: string, sessionId: SQL): SQL<boolean> {
  return sql<boolean>`exists (
    select 1 from v2.labels l
    join v2.label_assignments a on a.label_id = l.id
      and a.resource_type = 'session'
      and a.resource_ref = (${sessionId})::text
    where l.scope_type = 'user'
      and l.scope_id = ${viewerUuid}
      and l.system_key = ${ARCHIVED_SESSION_SYSTEM_KEY}
  )`;
}

/**
 * Archive filter for a session list. Anonymous viewers have no archive state,
 * so the filter disappears.
 */
export function sessionArchiveFilter(
  viewerUuid: string | null | undefined,
  archived: boolean,
  sessionId: SQL,
): SQL<boolean> | undefined {
  const viewer = viewerUuid?.trim();
  if (!viewer) return undefined;
  const archivedPredicate = hasArchivedSessionLabel(viewer, sessionId);
  return archived ? archivedPredicate : sql`not ${archivedPredicate}`;
}
