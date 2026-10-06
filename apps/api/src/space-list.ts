import { sql, type SQL } from "drizzle-orm";
import { db } from "./db/index.js";

const SPACE_LIST_FILTERS = ["recent", "all", "mine", "pinned", "archived"] as const;
export type SpaceListFilter = (typeof SPACE_LIST_FILTERS)[number];
export const isSpaceListFilter = (value: string): value is SpaceListFilter =>
  (SPACE_LIST_FILTERS as readonly string[]).includes(value);
export type SpaceVisit = { spaceId: string; at: Date };
export type SpaceListCursor = { at: string; id: string };

export type SpaceListRow = {
  id: string;
  user_uuid: string;
  name: string;
  slug: string | null;
  description: string | null;
  created_at: Date | string;
  updated_at: Date | string;
  last_activity_at: Date | string | null;
  avatar_url: string | null;
  owner_display_name: string | null;
  owner_username: string | null;
  owner_avatar_url: string | null;
  is_pinned: boolean;
  is_archived: boolean;
  joined_at: Date | string;
  sort_at: Date | string;
  /** `sort_at` at full microsecond precision, so a cursor never skips rows within one millisecond. */
  cursor_at: string;
};

export const RECENT_SPACE_LIMIT = 50;
const RECENT_SESSION_WINDOW = 500;
const MAX_SPACE_VISITS = 10;
const UUID_PATTERN = "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$";
const UUID = new RegExp(UUID_PATTERN, "i");
const PINNED = "user:pinned";
const ARCHIVED = "user:archived";

const hasUserLabel = (userUuid: string, systemKey: string, spaceId: SQL) => sql`exists (
  select 1 from v2.labels l
  join v2.label_assignments a on a.label_id = l.id and a.resource_type = 'space' and a.resource_ref = (${spaceId})::text
  where l.scope_type = 'user' and l.scope_id = ${userUuid} and l.system_key = ${systemKey}
)`;

export function parseSpaceVisits(ids: string[], ats: string[], fallbackAt?: Date): SpaceVisit[] {
  const latest = new Map<string, number>();
  ids.forEach((raw, index) => {
    const spaceId = raw.trim().toLowerCase();
    const at = Date.parse(ats[index] ?? "") || fallbackAt?.getTime();
    if (!UUID.test(spaceId) || !at) return;
    latest.set(spaceId, Math.max(latest.get(spaceId) ?? 0, at));
  });
  return [...latest]
    .sort((a, b) => b[1] - a[1])
    .slice(0, MAX_SPACE_VISITS)
    .map(([spaceId, at]) => ({ spaceId, at: new Date(at) }));
}

function recentPage(userUuid: string, visits: SpaceVisit[], limit: number) {
  const visitRows = visits.length
    ? sql`union all select * from (values ${sql.join(visits.map((visit) => sql`(${visit.spaceId}::uuid, ${visit.at.toISOString()}::timestamptz)`), sql`, `)}) visit(space_id, at)`
    : sql``;
  return sql`
    with signal(space_id, at) as (
      (select space_id, last_message_at from v2.space_sessions
        where user_uuid = ${userUuid} and last_message_at is not null
        order by last_message_at desc nulls last, id desc limit ${RECENT_SESSION_WINDOW})
      union all
      (select space_id, last_message_at from v2.space_sessions
        where (meta -> 'participants' -> 'userUuids') ? ${userUuid} and last_message_at is not null
        order by last_message_at desc limit ${RECENT_SESSION_WINDOW})
      union all
      (select space_id, created_at from v2.space_members
        where user_id = ${userUuid}
        order by created_at desc nulls last, space_id desc nulls last limit ${limit})
      ${visitRows}
    )
    select sm.space_id id, max(signal.at) sort_at, sm.created_at joined_at
    from signal
    join v2.space_members sm on sm.space_id = signal.space_id and sm.user_id = ${userUuid}
    where not ${hasUserLabel(userUuid, ARCHIVED, sql`sm.space_id`)}
    group by sm.space_id, sm.created_at
    order by sort_at desc, id desc
    limit ${limit}
  `;
}

