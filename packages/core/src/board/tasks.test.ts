import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import { drizzle } from "drizzle-orm/pglite";
import { eq } from "drizzle-orm";
import { taskRuns } from "@cohub/db";
import type { BoardTaskSnapshot } from "@cohub/protocol";
import {
	applyBoard,
	type BoardDatabase,
	createBoard,
	readBoard,
	syncTaskBoards,
} from "./store.js";
import { boardChangedEvent, readUnsizedTaskVisual } from "./tasks.js";

const migrations = join(dirname(fileURLToPath(import.meta.url)), "../../../../apps/api/drizzle/v2");
const spaceId = "22222222-2222-4222-8222-222222222222";
const otherSpaceId = "33333333-3333-4333-8333-333333333333";
const actorId = "user";
const owner = "owner-1";
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
	return `44444444-4444-4444-8444-${String(sequence).padStart(12, "0")}`;
}

async function generation(input: { space?: string; status?: string; output?: unknown[]; errorMessage?: string } = {}) {
	const db = await dbPromise;
	const id = uuid();
	await db.insert(taskRuns).values({
		id,
		jobId: id,
		taskType: "generation",
		status: input.status ?? "pending",
		spaceId: input.space ?? spaceId,
		userUuid: owner,
		payload: {
			type: "generation",
			data: {
				model: "gpt-image-2",
				content: [
					{ type: "text", text: "a calm lake at sunrise" },
					{ type: "image", source: { type: "base64", mediaType: "image/png", data: "x".repeat(64) } },
				],
			},
		} as never,
		result: input.output ? { output: input.output } : null,
		errorMessage: input.errorMessage ?? null,
		startedAt: input.status && input.status !== "pending" ? new Date("2026-10-13T00:00:00.000Z") : null,
	});
	return id;
}

async function finish(id: string, output: unknown[]) {
	const db = await dbPromise;
	await db.update(taskRuns).set({ status: "completed", result: { output }, finishedAt: new Date(), updatedAt: new Date() }).where(eq(taskRuns.id, id));
}

async function board(document = {}, space = spaceId) {
	const db = await dbPromise;
	const { boardId } = await createBoard(db, { spaceId: space, title: "Tasks", actorId, document });
	return { db, boardId };
}

const task = (taskRunId: string, extra: Record<string, unknown> = {}) => ({
	type: "task",
	size: { width: 300, height: 400 },
	props: { taskRunId, ...extra },
});

async function snapshot(db: BoardDatabase, boardId: string, id: string, space = spaceId): Promise<BoardTaskSnapshot> {
	const item = (await readBoard(db, { spaceId: space, boardId, read: { items: [id] } })).items?.[id];
	assert.equal(item?.type, "task");
	return (item.props as { snapshot: BoardTaskSnapshot }).snapshot;
}

const image = (url: string, extra: Record<string, unknown> = {}) => ({ type: "image", source: { type: "url", url }, ...extra });

test("task items take their snapshot from the run, never from the writer", async () => {
	const id = await generation({ status: "running" });
	const { db, boardId } = await board({ items: { t: task(id) } });
	let current = await snapshot(db, boardId, "t");
	assert.equal(current.status, "running");
	assert.equal(current.promptExcerpt, "a calm lake at sunrise");
	assert.equal(current.model, "gpt-image-2");
	assert.equal(current.startedAt, "2026-10-13T00:00:00.000Z");

	await applyBoard(db, {
		spaceId,
		boardId,
		actorId,
		apply: { patch: { items: { t: { props: { snapshot: { status: "completed", title: "forged", artifactCount: 9 } } } } } },
	});
	current = await snapshot(db, boardId, "t");
	assert.equal(current.status, "running");
	assert.equal(current.artifactCount, 0);
});

test("completion updates every Board showing the task, once", async () => {
	const id = await generation({ status: "running" });
	const first = await board({ items: { a: task(id), b: task(id), note: { type: "text", props: { text: "x" } } } });
	const second = await board({ items: { c: task(id) } });
	const elsewhere = await board({ items: { d: task(id, { snapshot: { taskType: "generation", status: "running", title: "Copied", artifactCount: 0 } }) } }, otherSpaceId);
	const { db } = first;

	await finish(id, [image("https://cdn.example.com/a.png", { width: 1600, height: 900 }), image("https://cdn.example.com/b.png")]);
	const writes = await syncTaskBoards(db, { spaceId, taskRunId: id, revision: "completed:1", actorId: owner, source: { via: "task" } });
	assert.deepEqual(writes.map((write) => write.boardId).sort(), [first.boardId, second.boardId].sort());
	assert.deepEqual(writes.find((write) => write.boardId === first.boardId)?.outcome.result.changed.items.sort(), ["a", "b"]);

	for (const [boardId, itemId] of [[first.boardId, "a"], [first.boardId, "b"], [second.boardId, "c"]] as const) {
		const current = await snapshot(db, boardId, itemId);
		assert.equal(current.status, "completed");
		assert.equal(current.artifactCount, 2);
		const featured = current.artifacts[0];
		assert.equal(featured?.type, "image");
		assert.equal(featured?.type === "image" ? featured.naturalWidth : undefined, 1600);
	}
	const fitted = await readBoard(db, { spaceId, boardId: first.boardId, read: { items: ["a"] } });
	assert.deepEqual(fitted.items?.a?.size, { width: 400, height: 225 });
	assert.deepEqual(fitted.items?.a?.position, { x: 0, y: 0 });

	assert.equal((await snapshot(db, elsewhere.boardId, "d", otherSpaceId)).status, "running");

	const before = (await readBoard(db, { spaceId, boardId: first.boardId, read: { only: ["animations"] } })).version;
	const retry = await syncTaskBoards(db, { spaceId, taskRunId: id, revision: "completed:1", actorId: owner });
	assert.ok(retry.every((write) => write.outcome.result.replayed));
	assert.equal((await readBoard(db, { spaceId, boardId: first.boardId, read: { only: ["animations"] } })).version, before);

	const written = writes[0]?.outcome;
	assert.ok(written);
	const event = boardChangedEvent({ spaceId, boardId: first.boardId, actorId: owner, actor: { kind: "user" }, outcome: written });
	assert.equal(event?.payload.mutationId, `task:${id}:completed:1`);
	assert.equal(boardChangedEvent({ spaceId, boardId: first.boardId, actorId: owner, actor: { kind: "user" }, outcome: { result: written.result } }), null);
});

test("completion fits cards to a result size learned before the write", async () => {
	const id = await generation({ status: "running" });
	const { db, boardId } = await board({ items: { t: task(id) } });
	await finish(id, [image("https://cdn.example.com/unsized.png")]);
	const visual = await readUnsizedTaskVisual(db, { spaceId, taskRunId: id });
	assert.deepEqual(visual, { type: "image", url: "https://cdn.example.com/unsized.png" });
	assert.ok(visual);
	const taskArtifactSizes = new Map([[visual.url, { width: 1600, height: 900 }]]);
	await syncTaskBoards(db, { spaceId, taskRunId: id, revision: "completed:sized", actorId: owner, taskArtifactSizes });
	const featured = (await snapshot(db, boardId, "t")).artifacts[0];
	assert.equal(featured?.type === "image" ? featured.naturalWidth : undefined, 1600);
	assert.deepEqual((await readBoard(db, { spaceId, boardId, read: { items: ["t"] } })).items?.t?.size, { width: 400, height: 225 });
});
