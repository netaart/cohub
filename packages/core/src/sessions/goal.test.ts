import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { sessionGoals, sessionTurns, spaceSessions } from "@cohub/db";
import {
  advanceSessionGoalAfterTurn,
  buildGoalContinuationPrompt,
  clearSessionGoal,
  createSessionGoalContinuation,
  getSessionGoal,
  listStalledSessionGoals,
  sessionGoalTurnCanRun,
  setSessionGoal,
  updateSessionGoal,
  validateSessionGoalObjective,
} from "./goal.js";

const migrations = join(dirname(fileURLToPath(import.meta.url)), "../../../../apps/api/drizzle/v2");
type Database = Parameters<typeof getSessionGoal>[0];

const dbPromise = (async () => {
  const client = new PGlite({ extensions: { pg_trgm } });
  const journal = JSON.parse(readFileSync(join(migrations, "meta/_journal.json"), "utf8")) as { entries: Array<{ tag: string }> };
  for (const entry of journal.entries) {
    await client.exec(readFileSync(join(migrations, `${entry.tag}.sql`), "utf8").replaceAll("--> statement-breakpoint", ""));
  }
  return drizzle(client) as unknown as Database;
})();

async function seedSession() {
  const db = await dbPromise;
  const spaceId = crypto.randomUUID();
  const [session] = await db.insert(spaceSessions).values({ spaceId, status: "active", meta: {} }).returning();
  assert.ok(session);
  return { db, spaceId, sessionId: session.id };
}

async function insertTurn(db: Database, sessionId: string, sequence: number, input: {
  status?: "queued" | "running" | "completed" | "failed" | "interrupted" | "cancelled";
  intent?: "steer" | "followup" | "goal" | "compact";
  totalTokens?: number;
  durationMs?: number;
  summary?: Record<string, unknown> | null;
  meta?: Record<string, unknown> | null;
}) {
  const [turn] = await db.insert(sessionTurns).values({
    sessionId,
    sequence,
    status: input.status ?? "completed",
    intent: input.intent ?? "steer",
    userContent: [],
    totalUsage: input.totalTokens == null ? null : { totalTokens: input.totalTokens },
    durationMs: input.durationMs ?? null,
    summary: input.summary ?? null,
    meta: input.meta ?? null,
  }).returning();
  assert.ok(turn);
  return turn;
}

test("objective and prompt validation", () => {
  assert.equal(validateSessionGoalObjective("  ship it  "), "ship it");
  assert.throws(() => validateSessionGoalObjective("   "), /must not be empty/);
  assert.equal(
    buildGoalContinuationPrompt({ objective: "fix <x> & ship" }),
    buildGoalContinuationPrompt({ objective: "fix <x> & ship" }),
  );
  assert.match(buildGoalContinuationPrompt({ objective: "fix <x> & ship" }), /fix &lt;x&gt; &amp; ship/);
});

test("a goal stores one objective per session and replaces only a completed one", async () => {
  const { db, sessionId } = await seedSession();
  const goal = await setSessionGoal(db, {
    sessionId,
    objective: "first",
    tokenBudget: 100,
    createdBy: "user-1",
    accessMode: "read_only",
  });
  assert.equal(goal.status, "active");
  assert.equal(goal.createdSequence, 1);
  await assert.rejects(
    setSessionGoal(db, { sessionId, objective: "second", createdBy: "user-1" }),
    /unfinished goal/,
  );
  await updateSessionGoal(db, sessionId, { status: "complete" });
  await assert.rejects(
    updateSessionGoal(db, sessionId, { status: "active" }),
    /Cannot change goal status/,
  );
  const replaced = await setSessionGoal(db, { sessionId, objective: "second", createdBy: "user-1" });
  assert.equal(replaced.objective, "second");
  assert.equal(replaced.tokensUsed, 0);
  assert.equal(await clearSessionGoal(db, sessionId), true);
  assert.equal(await getSessionGoal(db, sessionId), null);
});

test("usage is derived from settled agent turns after the goal start", async () => {
  const { db, sessionId } = await seedSession();
  await insertTurn(db, sessionId, 1, { totalTokens: 99, durationMs: 1_000 });
  const goal = await setSessionGoal(db, { sessionId, objective: "count", createdBy: "user-1" });
  assert.equal(goal.createdSequence, 2);
  await insertTurn(db, sessionId, 2, { totalTokens: 10, durationMs: 2_000 });
  await insertTurn(db, sessionId, 3, { totalTokens: 5, durationMs: 3_000, status: "failed" });
  const read = await getSessionGoal(db, sessionId);
  assert.equal(read?.tokensUsed, 15);
  assert.equal(read?.timeUsedSeconds, 5);
});

test("a completed turn creates exactly one goal continuation, never while a user turn is queued", async () => {
  const { db, spaceId, sessionId } = await seedSession();
  await setSessionGoal(db, { sessionId, objective: "continue", createdBy: "user-1" });
  await insertTurn(db, sessionId, 1, { totalTokens: 10 });
  const first = await createSessionGoalContinuation(db, { spaceId, sessionId });
  assert.equal(first.continuation?.turn.intent, "goal");
  assert.equal(first.continuation?.turn.sequence, 2);
  const second = await createSessionGoalContinuation(db, { spaceId, sessionId });
  assert.equal(second.continuation, null);
  const queued = await insertTurn(db, sessionId, 3, { status: "queued" });
  assert.ok(queued);
  await db.update(sessionTurns).set({ status: "completed" }).where(and(
    eq(sessionTurns.sessionId, sessionId),
    eq(sessionTurns.intent, "goal"),
  ));
  const third = await createSessionGoalContinuation(db, { spaceId, sessionId });
  assert.equal(third.continuation, null);
});