function membershipPage(input: {
  userUuid: string;
  filter: Exclude<SpaceListFilter, "recent">;
  query: string;
  exactName: string;
  cursor: SpaceListCursor | null;
  limit: number;
}) {
  const { userUuid, filter, query, exactName, cursor } = input;
  const labeled = filter === "pinned" || filter === "archived";
  const needsSpace = filter === "mine" || Boolean(query || exactName);
  const pattern = `%${query.replace(/[\\%_]/g, "\\$&")}%`;
  const from = labeled
    ? sql`from v2.labels l
        join v2.label_assignments a on a.label_id = l.id and a.resource_type = 'space'
        join v2.space_members sm on sm.user_id = ${userUuid}
          and sm.space_id = case when a.resource_ref ~* ${UUID_PATTERN} then a.resource_ref::uuid end`
    : sql`from v2.space_members sm`;
  return sql`
    select sm.space_id id, sm.created_at sort_at, sm.created_at joined_at
    ${from}
    ${needsSpace ? sql`join v2.spaces s on s.id = sm.space_id` : sql``}
    ${query ? sql`left join v2.user_profiles o on o.user_uuid = s.user_uuid` : sql``}
    where sm.user_id = ${userUuid}
      ${labeled
        ? sql`and l.scope_type = 'user' and l.scope_id = ${userUuid} and l.system_key = ${filter === "pinned" ? PINNED : ARCHIVED}`
        : sql``}
      ${filter === "archived" ? sql`` : sql`and not ${hasUserLabel(userUuid, ARCHIVED, sql`sm.space_id`)}`}
      ${filter === "mine" ? sql`and s.user_uuid = ${userUuid}` : sql``}
      ${exactName ? sql`and s.name = ${exactName}` : sql``}
      ${query
        ? sql`and (s.name ilike ${pattern} or s.description ilike ${pattern} or s.slug ilike ${pattern} or o.display_name ilike ${pattern} or o.username ilike ${pattern})`
        : sql``}
      ${cursor ? sql`and (sm.created_at, sm.space_id) < (${cursor.at}::timestamptz, ${cursor.id}::uuid)` : sql``}
    order by sm.created_at desc nulls last, sm.space_id desc nulls last
    limit ${input.limit}
  `;
}

async function hydrate(userUuid: string, page: SQL): Promise<SpaceListRow[]> {
  return db.execute<SpaceListRow>(sql`
    with page as (${page})
    select s.id, s.user_uuid, s.name, s.slug,
      nullif(left(regexp_replace(coalesce(s.description, ''), '\\s+', ' ', 'g'), 220), '') description,
      s.created_at, s.updated_at, s.last_activity_at,
      nullif(trim(coalesce(s.meta #>> '{publicProfile,avatarUrl}', '')), '') avatar_url,
      up.display_name owner_display_name, up.username owner_username, up.avatar_url owner_avatar_url,
      ${hasUserLabel(userUuid, PINNED, sql`s.id`)} is_pinned,
      ${hasUserLabel(userUuid, ARCHIVED, sql`s.id`)} is_archived,
      page.joined_at, page.sort_at,
      to_char(page.sort_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') cursor_at
    from page
    join v2.spaces s on s.id = page.id
    left join v2.user_profiles up on up.user_uuid = s.user_uuid
    order by page.sort_at desc, page.id desc
  `);
}

export function listRecentSpaces(userUuid: string, visits: SpaceVisit[], limit = RECENT_SPACE_LIMIT) {
  return hydrate(userUuid, recentPage(userUuid, visits, Math.min(limit, RECENT_SPACE_LIMIT)));
}

export async function listMemberSpaces(input: Parameters<typeof membershipPage>[0]) {
  const rows = await hydrate(input.userUuid, membershipPage({ ...input, limit: input.limit + 1 }));
  const items = rows.slice(0, input.limit);
  const last = items.at(-1);
  return {
    rows: items,
    nextCursor: rows.length > input.limit && last ? encodeSpaceListCursor(last) : null,
  };
}

function encodeSpaceListCursor(row: SpaceListRow): string {
  return Buffer.from(JSON.stringify({ at: row.cursor_at, id: row.id })).toString("base64url");
}

export function decodeSpaceListCursor(value: string | undefined): SpaceListCursor | null | false {
  if (!value) return null;
  try {
    const cursor = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as Partial<SpaceListCursor>;
    if (typeof cursor.at !== "string" || !Number.isFinite(Date.parse(cursor.at))) return false;
    if (typeof cursor.id !== "string" || !UUID.test(cursor.id)) return false;
    return { at: cursor.at, id: cursor.id };
  } catch {
    return false;
  }
}
