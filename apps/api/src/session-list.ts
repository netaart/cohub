import { resolveSessionSourceKey, SESSION_SOURCE_KEYS } from "@cohub/core/labels/session-source";

export const DEFAULT_SESSION_LIST_LIMIT = 20;
export const MAX_SESSION_LIST_LIMIT = 100;
/** Standard UUID (space_sessions.id is uuid). */
const SESSION_LIST_CURSOR_ID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class InvalidSessionListCursorError extends Error {
  constructor(message = "invalid cursor") {
    super(message);
    this.name = "InvalidSessionListCursorError";
  }
}

export type SessionListCursor = {
  /** ISO timestamp, or null when paging into NULL lastMessageAt rows. */
  date: Date | null;
  id: string;
};

export type SessionListActivityRow = {
  id: string;
  lastMessageAt: Date | string | null;
};

/**
 * Source kinds a cross-space session list can be filtered by, comma-separated
 * in `?source=`. Keys come from `SESSION_SOURCE_KEYS` so the vocabulary stays
 * shared with the source labels in a space sidebar.
 */
export type SessionSourceFilter = {
  keys: readonly string[];
};

/**
 * Parses `?source=web,feishu`. Returns null when the param is absent, and
 * throws for unknown keys so a typo fails loudly instead of silently
 * returning everything.
 */
export const parseSessionSourceKeys = (
  value: string | null | undefined,
): SessionSourceFilter | null => {
  const raw = value?.trim();
  if (!raw) return null;
  const keys = [...new Set(raw.split(",").map((key) => key.trim().toLowerCase()).filter(Boolean))];
  if (keys.length === 0) return null;
  const unknown = keys.filter((key) => !SESSION_SOURCE_KEYS.includes(key));
  if (unknown.length > 0) {
    throw new InvalidSessionSourceFilterError(unknown);
  }
  return { keys };
};

export class InvalidSessionSourceFilterError extends Error {
  constructor(readonly unknownKeys: readonly string[]) {
    super(`unknown session source keys: ${unknownKeys.join(", ")}`);
    this.name = "InvalidSessionSourceFilterError";
  }
}

/** Local resolution used for `other`, which has no raw source value of its own. */
export const isOtherSessionSource = (key: string) => key === "other";

/** Maps a raw source back to its kind; mirrors the label vocabulary. */
export const sessionSourceKeyOf = (source: string | null | undefined) => resolveSessionSourceKey(source);


export const encodeSessionListCursor = (
  session: Pick<SessionListActivityRow, "id" | "lastMessageAt"> | null | undefined,
) => {
  if (!session?.id) return null;
  if (!session.lastMessageAt) return `null|${session.id}`;
  const lastMessageAt = session.lastMessageAt instanceof Date
    ? session.lastMessageAt.toISOString()
    : new Date(session.lastMessageAt).toISOString();
  return `${lastMessageAt}|${session.id}`;
};

/**
 * Parse list cursor: `<ISO date|null>|<uuid>`.
 * Empty / missing → null. Malformed → InvalidSessionListCursorError.
 */
export const decodeSessionListCursor = (
  cursor: string | null | undefined,
): SessionListCursor | null => {
  if (cursor == null) return null;
  const trimmed = cursor.trim();
  if (!trimmed) return null;

  const separatorIndex = trimmed.lastIndexOf("|");
  if (separatorIndex <= 0 || separatorIndex === trimmed.length - 1) {
    throw new InvalidSessionListCursorError();
  }

  const rawDate = trimmed.slice(0, separatorIndex);
  const id = trimmed.slice(separatorIndex + 1).trim();
  if (!SESSION_LIST_CURSOR_ID_RE.test(id)) {
    throw new InvalidSessionListCursorError();
  }

  if (rawDate === "null") return { date: null, id };

  const date = new Date(rawDate);
  if (Number.isNaN(date.getTime())) {
    throw new InvalidSessionListCursorError();
  }
  return { date, id };
};

export const resolveSessionListLimit = (limit?: number) => {
  const rawLimit = Math.trunc(limit ?? DEFAULT_SESSION_LIST_LIMIT);
  return Number.isFinite(rawLimit)
    ? Math.min(Math.max(rawLimit, 1), MAX_SESSION_LIST_LIMIT)
    : DEFAULT_SESSION_LIST_LIMIT;
};

export const paginateSessionRows = <T extends SessionListActivityRow>(
  rows: T[],
  limit: number,
) => {
  const hasMore = rows.length > limit;
  const sessions = hasMore ? rows.slice(0, limit) : rows;
  const lastSession = sessions.at(-1);
  return {
    sessions,
    pageInfo: {
      hasMore,
      nextCursor: hasMore ? encodeSessionListCursor(lastSession) : null,
    },
  };
};

const sessionActivityTimeMs = (value: Date | string | null | undefined) => {
  if (!value) return null;
  const time = value instanceof Date ? value.getTime() : new Date(value).getTime();
  return Number.isFinite(time) ? time : null;
};

/** Same order as SQL: lastMessageAt DESC NULLS LAST, id DESC. */
export const compareSessionListActivity = (
  a: SessionListActivityRow,
  b: SessionListActivityRow,
) => {
  const aTime = sessionActivityTimeMs(a.lastMessageAt);
  const bTime = sessionActivityTimeMs(b.lastMessageAt);
  if (aTime === null && bTime === null) {
    return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
  }
  if (aTime === null) return 1;
  if (bTime === null) return -1;
  if (aTime !== bTime) return bTime - aTime;
  return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
};

/** Merge creator/participant branches into one activity-ordered page. */
export const mergeUserSessionListBranches = <T extends SessionListActivityRow>(
  branches: T[][],
  limit: number,
) => {
  const byId = new Map<string, T>();
  for (const branch of branches) {
    for (const row of branch) byId.set(row.id, row);
  }
  const rows = [...byId.values()]
    .sort(compareSessionListActivity)
    .slice(0, limit + 1);
  return paginateSessionRows(rows, limit);
};

/**
 * Keep the caller's activity order while applying a visibility set.
 * Permission checks may group by space; results must not be re-bucketed.
 */
export const pickSessionsPreservingOrder = <T extends { id: string }>(
  ordered: T[],
  visibleIds: ReadonlySet<string>,
): T[] => ordered.filter((row) => visibleIds.has(row.id));
