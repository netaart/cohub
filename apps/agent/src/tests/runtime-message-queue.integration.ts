import assert from "node:assert/strict";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { after, mock, test } from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { eq, is } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { getTableConfig, PgTable } from "drizzle-orm/pg-core";
import * as schema from "@cohub/db";

const engine = new PGlite();
const database = drizzle(engine, { schema });
await engine.exec("create schema v2");
for (const table of Object.values(schema).filter((table) => is(table, PgTable))) {
  const config = getTableConfig(table);
  const columns = config.columns.map((column) => `"${column.name}" ${column.getSQLType()}${column.name === "id" && column.getSQLType() === "uuid" ? " primary key default gen_random_uuid()" : column.name === "created_at" || column.name === "updated_at" ? " default now()" : ""}`);
  await engine.exec(`create table if not exists "${config.schema}"."${config.name}" (${columns.join(",")})`);
}

const db = new Proxy(database, { get(target, key) {
  if (key === "transaction") return (callback: (tx: unknown) => Promise<unknown>) => target.transaction((tx) => callback(new Proxy(tx, { get(transaction, method) {
    if (method === "execute") return async (query: unknown) => (await transaction.execute(query as never)).rows;
    const value = transaction[method as keyof typeof transaction];
    return typeof value === "function" ? value.bind(transaction) : value;
  } })));
  if (key === "execute") return async (query: unknown) => (await target.execute(query as never)).rows;
  const value = target[key as keyof typeof target];
  return typeof value === "function" ? value.bind(target) : value;
} });

const workspaceRoot = resolve(process.cwd(), ".message-queue-test");
process.env.WORKSPACE_ROOT = workspaceRoot;
mock.module("../db.js", { exports: { db } });
mock.module("../env.js", { exports: { env: { ENV: "test", AGENT_STALE_ACTIVE_TURN_MS: 60_000 } } });
const { claimNextTurnBatch } = await import("../batch.js");

after(async () => {
  await engine.close();
  await rm(workspaceRoot, { recursive: true, force: true });
});

async function createUserWithHomeSpace(configText: string | null) {
  const userUuid = crypto.randomUUID();
  const [home] = await database.insert(schema.spaces)
    .values({ userUuid, name: `Home ${userUuid}`, slug: "home" })
    .returning({ id: schema.spaces.id });
  if (!home) throw new Error("home space insert returned no row");
  if (configText !== null) {
    const dir = join(workspaceRoot, home.id, "workspace", ".cohub");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "queue.json"), configText);
  }
  return userUuid;
}

async function createQueuedFollowups(userUuid: string, count: number) {
  const sessionId = crypto.randomUUID();
  await database.insert(schema.spaceSessions).values({ id: sessionId, spaceId: crypto.randomUUID(), meta: {} });
  const turnIds: string[] = [];
  for (let index = 0; index < count; index += 1) {
    const id = crypto.randomUUID();
    await database.insert(schema.sessionTurns).values({
      id, sessionId, userUuid, sequence: index + 1, status: "queued", intent: "followup", executionKind: "agent",
      userContent: [{ type: "text", text: `message-${index + 1}` }], meta: {},
    });
    turnIds.push(id);
  }
  return { sessionId, turnIds };
}

async function statusOf(turnId: string) {
  const [row] = await database.select({ status: schema.sessionTurns.status }).from(schema.sessionTurns).where(eq(schema.sessionTurns.id, turnId));
  return row?.status;
}

test("one_by_one claims only the earliest queued follow-up and leaves the rest queued", async () => {
  const userUuid = await createUserWithHomeSpace("{\"version\":1,\"followupDelivery\":\"one_by_one\"}");
  const { sessionId, turnIds } = await createQueuedFollowups(userUuid, 3);
  const claim = await claimNextTurnBatch({ sessionId });
  assert.equal(claim.kind, "claimed");
  if (claim.kind !== "claimed") return;
  assert.deepEqual(claim.batch.turns.map((turn) => turn.id), [turnIds[0]]);
  assert.equal(claim.batch.ownerTurn.id, turnIds[0]);
  assert.deepEqual(claim.batch.mergedTurns, []);
  assert.equal(await statusOf(turnIds[0] as string), "running");
  assert.equal(await statusOf(turnIds[1] as string), "queued");
  assert.equal(await statusOf(turnIds[2] as string), "queued");

  await database.update(schema.sessionTurns).set({ status: "completed" }).where(eq(schema.sessionTurns.id, turnIds[0] as string));
  const next = await claimNextTurnBatch({ sessionId });
  assert.equal(next.kind, "claimed");
  if (next.kind !== "claimed") return;
  assert.deepEqual(next.batch.turns.map((turn) => turn.id), [turnIds[1]]);
});

test("together merges every queued follow-up into the last owner", async () => {
  const userUuid = await createUserWithHomeSpace("{\"version\":1,\"followupDelivery\":\"together\"}");
  const { sessionId, turnIds } = await createQueuedFollowups(userUuid, 3);
  const claim = await claimNextTurnBatch({ sessionId });
  assert.equal(claim.kind, "claimed");
  if (claim.kind !== "claimed") return;
  assert.deepEqual(claim.batch.turns.map((turn) => turn.id), turnIds);
  assert.equal(claim.batch.ownerTurn.id, turnIds[2]);
  assert.deepEqual(claim.batch.mergedTurns.map((turn) => turn.id), [turnIds[0], turnIds[1]]);
  assert.equal(await statusOf(turnIds[0] as string), "merged");
  assert.equal(await statusOf(turnIds[1] as string), "merged");
  assert.equal(await statusOf(turnIds[2] as string), "running");
});

test("a sender without queue config or without a Home Space keeps the together delivery", async () => {
  const withoutFile = await createUserWithHomeSpace(null);
  const withoutHome = crypto.randomUUID();
  for (const userUuid of [withoutFile, withoutHome]) {
    const { sessionId, turnIds } = await createQueuedFollowups(userUuid, 2);
    const claim = await claimNextTurnBatch({ sessionId });
    assert.equal(claim.kind, "claimed");
    if (claim.kind !== "claimed") return;
    assert.deepEqual(claim.batch.turns.map((turn) => turn.id), turnIds);
  }
});

test("an invalid queue config fails the claim and keeps every follow-up queued", async () => {
  const userUuid = await createUserWithHomeSpace("{\"version\":1,\"followupDelivery\":\"merge\"}");
  const { sessionId, turnIds } = await createQueuedFollowups(userUuid, 2);
  await assert.rejects(() => claimNextTurnBatch({ sessionId }), /Unknown followupDelivery/);
  assert.equal(await statusOf(turnIds[0] as string), "queued");
  assert.equal(await statusOf(turnIds[1] as string), "queued");
});
