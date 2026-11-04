import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import { sessionMessages, spaceSessions, spaces } from "@cohub/db";
import { asc, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { createSessionServices } from "./service.js";

const migrations = join(dirname(fileURLToPath(import.meta.url)), "../../../../apps/api/drizzle/v2");
const client = new PGlite({ extensions: { pg_trgm } });
const journal = JSON.parse(readFileSync(join(migrations, "meta/_journal.json"), "utf8")) as { entries: Array<{ tag: string }> };
for (const entry of journal.entries) {
	await client.exec(readFileSync(join(migrations, `${entry.tag}.sql`), "utf8").replaceAll("--> statement-breakpoint", ""));
}
const db = drizzle(client) as unknown as PostgresJsDatabase<Record<string, unknown>>;

const USER = "user-1";
const services = createSessionServices({
	db,
	redis: {} as never,
	promptTemplateService: { expand: async () => null },
	agentTurnQueue: { enqueue: async () => {} },
	logger: { warn: () => {} },
});

test("notes are idempotent per client message ID and safe under concurrent writes", async () => {
	const [space] = await db.insert(spaces).values({ userUuid: USER, name: "Notes" }).returning();
	assert.ok(space);
	const [session] = await db.insert(spaceSessions).values({ spaceId: space.id, userUuid: USER, meta: {} }).returning();
	assert.ok(session);
	const note = (clientMessageId: string) => services.recordNote({ sessionId: session.id, userUuid: USER, clientMessageId, content: [{ type: "text", text: clientMessageId }] });
	const retries = await Promise.all([note("a"), note("a"), note("a")]);
	assert.equal(new Set(retries.map((turn) => turn.id)).size, 1);
	await Promise.all([note("b"), note("c")]);
	const messages = await db.select().from(sessionMessages).where(eq(sessionMessages.sessionId, session.id)).orderBy(asc(sessionMessages.sequence));
	assert.deepEqual(messages.map((message) => message.sequence), [1, 2, 3]);
});