test("budget and failed turns stop continuation", async () => {
  const { db, spaceId, sessionId } = await seedSession();
  await setSessionGoal(db, { sessionId, objective: "budgeted", tokenBudget: 5, createdBy: "user-1" });
  const turn = await insertTurn(db, sessionId, 1, { totalTokens: 10 });
  const result = await advanceSessionGoalAfterTurn(db, { spaceId, sessionId, turnId: turn.id });
  assert.equal(result.continuation, null);
  assert.equal(result.goal?.status, "budget_limited");
});

test("a failed turn blocks the goal and a steer interruption keeps it active", async () => {
  const { db, spaceId, sessionId } = await seedSession();
  await setSessionGoal(db, { sessionId, objective: "work", createdBy: "user-1" });
  const failed = await insertTurn(db, sessionId, 1, { status: "failed" });
  const blocked = await advanceSessionGoalAfterTurn(db, { spaceId, sessionId, turnId: failed.id });
  assert.equal(blocked.goal?.status, "blocked");
  assert.equal(blocked.continuation, null);

  await updateSessionGoal(db, sessionId, { status: "active" });
  const steered = await insertTurn(db, sessionId, 2, {
    status: "interrupted",
    summary: { finishReason: "interrupted", reason: "steer", continuedByTurnId: crypto.randomUUID() },
  });
  const active = await advanceSessionGoalAfterTurn(db, { spaceId, sessionId, turnId: steered.id });
  assert.equal(active.goal?.status, "active");
});

test("only an active idle goal is listed for recovery", async () => {
  const { db, sessionId } = await seedSession();
  await setSessionGoal(db, { sessionId, objective: "recover", createdBy: "user-1" });
  await db.update(sessionGoals).set({ updatedAt: new Date(Date.now() - 60_000) })
    .where(eq(sessionGoals.sessionId, sessionId));
  assert.deepEqual(
    (await listStalledSessionGoals(db, { idleSeconds: 30 })).map((row) => row.sessionId),
    [sessionId],
  );
  await insertTurn(db, sessionId, 1, { status: "running", intent: "goal" });
  assert.deepEqual(await listStalledSessionGoals(db, { idleSeconds: 30 }), []);
});

test("a settled goal turn advances to the next continuation", async () => {
  const { db, spaceId, sessionId } = await seedSession();
  await setSessionGoal(db, { sessionId, objective: "keep going", createdBy: "user-1" });
  const first = await createSessionGoalContinuation(db, { spaceId, sessionId });
  const firstTurn = first.continuation?.turn;
  if (!firstTurn) throw new Error("missing first goal continuation");
  await db.update(sessionTurns).set({
    status: "completed",
    totalUsage: { totalTokens: 7 },
  }).where(eq(sessionTurns.id, firstTurn.id));
  const next = await advanceSessionGoalAfterTurn(db, { spaceId, sessionId, turnId: firstTurn.id });
  assert.equal(next.continuation?.sequence, firstTurn.sequence + 1);
  assert.equal(next.goal?.tokensUsed, 7);
  assert.equal(next.goal?.status, "active");
});

test("editing the objective cancels a queued continuation", async () => {
  const { db, spaceId, sessionId } = await seedSession();
  await setSessionGoal(db, { sessionId, objective: "old objective", createdBy: "user-1" });
  const created = await createSessionGoalContinuation(db, { spaceId, sessionId });
  const continuation = created.continuation;
  if (!continuation) throw new Error("missing goal continuation");
  await updateSessionGoal(db, sessionId, { objective: "new objective" });
  const [turn] = await db.select().from(sessionTurns).where(eq(sessionTurns.id, continuation.turn.id));
  assert.equal(turn?.status, "cancelled");
});

test("a turn from a replaced goal cannot change the new goal", async () => {
  const { db, spaceId, sessionId } = await seedSession();
  await setSessionGoal(db, { sessionId, objective: "old", createdBy: "user-1" });
  const created = await createSessionGoalContinuation(db, { spaceId, sessionId });
  const oldTurn = created.continuation?.turn;
  if (!oldTurn) throw new Error("missing goal continuation");
  await updateSessionGoal(db, sessionId, { status: "complete" });
  await setSessionGoal(db, { sessionId, objective: "new", createdBy: "user-1" });
  await db.update(sessionTurns).set({ status: "failed" }).where(eq(sessionTurns.id, oldTurn.id));
  const result = await advanceSessionGoalAfterTurn(db, { spaceId, sessionId, turnId: oldTurn.id });
  assert.equal(result.goal, null);
  assert.equal((await getSessionGoal(db, sessionId))?.status, "active");
});

test("a stale continuation cannot run after the goal is paused", async () => {
  const { db, spaceId, sessionId } = await seedSession();
  await setSessionGoal(db, { sessionId, objective: "pause", createdBy: "user-1" });
  const created = await createSessionGoalContinuation(db, { spaceId, sessionId });
  const continuation = created.continuation;
  if (!continuation) throw new Error("missing goal continuation");
  await updateSessionGoal(db, sessionId, { status: "paused" });
  const [turn] = await db.select().from(sessionTurns).where(eq(sessionTurns.id, continuation.turn.id));
  assert.ok(turn);
  assert.equal(await sessionGoalTurnCanRun(db, turn), false);
  const [goal] = await db.select().from(sessionGoals).where(eq(sessionGoals.sessionId, sessionId));
  assert.equal(goal?.status, "paused");
});
