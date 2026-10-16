import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import { drizzle } from "drizzle-orm/pglite";
import { eq } from "drizzle-orm";
import { spaceSessions } from "@cohub/db";
import { lockPromptSession } from "./prompt-session.js";

const migrations = new URL("../../../../apps/api/drizzle/v2/", import.meta.url);

test("turn transactions lock only a session belonging to the requested space", async () => {
  const client = new PGlite({ extensions: { pg_trgm } });
  try {
    const journal = JSON.parse(readFileSync(new URL("meta/_journal.json", migrations), "utf8"));
    for (const entry of journal.entries) {
      await client.exec(readFileSync(new URL(`${entry.tag}.sql`, migrations), "utf8"));
    }
    const db = drizzle(client);
    const sessionId = crypto.randomUUID();
    const spaceId = crypto.randomUUID();
    const otherSpaceId = crypto.randomUUID();
    await db.insert(spaceSessions).values({ id: sessionId, spaceId, meta: { title: "original" } });

    const session = await db.transaction((tx) => lockPromptSession(tx, { spaceId, sessionId }));
    assert.deepEqual(session, { spaceId, meta: { title: "original" } });
    await assert.rejects(db.transaction((tx) => lockPromptSession(tx, { spaceId: otherSpaceId, sessionId })), /session not found/);
    await assert.rejects(db.transaction((tx) => lockPromptSession(tx, { spaceId, sessionId: crypto.randomUUID() })), /session not found/);

    await db.update(spaceSessions).set({ spaceId: otherSpaceId }).where(eq(spaceSessions.id, sessionId));
    await assert.rejects(db.transaction((tx) => lockPromptSession(tx, { spaceId, sessionId })), /session not found/);
    assert.equal((await db.transaction((tx) => lockPromptSession(tx, { spaceId: otherSpaceId, sessionId }))).spaceId, otherSpaceId);
  } finally {
    await client.close();
  }
});
