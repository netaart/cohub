import {
  sessionSourceMatchSpec,
  SESSION_SOURCE_KEYS,
} from "@cohub/core/labels/session-source";
import { spaceSessions } from "@cohub/db";
import { and, inArray, isNotNull, isNull, not, or, sql } from "drizzle-orm";
import type { AnyColumn, SQL } from "drizzle-orm";
import type { SessionSourceFilter } from "./session-list.js";

function lowerIn(column: SQL | AnyColumn, values: readonly string[]) {
  if (values.length === 0) return undefined;
  return inArray(sql`lower(${column})`, [...values]);
}

/**
 * SQL predicate for one source kind. Must stay aligned with
 * `sessionSourceMatchesKey`, which a test pins it against. A stored source is
 * attributed the same way the label normalizer does it:
 *   - full spellings: `web`, `web_app`, `feishu`
 *   - channel command spellings: `channel:feishu`, `channel_feishu`
 *   - `<kind>:<payload>`: `feishu:oc_…`, `qq:c2c:…` (head segment)
 * A null source is a legacy web row.
 */
export function sessionSourceKindCondition(key: string): SQL | undefined {
  const spec = sessionSourceMatchSpec(key);
  return or(
    lowerIn(spaceSessions.source, [...spec.exact, ...spec.channel]),
    lowerIn(sql`split_part(${spaceSessions.source}, ':', 1)`, spec.exact),
    spec.nullSource ? isNull(spaceSessions.source) : undefined,
  );
}

const knownSourceCondition = () =>
  or(
    ...SESSION_SOURCE_KEYS.filter((key) => key !== "other").map((key) =>
      sessionSourceKindCondition(key),
    ),
  ) as SQL;

/**
 * SQL predicate for `?source=`. Unknown kinds cannot reach here: the route
 * validates keys against `SESSION_SOURCE_KEYS` first.
 */
export function sessionListSourceCondition(
  source: SessionSourceFilter | null,
): SQL | undefined {
  if (!source || source.keys.length === 0) return undefined;
  const clauses = source.keys.map((key) =>
    key === "other"
      ? and(isNotNull(spaceSessions.source), not(knownSourceCondition()))
      : sessionSourceKindCondition(key),
  );
  return clauses.length === 1 ? clauses[0] : or(...clauses);
}
