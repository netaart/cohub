import { openDatabaseAsync, type SQLiteDatabase } from "expo-sqlite";
import type { MessageRecord, SpaceRecord, UserSessionListItem } from "@neta-art/cohub";

export type CachedHome = {
  spaces: SpaceRecord[];
  sessions: UserSessionListItem[];
};

let databasePromise: Promise<SQLiteDatabase> | null = null;

async function database() {
  databasePromise ??= openDatabaseAsync("cohub-mobile.db");
  const db = await databasePromise;
  await db.execAsync(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS spaces (
      user_key TEXT NOT NULL,
      space_id TEXT NOT NULL,
      payload TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (user_key, space_id)
    );
    CREATE TABLE IF NOT EXISTS sessions (
      user_key TEXT NOT NULL,
      session_id TEXT NOT NULL,
      space_id TEXT NOT NULL,
      payload TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (user_key, session_id)
    );
    CREATE TABLE IF NOT EXISTS messages (
      user_key TEXT NOT NULL,
      session_id TEXT NOT NULL,
      message_id TEXT NOT NULL,
      sequence INTEGER NOT NULL,
      payload TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (user_key, session_id, message_id)
    );
    CREATE INDEX IF NOT EXISTS messages_session_sequence
      ON messages (user_key, session_id, sequence);
    CREATE TABLE IF NOT EXISTS session_read_state (
      user_key TEXT NOT NULL,
      session_id TEXT NOT NULL,
      sequence INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (user_key, session_id)
    );
  `);
  return db;
}

function parse<T>(value: string): T | null {
  try {
    return JSON.parse(value) as T;
  } catch {
    return null;
  }
}

export async function hydrateHome(userKey: string): Promise<CachedHome> {
  const db = await database();
  const [spaceRows, sessionRows] = await Promise.all([
    db.getAllAsync<{ payload: string }>(
      "SELECT payload FROM spaces WHERE user_key = ? ORDER BY updated_at DESC",
      userKey,
    ),
    db.getAllAsync<{ payload: string }>(
      "SELECT payload FROM sessions WHERE user_key = ? ORDER BY updated_at DESC",
      userKey,
    ),
  ]);
  return {
    spaces: spaceRows.flatMap((row) => {
      const value = parse<SpaceRecord>(row.payload);
      return value ? [value] : [];
    }),
    sessions: sessionRows.flatMap((row) => {
      const value = parse<UserSessionListItem>(row.payload);
      return value ? [value] : [];
    }),
  };
}

async function writeSpaces(db: SQLiteDatabase, userKey: string, spaces: readonly SpaceRecord[], now: number) {
  for (const space of spaces) {
    await db.runAsync(
      `INSERT OR REPLACE INTO spaces (user_key, space_id, payload, updated_at) VALUES (?, ?, ?, ?)`,
      userKey,
      space.id,
      JSON.stringify(space),
      now,
    );
  }
}

async function writeSessions(db: SQLiteDatabase, userKey: string, sessions: readonly UserSessionListItem[], now: number) {
  for (const session of sessions) {
    await db.runAsync(
      `INSERT OR REPLACE INTO sessions (user_key, session_id, space_id, payload, updated_at) VALUES (?, ?, ?, ?, ?)`,
      userKey,
      session.id,
      session.spaceId,
      JSON.stringify(session),
      now,
    );
  }
}

export async function saveHome(userKey: string, home: CachedHome) {
  const db = await database();
  const now = Date.now();
  await db.withTransactionAsync(async () => {
    await writeSpaces(db, userKey, home.spaces, now);
    await writeSessions(db, userKey, home.sessions, now);
  });
}

/** Persist individual Spaces without rewriting the rest of the home cache. */
export async function saveSpaces(userKey: string, spaces: readonly SpaceRecord[]) {
  if (spaces.length === 0) return;
  const db = await database();
  const now = Date.now();
  await db.withTransactionAsync(() => writeSpaces(db, userKey, spaces, now));
}

/** Persist individual Chats without rewriting the rest of the home cache. */
export async function saveSessions(userKey: string, sessions: readonly UserSessionListItem[]) {
  if (sessions.length === 0) return;
  const db = await database();
  const now = Date.now();
  await db.withTransactionAsync(() => writeSessions(db, userKey, sessions, now));
}

/** Drop cached chat rows last written before the cutoff (cache retention). */
export async function pruneUserCache(userKey: string, cutoff: number) {
  const db = await database();
  await db.withTransactionAsync(async () => {
    await db.runAsync("DELETE FROM messages WHERE user_key = ? AND updated_at < ?", userKey, cutoff);
    await db.runAsync("DELETE FROM sessions WHERE user_key = ? AND updated_at < ?", userKey, cutoff);
    await db.runAsync("DELETE FROM session_read_state WHERE user_key = ? AND updated_at < ?", userKey, cutoff);
  });
}

export async function loadMessages(userKey: string, sessionId: string) {
  const db = await database();
  const rows = await db.getAllAsync<{ payload: string }>(
    "SELECT payload FROM messages WHERE user_key = ? AND session_id = ? ORDER BY sequence ASC",
    userKey,
    sessionId,
  );
  return rows.flatMap((row) => {
    const value = parse<MessageRecord>(row.payload);
    return value ? [value] : [];
  });
}

export async function saveMessages(userKey: string, sessionId: string, messages: MessageRecord[]) {
  const db = await database();
  const now = Date.now();
  await db.withTransactionAsync(async () => {
    for (const message of messages) {
      const meta = message.meta ? { ...message.meta } : null;
      if (meta) delete meta._mobileLive;
      const persistable = { ...message, meta };
      await db.runAsync(
        `INSERT OR REPLACE INTO messages (user_key, session_id, message_id, sequence, payload, updated_at) VALUES (?, ?, ?, ?, ?, ?)`,
        userKey,
        sessionId,
        message.id,
        message.sequence,
        JSON.stringify(persistable),
        now,
      );
    }
  });
}

export async function loadSessionReadSequence(userKey: string, sessionId: string): Promise<number | null> {
  const db = await database();
  const row = await db.getFirstAsync<{ sequence: number }>(
    "SELECT sequence FROM session_read_state WHERE user_key = ? AND session_id = ?",
    userKey,
    sessionId,
  );
  return row?.sequence ?? null;
}

export async function saveSessionReadSequence(userKey: string, sessionId: string, sequence: number) {
  const db = await database();
  await db.runAsync(
    "INSERT OR REPLACE INTO session_read_state (user_key, session_id, sequence, updated_at) VALUES (?, ?, ?, ?)",
    userKey,
    sessionId,
    sequence,
    Date.now(),
  );
}

export async function clearUserCache(userKey: string) {
  const db = await database();
  await db.withTransactionAsync(async () => {
    await db.runAsync("DELETE FROM messages WHERE user_key = ?", userKey);
    await db.runAsync("DELETE FROM sessions WHERE user_key = ?", userKey);
    await db.runAsync("DELETE FROM spaces WHERE user_key = ?", userKey);
    await db.runAsync("DELETE FROM session_read_state WHERE user_key = ?", userKey);
  });
}

export type CacheStats = {
  spaces: number;
  sessions: number;
  messages: number;
  readStates: number;
};

/** Row counts for the authenticated user's local cache, for the debug inspector. */
export async function cacheStats(userKey: string): Promise<CacheStats> {
  const db = await database();
  const row = await db.getFirstAsync<CacheStats>(
    `SELECT
      (SELECT COUNT(*) FROM spaces WHERE user_key = ?) AS spaces,
      (SELECT COUNT(*) FROM sessions WHERE user_key = ?) AS sessions,
      (SELECT COUNT(*) FROM messages WHERE user_key = ?) AS messages,
      (SELECT COUNT(*) FROM session_read_state WHERE user_key = ?) AS readStates`,
    userKey,
    userKey,
    userKey,
    userKey,
  );
  return row ?? { spaces: 0, sessions: 0, messages: 0, readStates: 0 };
}
