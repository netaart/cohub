import assert from "node:assert/strict";
import { after, mock, test } from "node:test";
import { eq } from "drizzle-orm";
import { getTableConfig } from "drizzle-orm/pg-core";
import { sessionTurns } from "@cohub/db";

const home = process.env.RUNTIME_TEST_DB_HOME;
if (!home) throw new Error("Set RUNTIME_TEST_DB_HOME to an isolated installation of @electric-sql/pglite and drizzle-orm");
const { PGlite } = await import(`${home}/node_modules/@electric-sql/pglite/dist/index.js`);
const { drizzle } = await import(`${home}/node_modules/drizzle-orm/pglite/index.js`);
const engine = new PGlite();
const db = drizzle(engine);
await engine.exec("create schema v2");
const config = getTableConfig(sessionTurns);
await engine.exec(`create table v2.session_turns (${config.columns.map((column) => `"${column.name}" ${column.getSQLType()}`).join(",")})`);
const warnings = [];
mock.module("../db.js", { exports: { db } });
mock.module("../logger.js", { exports: { logger: { warn: (...args) => warnings.push(args) } } });
const { persistRequestMetric, recordRetryWait } = await import("../metrics.ts");
after(() => engine.close());

test("attempt receipts survive failure and repeated completion does not duplicate usage", async () => {
  const id = crypto.randomUUID();
  await db.insert(sessionTurns).values({ id, meta: { userField: "keep", metrics: { version: 1, executionStartedAt: 500 } } });
  const request = { id: "attempt", provider: "p", model: "m", startedAt: 1000, status: "running" };
  await persistRequestMetric(id, request);
  const completed = { ...request, status: "failed", completedAt: 1500, durationMs: 500, omitted: true, usage: { totalTokens: 25 } };
  await persistRequestMetric(id, completed);
  await persistRequestMetric(id, completed);
  const [turn] = await db.select().from(sessionTurns).where(eq(sessionTurns.id, id));
  assert.equal(Object.keys(turn.meta.metrics.requests).length, 1);
  assert.equal(turn.meta.metrics.requests.attempt.usage.totalTokens, 25);
  assert.equal(turn.meta.metrics.executionStartedAt, 500);
  assert.equal(turn.meta.userField, "keep");
});

test("concurrent receipts and retry waiting preserve each other's namespaces", async () => {
  const id = crypto.randomUUID();
  await db.insert(sessionTurns).values({ id, meta: { metrics: { version: 1, tools: { calls: 2 } } } });
  await Promise.all([
    persistRequestMetric(id, { id: "a", provider: "p", model: "m", startedAt: 1, status: "running" }),
    persistRequestMetric(id, { id: "b", provider: "p", model: "m", startedAt: 2, status: "running" }),
    recordRetryWait(id, 100),
  ]);
  const [turn] = await db.select().from(sessionTurns).where(eq(sessionTurns.id, id));
  assert.equal(Object.keys(turn.meta.metrics.requests).length, 2);
  assert.equal(turn.meta.metrics.retryCount, 1);
  assert.equal(turn.meta.metrics.retryWaitMs, 100);
  assert.equal(turn.meta.metrics.tools.calls, 2);
  assert.equal(warnings.length, 0);
});
