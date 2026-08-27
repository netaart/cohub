import { Platform } from "react-native";
import { openDatabaseAsync, type SQLiteDatabase } from "expo-sqlite";
import type { MessageRecord, SpaceRecord, UserSessionListItem } from "@neta-art/cohub";

export type CachedHome = {
  spaces: SpaceRecord[];
  sessions: UserSessionListItem[];
};

let databasePromise: Promise<SQLiteDatabase> | null = null;

async function database() {
  if (Platform.OS === "web") throw new Error("SQLite cache is only available on native platforms");
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

export async function saveHome(userKey: string, home: CachedHome) {
  const db = await database();
  const now = Date.now();
  await db.withTransactionAsync(async () => {
    for (const space of home.spaces) {
      await db.runAsync(
        `INSERT OR REPLACE INTO spaces (user_key, space_id, payload, updated_at) VALUES (?, ?, ?, ?)`,
        userKey,
        space.id,
        JSON.stringify(space),
        now,
      );
    }
    for (const session of home.sessions) {
      await db.runAsync(
        `INSERT OR REPLACE INTO sessions (user_key, session_id, space_id, payload, updated_at) VALUES (?, ?, ?, ?, ?)`,
        userKey,
        session.id,
        session.spaceId,
        JSON.stringify(session),
        now,
      );
    }
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
      await db.runAsync(
        `INSERT OR REPLACE INTO messages (user_key, session_id, message_id, sequence, payload, updated_at) VALUES (?, ?, ?, ?, ?, ?)`,
        userKey,
        sessionId,
        message.id,
        message.sequence,
        JSON.stringify(message),
        now,
      );
    }
  });
}

export async function clearUserCache(userKey: string) {
  if (Platform.OS === "web") return;
  const db = await database();
  await db.withTransactionAsync(async () => {
    await db.runAsync("DELETE FROM messages WHERE user_key = ?", userKey);
    await db.runAsync("DELETE FROM sessions WHERE user_key = ?", userKey);
    await db.runAsync("DELETE FROM spaces WHERE user_key = ?", userKey);
  });
}
