import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import { drizzle } from "drizzle-orm/pglite";
import { eq } from "drizzle-orm";
import { sessionTurns, spaceSessions } from "@cohub/db";
import type { BoardSessionSnapshot } from "@cohub/protocol";
import { applyBoard, type BoardDatabase, createBoard, readBoard, syncSessionBoards } from "./store.js";

const migrations = join(dirname(fileURLToPath(import.meta.url)), "../../../../apps/api/drizzle/v2");
const spaceId = "22222222-2222-4222-8222-222222222222";
const otherSpaceId = "33333333-3333-4333-8333-333333333333";
const actorId = "user";
let sequence = 0;

async function database(): Promise<BoardDatabase> {
	const client = new PGlite({ extensions: { pg_trgm } });
	const journal = JSON.parse(readFileSync(join(migrations, "meta/_journal.json"), "utf8")) as { entries: Array<{ tag: string }> };
	for (const entry of journal.entries) {
		await client.exec(readFileSync(join(migrations, `${entry.tag}.sql`), "utf8").replaceAll("--> statement-breakpoint", ""));
	}
	return drizzle(client) as unknown as BoardDatabase;
}

const dbPromise = database();

function uuid() {
	sequence += 1;
	return `55555555-5555-4555-8555-${String(sequence).padStart(12, "0")}`;
}

async function session(input: { space?: string; title?: string | null; latest?: string } = {}) {
	const db = await dbPromise;
	const id = uuid();
	await db.insert(spaceSessions).values({
		id,
		spaceId: input.space ?? spaceId,
		title: input.title === undefined ? "Fix reconnect storm" : input.title,
		source: "cli",
		latestMessageText: input.latest ?? "Added **jitter** to [api-client.ts](src/api-client.ts).",
		lastMessageAt: new Date("2026-10-27T08:00:00.000Z"),
	});
	return id;
}

async function board(document = {}, space = spaceId) {
	const db = await dbPromise;
	const { boardId } = await createBoard(db, { spaceId: space, title: "Sessions", actorId, document, sessionViewer: () => true });
	return { db, boardId };
}

const card = (sessionId: string, extra: Record<string, unknown> = {}) => ({ type: "session", props: { sessionId, ...extra } });

async function snapshot(db: BoardDatabase, boardId: string, id: string): Promise<BoardSessionSnapshot> {
	const item = (await readBoard(db, { boardId, read: { items: [id] } })).items?.[id];
	assert.equal(item?.type, "session");
	return (item.props as { snapshot: BoardSessionSnapshot }).snapshot;
}

test("session cards take their snapshot from the Session, never from the writer", async () => {
	const id = await session();
	const { db, boardId } = await board({ items: { s: card(id) } });
	assert.deepEqual(await snapshot(db, boardId, "s"), {
		title: "Fix reconnect storm",
		excerpt: "Added jitter to api-client.ts.",
		source: "cli",
		activityAt: "2026-10-27T08:00:00.000Z",
		spaceId,
	});

	await applyBoard(db, { boardId, actorId, apply: { patch: { items: { s: { props: { snapshot: { title: "forged", issue: "failed" } } } } } } });
	assert.equal((await snapshot(db, boardId, "s")).title, "Fix reconnect storm");
	assert.equal((await snapshot(db, boardId, "s")).issue, undefined);
});

test("sync refreshes stale cards on every Board showing the Session, in any Space, once", async () => {
	const id = await session();
	const first = await board({ items: { a: card(id), b: card(id) } });
	const second = await board({ items: { c: card(id) } });
	const elsewhere = await board({ items: { d: card(id) } }, otherSpaceId);
	const { db } = first;

	assert.deepEqual(await syncSessionBoards(db, { sessionId: id, actorId: "system", source: { via: "session" } }), []);

	await db.update(spaceSessions).set({ title: "Reconnect with jitter" }).where(eq(spaceSessions.id, id));
	await db.insert(sessionTurns).values({
		sessionId: id,
		sequence: 1,
		status: "failed",
		userContent: [{ type: "text", text: "go" }],
		errorMessage: "Sandbox exited with code 137",
	});
	const writes = await syncSessionBoards(db, { sessionId: id, actorId: "system", source: { via: "session" } });
	assert.deepEqual(
		writes.map((write) => `${write.spaceId}:${write.boardId}`).sort(),
		[`${spaceId}:${first.boardId}`, `${spaceId}:${second.boardId}`, `${otherSpaceId}:${elsewhere.boardId}`].sort(),
	);
	assert.deepEqual(writes.find((write) => write.boardId === first.boardId)?.outcome.result.changed.items.sort(), ["a", "b"]);
	const current = await snapshot(db, second.boardId, "c");
	assert.equal(current.title, "Reconnect with jitter");
	assert.equal(current.issue, "failed");
	assert.equal(current.errorExcerpt, "Sandbox exited with code 137");
	assert.equal((await snapshot(db, elsewhere.boardId, "d")).title, "Reconnect with jitter");

	assert.deepEqual(await syncSessionBoards(db, { sessionId: id, actorId: "system", source: { via: "session" } }), []);
});

test("a copy written without a viewer, as a fork restores it, stays as copied", async () => {
	const id = await session();
	const db = await dbPromise;
	const document = { items: { d: card(id, { snapshot: { title: "Copied", spaceId } }) } };
	const { boardId } = await createBoard(db, { spaceId: otherSpaceId, title: "Fork", actorId: "system", document });
	assert.deepEqual(await snapshot(db, boardId, "d"), { title: "Copied" });

	await db.update(spaceSessions).set({ title: "Renamed" }).where(eq(spaceSessions.id, id));
	const writes = await syncSessionBoards(db, { sessionId: id, actorId: "system" });
	assert.ok(writes.every((write) => write.boardId !== boardId));
	assert.equal((await snapshot(db, boardId, "d")).title, "Copied");
});
