// RUNTIME_TEST_DB_HOME=/tmp/... node --import tsx --test apps/api/tests/local-runtime-status.integration.mjs
// Install @electric-sql/pglite and drizzle-orm@0.45.2 under that temporary directory.
// Isolated in-memory PostgreSQL only; never imports the application's DB client.
import assert from "node:assert/strict";
import { test } from "node:test";
import { reportLocalRuntimeStatus } from "../src/lib/sandbox/local-runtime-status.ts";

const home = process.env.RUNTIME_TEST_DB_HOME;
if (!home) throw new Error("RUNTIME_TEST_DB_HOME must point to an isolated PGlite installation");
const { PGlite } = await import(`${home}/node_modules/@electric-sql/pglite/dist/index.js`);
const { drizzle } = await import(`${home}/node_modules/drizzle-orm/pglite/index.js`);

test("status writes follow the active lease without generations or clock ordering", async () => {
  const engine = new PGlite();
  const database = drizzle(engine);
  const spaceId = crypto.randomUUID(), runtimeId = crypto.randomUUID();
  const old = crypto.randomUUID(), current = crypto.randomUUID();
  let lease = old;
  const readLease = async () => lease ? JSON.stringify({ runtimeId, connectionId: lease, observedAt: new Date().toISOString() }) : null;
  const report = (connectionId, status, read = readLease) => reportLocalRuntimeStatus(database, {
    spaceId, runtimeId, connectionId, status, wsEndpoint: `ws://gateway/${connectionId}`,
  }, read);
  await engine.exec(`CREATE SCHEMA v2; CREATE TABLE v2.space_sandboxes (
    id uuid, space_id uuid PRIMARY KEY, provider text, status text, runtime_status text,
    pod_name text, desired_image text, reported_image_version text, reported_at timestamptz,
    last_heartbeat_at timestamptz, last_activity_at timestamptz, stopped_at timestamptz,
    stop_reason text, meta jsonb, created_at timestamptz, updated_at timestamptz
  )`);
  await engine.query("INSERT INTO v2.space_sandboxes (space_id, provider, status, meta) VALUES ($1, 'local', 'stopped', '{\"keep\":\"original\"}')", [spaceId]);
  const snapshot = async () => (await engine.query("SELECT status, meta FROM v2.space_sandboxes")).rows[0];
  try {
    await report(old, "ready");
    lease = current;
    await report(current, "ready");
    await report(old, "ready");
    await report(old, "stopped");
    assert.equal((await snapshot()).meta.runtimeConnectionId, current);
    assert.equal((await snapshot()).status, "ready");
    lease = null;
    await report(current, "stopped");
    await report(current, "ready");
    assert.equal((await snapshot()).status, "stopped", "duplicate ready after lease removal cannot resurrect a connection");
    // Start a ready write, then remove its lease and queue stop before it completes.
    lease = current;
    const writing = report(current, "ready", async () => {
      const value = await readLease();
      lease = null;
      return value;
    });
    const stopping = report(current, "stopped");
    await Promise.all([writing, stopping]);
    assert.equal((await snapshot()).status, "stopped", "stop follows the row-locked ready write");
    const before = await snapshot();
    await assert.rejects(report(current, "ready", async () => { throw new Error("Redis unavailable"); }), /Redis unavailable/);
    assert.deepEqual(await snapshot(), before, "lookup failure rolls back and leaves original metadata untouched");
    lease = current;
    await report(current, "ready");
    assert.equal((await snapshot()).status, "ready", "no counter reset or clock skew can block a valid lease");
    assert.equal((await snapshot()).meta.keep, "original");
    assert.equal(await reportLocalRuntimeStatus(database, { spaceId: crypto.randomUUID(), status: "stopped" }, readLease), false);
  } finally { await engine.close(); }
});
