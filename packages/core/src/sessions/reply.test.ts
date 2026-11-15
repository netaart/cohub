import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import { sessionTurns, spaceMembers, spaceSessions, spaces } from "@cohub/db";
import { readSessionTurnOrigin } from "@cohub/protocol/model";
import { asc, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { createDrizzlePermissionStore } from "../permissions/index.js";
import { deliverTurnReplies } from "./reply.js";
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
const deps = { db, services, permissions: createDrizzlePermissionStore(db) };

async function chat(name: string) {
	const [space] = await db.insert(spaces).values({ userUuid: crypto.randomUUID(), name }).returning();
	assert.ok(space);
	await db.insert(spaceMembers).values({ spaceId: space.id, userId: USER, role: "builder", createdBy: "owner", updatedBy: "owner" });
	const [session] = await db.insert(spaceSessions).values({ spaceId: space.id, userUuid: USER, meta: {} }).returning();
	assert.ok(session);
	return { spaceId: space.id, sessionId: session.id };
}

const turnsOf = (sessionId: string) => db.select().from(sessionTurns).where(eq(sessionTurns.sessionId, sessionId)).orderBy(asc(sessionTurns.sequence));

test("a reply wakes the calling Chat's Agent once, back at the caller's depth", async () => {
	const caller = await chat("Home");
	const worker = await chat("Design");
	const { turnId: callerTurnId } = await services.submitPrompt({ ...caller, userId: USER, clientMessageId: crypto.randomUUID(), content: [{ type: "text", text: "plan" }], source: "web" });
	const { turnId } = await services.submitPrompt({
		...worker,
		userId: USER,
		clientMessageId: crypto.randomUUID(),
		content: [{ type: "text", text: "tidy the header" }],
		source: "cli",
		origin: { kind: "prompt", ...caller, turnId: callerTurnId, depth: 1 },
		reply: { mode: "prompt" },
	});
	await db.update(sessionTurns).set({ status: "completed", assistantContent: [{ type: "text", text: "Done." }] }).where(eq(sessionTurns.id, turnId));

	await deliverTurnReplies(deps, turnId);
	await deliverTurnReplies(deps, turnId);
	const [, reply, extra] = await turnsOf(caller.sessionId);
	assert.equal(extra, undefined);
	assert.deepEqual([reply?.executionKind, readSessionTurnOrigin(reply?.meta)?.depth], ["agent", 0]);
	assert.deepEqual(reply?.userContent.at(-1), { type: "text", text: "Done." });
});
