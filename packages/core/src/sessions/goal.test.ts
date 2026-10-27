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
import { advanceSessionGoalAfterTurn, createSessionGoalContinuation, getSessionGoal, setSessionGoal, SessionGoalError } from "./goal.js";
const migrations = join(dirname(fileURLToPath(import.meta.url)), "../../../../apps/api/drizzle/v2");
type Database = Parameters<typeof setSessionGoal>[0];
const dbPromise = (async () => {
  const client = new PGlite({ extensions: { pg_trgm } });
  const journal = JSON.parse(readFileSync(join(migrations, "meta/_journal.json"), "utf8")) as { entries: Array<{ tag: string }> };
  for (const entry of journal.entries) await client.exec(readFileSync(join(migrations, `${entry.tag}.sql`), "utf8").replaceAll("--> statement-breakpoint", ""));
  return drizzle(client) as unknown as Database;
})();

async function seed() {
  const db = await dbPromise;
  const spaceId = crypto.randomUUID();
  const [session] = await db.insert(spaceSessions).values({ spaceId, meta: { title: { source: "user" } } }).returning();
  assert.ok(session);
  return { db, id: session.id, spaceId };
}

test("stores one active goal in session metadata", async () => {
  const { db, id } = await seed();
  const goal = await setSessionGoal(db, id, "  Ship the parser  ");
  assert.equal(goal.objective, "Ship the parser");
  assert.deepEqual(await getSessionGoal(db, id), goal);
  await assert.rejects(setSessionGoal(db, id, "Second"), (error: unknown) => error instanceof SessionGoalError && error.code === "unfinished_goal");
});

test("creates one goal continuation and stops after a failed goal turn", async () => {
  const { db, id, spaceId } = await seed();
  await setSessionGoal(db, id, "Finish the migration");
  const started = await createSessionGoalContinuation(db, { spaceId, sessionId: id });
  assert.ok(started);
  assert.match(String((started.turn.meta as Record<string, unknown>).goalPrompt), /Finish the migration/);
  assert.equal(await createSessionGoalContinuation(db, { spaceId, sessionId: id }), null);
  await db.update(sessionTurns).set({ status: "failed" }).where(eq(sessionTurns.id, started.turn.id));
  const result = await advanceSessionGoalAfterTurn(db, { spaceId, sessionId: id, turnId: started.turn.id });
  assert.equal(result.goal?.status, "blocked");
  assert.equal(result.continuation, null);
});
