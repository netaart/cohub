import assert from "node:assert/strict";
import { test, after } from "node:test";
import { getTableConfig } from "drizzle-orm/pg-core";
import { eq } from "drizzle-orm";
import * as schema from "@cohub/db";
import { createRuntimeContextReader } from "../runtime/context-reader.js";

const home = process.env.RUNTIME_TEST_DB_HOME;
if (!home) throw new Error("Set RUNTIME_TEST_DB_HOME to an isolated installation of @electric-sql/pglite and drizzle-orm");
const { PGlite } = await import(`${home}/node_modules/@electric-sql/pglite/dist/index.js`);
const { drizzle } = await import(`${home}/node_modules/drizzle-orm/pglite/index.js`);
const engine = new PGlite();
const database = drizzle(engine);
await engine.exec("create schema v2");
for (const table of [schema.spaceSessions, schema.sessionTurns, schema.sessionTurnSegments, schema.sessionMessages]) {
  const config = getTableConfig(table);
  const columns = config.columns.map((column) => `"${column.name}" ${column.getSQLType()}${column.name === "id" && column.getSQLType() === "uuid" ? " primary key default gen_random_uuid()" : column.name === "created_at" || column.name === "updated_at" ? " default now()" : ""}`);
  await engine.exec(`create table "${config.schema}"."${config.name}" (${columns.join(",")})`);
}
after(() => engine.close());
async function setup() {
  const spaceId = crypto.randomUUID(), sessionId = crypto.randomUUID(), turnId = crypto.randomUUID();
  await database.insert(schema.spaceSessions).values({ id: sessionId, spaceId });
  await database.insert(schema.sessionTurns).values({ id: turnId, sessionId, sequence: 1, status: "completed", executionKind: "agent", userContent: [{ type: "text", text: "original request" }], meta: { harness: "codex" } });
  return { spaceId, sessionId, turnId };
}

test("Codex forks preserve the native source boundary, including nested inherited forks", async () => {
  const identity = await setup();
  await database.update(schema.sessionTurns).set({ status: "completed", meta: { harness: "codex" } }).where(eq(schema.sessionTurns.id, identity.turnId));
  const childId = crypto.randomUUID(), nestedId = crypto.randomUUID();
  for (const sessionId of [childId, nestedId]) {
    await database.insert(schema.spaceSessions).values({ id: sessionId, spaceId: identity.spaceId });
    await database.insert(schema.sessionTurnSegments).values([
      { sessionId, ordinal: 1, sourceSessionId: identity.sessionId, fromSequence: 1, toSequence: 1 },
      { sessionId, ordinal: 2, sourceSessionId: sessionId, fromSequence: 2, toSequence: null },
    ]);
  }
  const load = createRuntimeContextReader(database);
  for (const sessionId of [childId, nestedId]) for (const headOnly of [false, true]) {
    const context = await load({ spaceId: identity.spaceId, sessionId, harness: "codex", headOnly });
    assert.deepEqual(context.fork, { sessionId: identity.sessionId, turnId: identity.turnId });
    assert.equal(context.throughTurnId, identity.turnId);
    assert.equal(context.complete, false);
    assert.deepEqual(context.messages, [], "projected DB text must not replace the native transcript");
  }
  for (const harness of [undefined, "pi"]) {
    const context = await load({ spaceId: identity.spaceId, sessionId: childId, harness });
    assert.equal(context.fork, undefined);
    assert.equal(context.messages.length, 1, "other harnesses still receive projected history");
  }
  const sameSession = await load({ ...identity, harness: "codex" });
  assert.equal(sameSession.fork, undefined);
  assert.equal(sameSession.messages.length, 1);
  const childTurnId = crypto.randomUUID();
  await database.insert(schema.sessionTurns).values({ id: childTurnId, sessionId: childId, sequence: 2, status: "completed", executionKind: "agent", userContent: [], meta: { harness: "codex" } });
  const established = await load({ spaceId: identity.spaceId, sessionId: childId, harness: "codex" });
  assert.deepEqual(established.fork, { sessionId: identity.sessionId, turnId: identity.turnId }, "an established child retains its native ancestry");
  assert.equal(established.throughTurnId, childTurnId);
  const index = { version: 1, sessionId: childId, turnId: childTurnId, harness: "codex", nativeFormat: "codex.rollout", nativeSessionId: "native", parentTurnId: identity.turnId, sizeBytes: 1, sha256: "a".repeat(64), segments: [{ offset: 0, sizeBytes: 1, sha256: "a".repeat(64), md5: "b".repeat(32) }] };
  await database.update(schema.sessionTurns).set({ harnessIndex: index, meta: { harness: "codex", runtimeArchiveStatus: "ready" } }).where(eq(schema.sessionTurns.id, childTurnId));
  const archived = await load({ spaceId: identity.spaceId, sessionId: childId, harness: "codex" });
  assert.deepEqual(archived.fork, established.fork);
  assert.deepEqual(archived.archive, { sessionId: childId, turnId: childTurnId, harness: "codex" }, "own archive still supports exact native continuation");
  await database.update(schema.sessionTurns).set({ harnessIndex: null, meta: { harness: "codex" } }).where(eq(schema.sessionTurns.id, childTurnId));
  await database.update(schema.sessionTurns).set({ status: "failed" }).where(eq(schema.sessionTurns.id, childTurnId));
  const retry = await load({ spaceId: identity.spaceId, sessionId: childId, harness: "codex" });
  assert.deepEqual(retry.fork, established.fork, "a failed first continuation must not erase its native ancestry");
  assert.equal(retry.complete, false);
  assert.deepEqual(retry.messages, [], "failure cannot silently replace native history with projected text");
  for (const status of ["running", "abort_requested"]) {
    await database.update(schema.sessionTurns).set({ status }).where(eq(schema.sessionTurns.id, identity.turnId));
    await assert.rejects(load({ spaceId: identity.spaceId, sessionId: nestedId, harness: "codex" }), /before an earlier turn has settled/);
  }
});

