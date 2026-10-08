import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { sessionTurns, spaceSessions } from "@cohub/db";
import { publishSessionSnapshot, type SessionSnapshotEvent } from "./snapshot.js";
import { refreshSessionStats } from "./stats.js";

const migrations = join(dirname(fileURLToPath(import.meta.url)), "../../../../apps/api/drizzle/v2");
type Database = Parameters<typeof refreshSessionStats>[0];

const dbPromise = (async () => {
  const client = new PGlite({ extensions: { pg_trgm } });
  const journal = JSON.parse(readFileSync(join(migrations, "meta/_journal.json"), "utf8")) as { entries: Array<{ tag: string }> };
  for (const entry of journal.entries) {
    await client.exec(readFileSync(join(migrations, `${entry.tag}.sql`), "utf8").replaceAll("--> statement-breakpoint", ""));
  }
  return drizzle(client) as unknown as Database;
})();

async function seed(...tokens: number[]) {
  const db = await dbPromise;
  const [session] = await db.insert(spaceSessions).values({ spaceId: crypto.randomUUID(), meta: {} }).returning();
  assert.ok(session);
  const turns = await db.insert(sessionTurns).values(tokens.map((totalTokens, index) => ({
    sessionId: session.id, sequence: index + 1, status: "completed" as const, userContent: [], totalUsage: { totalTokens },
  }))).returning();
  return { db, id: session.id, turns: turns.map((turn) => turn.id) };
}

test("stored Turn stats are reused until a Turn at or after fromSequence changes", async () => {
  const { db, id, turns } = await seed(10, 20);
  await refreshSessionStats(db, id);
  for (const turnId of turns) await db.update(sessionTurns).set({ totalUsage: { totalTokens: 100 } }).where(eq(sessionTurns.id, turnId));
  assert.equal((await refreshSessionStats(db, id))?.stats.own.usage?.totalTokens, 30);
  assert.equal((await refreshSessionStats(db, id, 2))?.stats.own.usage?.totalTokens, 110);
});

test("a snapshot carries the settled record even when stats fail", async () => {
  const { db, id } = await seed(10);
  const events: SessionSnapshotEvent[] = [];
  await publishSessionSnapshot(db, id, async (event) => { events.push(event); }, 1);
  const failing = Object.assign(Object.create(db), { transaction: () => Promise.reject(new Error("down")) }) as Database;
  await assert.rejects(publishSessionSnapshot(failing, id, async (event) => { events.push(event); }), /down/);
  assert.deepEqual(events.map((event) => [event.payload.session.activeTurn, event.payload.session.activeTurnSequence, event.payload.session.stats?.own.turns]), [[null, 1, 1], [null, 1, undefined]]);
});