test("only explicitly rejected local fork attempts are skipped when retrying after an upgrade", async () => {
  const source = await setup(), childId = crypto.randomUUID();
  await database.insert(schema.spaceSessions).values({ id: childId, spaceId: source.spaceId });
  await database.insert(schema.sessionTurnSegments).values([
    { sessionId: childId, ordinal: 1, sourceSessionId: source.sessionId, fromSequence: 1, toSequence: 1 },
    { sessionId: childId, ordinal: 2, sourceSessionId: childId, fromSequence: 2, toSequence: null },
  ]);
  const mergedId = crypto.randomUUID(), failedId = crypto.randomUUID();
  const marker = { harness: "codex", runtimeForkRejection: "unsupported_runtime" };
  await database.insert(schema.sessionTurns).values([
    { id: mergedId, sessionId: childId, sequence: 2, status: "merged", executionKind: "agent", userContent: [], meta: { ...marker, harness: "pi" } },
    { id: failedId, sessionId: childId, sequence: 3, status: "failed", executionKind: "agent", userContent: [], meta: marker },
  ]);
  const load = createRuntimeContextReader(database);
  const input = { spaceId: source.spaceId, sessionId: childId, harness: "codex" };
  for (const headOnly of [false, true]) {
    const retry = await load({ ...input, headOnly });
    assert.equal(retry.throughTurnId, source.turnId, "upgrade retry resumes the original native boundary");
    assert.deepEqual(retry.fork, { sessionId: source.sessionId, turnId: source.turnId });
    assert.equal(retry.complete, false);
  }
  const [failed] = await database.select().from(schema.sessionTurns).where(eq(schema.sessionTurns.id, failedId));
  assert.equal(failed.status, "failed", "the failed attempt remains recorded");
  assert.equal((await load({ ...input, harness: "pi" })).throughTurnId, failedId, "other harnesses keep their existing history");
  for (const status of ["completed", "interrupted"]) {
    await database.update(schema.sessionTurns).set({ status }).where(eq(schema.sessionTurns.id, failedId));
    assert.equal((await load(input)).throughTurnId, failedId, "the marker alone cannot erase an executed turn");
  }
  for (const status of ["running", "abort_requested"]) {
    await database.update(schema.sessionTurns).set({ status }).where(eq(schema.sessionTurns.id, failedId));
    await assert.rejects(load(input), /before an earlier turn has settled/);
  }
  await database.update(schema.sessionTurns).set({ status: "failed", meta: { harness: "codex" } }).where(eq(schema.sessionTurns.id, failedId));
  assert.equal((await load(input)).throughTurnId, failedId, "unknown failures are never skipped");
  await database.update(schema.sessionTurns).set({ meta: marker }).where(eq(schema.sessionTurns.id, failedId));
  await database.update(schema.sessionTurns).set({ status: "failed", meta: marker }).where(eq(schema.sessionTurns.id, source.turnId));
  assert.equal((await load(input)).throughTurnId, source.turnId, "the reader never skips a marked turn inherited from another session");
});
