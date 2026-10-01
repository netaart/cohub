import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import { drizzle } from "drizzle-orm/pglite";
import { parseBoardDocument } from "@cohub/protocol";
import {
	applyBoard,
	applyBoardPlayback,
	BoardError,
	type BoardDatabase,
	captureBoardSnapshots,
	createBoard,
	deleteBoard,
	readBoard,
	readBoardHistory,
	restoreBoardVersion,
} from "./store.js";

const migrations = join(dirname(fileURLToPath(import.meta.url)), "../../../../apps/api/drizzle/v2");
const spaceId = "11111111-1111-4111-8111-111111111111";
const actorId = "user";

async function database(): Promise<BoardDatabase> {
	const client = new PGlite({ extensions: { pg_trgm } });
	const journal = JSON.parse(readFileSync(join(migrations, "meta/_journal.json"), "utf8")) as { entries: Array<{ tag: string }> };
	for (const entry of journal.entries) {
		await client.exec(readFileSync(join(migrations, `${entry.tag}.sql`), "utf8").replaceAll("--> statement-breakpoint", ""));
	}
	return drizzle(client) as unknown as BoardDatabase;
}

const dbPromise = database();

async function board(document = {}) {
	const db = await dbPromise;
	const { boardId } = await createBoard(db, { spaceId, title: "Test", actorId, document });
	return { db, boardId };
}

test("create, read and merge-patch items with derived bounds", async () => {
	const { db, boardId } = await board({
		items: {
			f: { type: "frame", position: { x: 100, y: 100 }, size: { width: 400, height: 300 } },
			s: { type: "shape", parent: "f", position: { x: 10, y: 20 }, size: { width: 50, height: 40 } },
			t: { type: "text", props: { text: "Hello" } },
		},
	});
	const read = await readBoard(db, { spaceId, boardId });
	assert.equal(read.version, 1);
	assert.deepEqual(read.items?.s, {
		parent: "f",
		z: 1,
		position: { x: 10, y: 20 },
		rotation: 0,
		scale: 1,
		origin: { x: 0.5, y: 0.5 },
		opacity: 1,
		style: {},
		size: { width: 50, height: 40 },
		type: "shape",
		props: { geometry: "rectangle", text: "", fontSize: 20, align: "center" },
	});
	const inRect = await readBoard(db, { spaceId, boardId, read: { rect: { x: 105, y: 115, width: 10, height: 10 } } });
	assert.deepEqual(Object.keys(inRect.items ?? {}).sort(), ["f", "s"]);

	const outcome = await applyBoard(db, { spaceId, boardId, actorId, apply: { patch: { items: { f: { position: { x: 1000 } } } } } });
	assert.equal(outcome.result.status, "applied");
	assert.equal(outcome.result.version, 2);
	assert.deepEqual(outcome.written?.after.items?.f, {
		z: 1,
		position: { x: 1000, y: 100 },
		rotation: 0,
		scale: 1,
		origin: { x: 0.5, y: 0.5 },
		opacity: 1,
		style: {},
		size: { width: 400, height: 300 },
		type: "frame",
		props: { label: "", clip: true },
	});
	const moved = await readBoard(db, { spaceId, boardId, read: { rect: { x: 1005, y: 115, width: 10, height: 10 } } });
	assert.deepEqual(Object.keys(moved.items ?? {}).sort(), ["f", "s"]);
	const within = await readBoard(db, { spaceId, boardId, read: { within: "f" } });
	assert.deepEqual(Object.keys(within.items ?? {}).sort(), ["f", "s"]);
	const page = await readBoard(db, { spaceId, boardId, read: { limit: 2 } });
	assert.equal(Object.keys(page.items ?? {}).length, 2);
	assert.ok(page.next);
});

test("references, cascade, dry runs, idempotency and version checks", async () => {
	const { db, boardId } = await board({
		items: {
			a: { type: "shape", size: { width: 100, height: 100 } },
			b: { type: "shape", position: { x: 300, y: 0 }, size: { width: 100, height: 100 } },
			l: { type: "arrow", props: { start: { item: "a" }, end: { item: "b" } } },
		},
		animations: { intro: { duration: 1000, tracks: { fade: { target: "a", property: "opacity", keyframes: [{ at: 0, value: 0 }, { at: 1000, value: 1 }] } } } },
	});
	await assert.rejects(
		applyBoard(db, { spaceId, boardId, actorId, apply: { patch: { items: { a: null } } } }),
		(error: unknown) => error instanceof BoardError && error.status === 409 && error.code === "ITEM_REFERENCED",
	);
	const dry = await applyBoard(db, { spaceId, boardId, actorId, apply: { patch: { items: { a: null } }, cascade: true, dryRun: true } });
	assert.equal(dry.result.status, "validated");
	assert.equal((await readBoard(db, { spaceId, boardId })).version, 1);

	const deleted = await applyBoard(db, { spaceId, boardId, actorId, apply: { patch: { items: { a: null } }, cascade: true, mutationId: "m1" } });
	assert.equal(deleted.result.status, "applied");
	const after = await readBoard(db, { spaceId, boardId });
	assert.equal(after.items?.a, undefined);
	assert.deepEqual(after.items?.l?.props, {
		start: { x: 100, y: 50 },
		end: { item: "b", anchor: "auto" },
		route: "straight",
		bend: 0,
		waypoints: [],
		arrowStart: false,
		arrowEnd: true,
		label: "",
		fontSize: 14,
	});
	assert.deepEqual(after.animations?.intro?.tracks, {});

	const replayed = await applyBoard(db, { spaceId, boardId, actorId, apply: { patch: { items: { a: null } }, cascade: true, mutationId: "m1" } });
	assert.equal(replayed.result.replayed, true);
	assert.equal(replayed.result.version, deleted.result.version);

	await assert.rejects(
		applyBoard(db, { spaceId, boardId, actorId, apply: { patch: { items: { b: { position: { x: 1 } } } }, baseVersion: 1 } }),
		(error: unknown) => error instanceof BoardError && error.code === "VERSION_CONFLICT",
	);
	const unchanged = await applyBoard(db, { spaceId, boardId, actorId, apply: { patch: { items: { b: { position: { x: 300 } } } } } });
	assert.equal(unchanged.result.status, "unchanged");
});

test("a cursor cannot page a spatial read", async () => {
	const { db, boardId } = await board({ items: { f: { type: "frame", size: { width: 400, height: 300 } }, s: { type: "shape", parent: "f" } } });
	await assert.rejects(
		readBoard(db, { spaceId, boardId, read: { rect: { x: 0, y: 0, width: 10, height: 10 }, cursor: "f" } }),
		(error: unknown) => error instanceof Error && /cursor pages by id/.test(error.message),
	);
});

test("replace makes the document equal to the input", async () => {
	const { db, boardId } = await board({ items: { a: { type: "shape" }, b: { type: "text", props: { text: "x" } } } });
	await applyBoard(db, { spaceId, boardId, actorId, apply: { patch: { items: { b: { type: "text", props: { text: "y" } }, c: { type: "frame" } } }, replace: true } });
	const read = await readBoard(db, { spaceId, boardId });
	assert.deepEqual(Object.keys(read.items ?? {}).sort(), ["b", "c"]);
	assert.equal(read.items?.b?.type === "text" && (read.items.b.props as { text: string }).text, "y");
});

test("history records before/after and restores an earlier version", async () => {
	const { db, boardId } = await board({ items: { t: { type: "text", props: { text: "one" } } } });
	await applyBoard(db, { spaceId, boardId, actorId, apply: { patch: { items: { t: { props: { text: "two" } }, u: { type: "shape" } } } } });
	await applyBoard(db, { spaceId, boardId, actorId, apply: { patch: { items: { t: null } } } });
	const history = await readBoardHistory(db, { spaceId, boardId });
	assert.deepEqual(history.transactions.map((entry) => entry.version), [3, 2, 1]);
	assert.deepEqual(history.transactions[0]?.before?.items?.t, {
		z: 1,
		position: { x: 0, y: 0 },
		rotation: 0,
		scale: 1,
		origin: { x: 0.5, y: 0.5 },
		opacity: 1,
		style: {},
		type: "text",
		props: { text: "two", fontSize: 24, fontWeight: 500, font: "sans", align: "left", lineHeight: 1.3333333333333333, reveal: 1 },
	});
	await restoreBoardVersion(db, { spaceId, boardId, actorId, version: 1 });
	const read = await readBoard(db, { spaceId, boardId });
	assert.deepEqual(Object.keys(read.items ?? {}), ["t"]);
	assert.equal(read.items?.t?.type === "text" && (read.items.t.props as { text: string }).text, "one");
});

test("shared playback follows the clock and stops when its timeline changes", async () => {
	const { db, boardId } = await board({
		items: { t: { type: "text", props: { text: "x" } } },
		animations: { intro: { duration: 1000, markers: [{ at: 500, pause: true }], tracks: { fade: { target: "t", property: "opacity", keyframes: [{ at: 0, value: 0 }] } } } },
	});
	const playing = await applyBoardPlayback(db, { spaceId, boardId, command: { commandId: "p1", type: "play", animationId: "intro" } });
	assert.equal(playing?.status, "playing");
	const again = await applyBoardPlayback(db, { spaceId, boardId, command: { commandId: "p1", type: "play", animationId: "intro" } });
	assert.equal(again?.playbackId, playing?.playbackId);
	const outcome = await applyBoard(db, { spaceId, boardId, actorId, apply: { patch: { animations: { intro: { duration: 2000 } } } } });
	assert.equal(outcome.written?.playback?.status, "stopped");
	const stopped = await applyBoardPlayback(db, { spaceId, boardId, command: { commandId: "p2", type: "stop" } });
	assert.equal(stopped, null);
});

test("snapshots capture the document", async () => {
	const { db, boardId } = await board({ board: { background: { kind: "grid" } }, items: { t: { type: "text", props: { text: "x" } } } });
	const [snapshot] = await captureBoardSnapshots(db, { spaceId, boardIds: [boardId] });
	assert.equal(snapshot?.boardVersion, 1);
	const parsed = parseBoardDocument(snapshot);
	assert.ok(parsed.ok);
	assert.equal(parsed.ok && parsed.document.board.background.kind, "grid");
});

test("non-geometric edits persist and agree with history and realtime", async () => {
	const { db, boardId } = await board({ items: { s: { type: "shape" } } });
	for (const patch of [{ style: { fill: "blue" } }, { opacity: 0.5 }, { locked: true }, { z: 42 }, { metadata: { original: "retained" } }]) {
		const outcome = await applyBoard(db, { spaceId, boardId, actorId, apply: { patch: { items: { s: patch } } } });
		const read = await readBoard(db, { spaceId, boardId });
		const history = await readBoardHistory(db, { spaceId, boardId });
		assert.deepEqual(read.items?.s, outcome.written?.after.items?.s);
		assert.deepEqual(read.items?.s, history.transactions[0]?.after?.items?.s);
		assert.equal(read.version, outcome.result.version);
	}
});

test("partial arrow and track patches load inherited references", async () => {
	const { db, boardId } = await board({
		items: { a: { type: "shape" }, b: { type: "shape", position: { x: 500, y: 0 } }, arrow: { type: "arrow", props: { start: { item: "a" }, end: { item: "b" } } } },
		animations: { intro: { duration: 1000, tracks: {
			fade: { target: "a", property: "opacity", keyframes: [{ at: 0, value: 0 }] },
			focus: { target: "camera", property: "focus", keyframes: [{ at: 0, value: "b" }] },
		} } },
	});
	await applyBoard(db, { spaceId, boardId, actorId, apply: { patch: { items: { arrow: { props: { label: "updated" } } } } } });
	await applyBoard(db, { spaceId, boardId, actorId, apply: { patch: { animations: { intro: { tracks: {
		fade: { keyframes: [{ at: 0, value: 0.5 }] }, focus: { interpolation: "step" },
	} } } } } });
	const parsed = parseBoardDocument(await readBoard(db, { spaceId, boardId }));
	assert.ok(parsed.ok);
	assert.equal(parsed.document.items.arrow?.type === "arrow" && parsed.document.items.arrow.props.label, "updated");
	assert.equal(parsed.document.animations.intro?.tracks.fade?.keyframes[0]?.value, 0.5);
});

test("item and animation ids cannot collide across separate writes", async () => {
	const { db, boardId } = await board({ items: { a: { type: "shape" } }, animations: { intro: { duration: 1000 } } });
	for (const patch of [{ items: { intro: { type: "shape" } } }, { animations: { a: { duration: 1000 } } }]) {
		await assert.rejects(applyBoard(db, { spaceId, boardId, actorId, apply: { patch } }), (error: unknown) => error instanceof BoardError && error.code === "ID_CONFLICT");
	}
});

test("deleting through another space cannot remove board data", async () => {
	const { db, boardId } = await board({ items: { a: { type: "shape" } } });
	await assert.rejects(deleteBoard(db, { spaceId: "22222222-2222-4222-8222-222222222222", boardId }), (error: unknown) => error instanceof BoardError && error.status === 404);
	assert.ok((await readBoard(db, { spaceId, boardId })).items?.a);
});

test("type changes preload existing dependents before validation", async () => {
	const { db, boardId } = await board({ items: { f: { type: "frame" }, child: { type: "text", parent: "f" } }, animations: {
		reveal: { duration: 1000, tracks: { text: { target: "child", property: "props.reveal", keyframes: [{ at: 0, value: 0 }] } } },
	} });
	await assert.rejects(applyBoard(db, { spaceId, boardId, actorId, apply: { patch: { items: { f: { type: "shape" } } } } }), /not a frame/);
	await assert.rejects(applyBoard(db, { spaceId, boardId, actorId, apply: { patch: { items: { child: { type: "frame" } } } } }), /props.reveal/);
	assert.ok(parseBoardDocument(await readBoard(db, { spaceId, boardId })).ok);
});

test("deleting a bound target loads the arrow's own ancestors", async () => {
	const { db, boardId } = await board({ items: {
		f: { type: "frame", position: { x: 400, y: 200 } },
		a: { type: "shape" }, b: { type: "shape", position: { x: 1000, y: 0 } },
		arrow: { type: "arrow", parent: "f", props: { start: { item: "a" }, end: { item: "b" } } },
	} });
	await applyBoard(db, { spaceId, boardId, actorId, apply: { patch: { items: { a: null } }, cascade: true } });
	const parsed = parseBoardDocument(await readBoard(db, { spaceId, boardId }));
	assert.ok(parsed.ok);
	assert.equal(parsed.document.items.arrow?.parent, "f");
});

test("moving a bound target refreshes arrow bounds in its parent's world space", async () => {
	const { db, boardId } = await board({ items: {
		f: { type: "frame", position: { x: 400, y: 200 } },
		a: { type: "shape", size: { width: 50, height: 50 } },
		arrow: { type: "arrow", parent: "f", props: { start: { item: "a" }, end: { x: 100, y: 100 } } },
	} });
	await applyBoard(db, { spaceId, boardId, actorId, apply: { patch: { items: { a: { position: { x: 200 } } } } } });
	const nearby = await readBoard(db, { spaceId, boardId, read: { rect: { x: 498, y: 298, width: 4, height: 4 } } });
	assert.ok(nearby.items?.arrow);
});

test("a reparent cannot push unchanged descendants beyond the hierarchy limit", async () => {
	const items = Object.fromEntries(["c", "s"].flatMap((prefix) => Array.from({ length: prefix === "c" ? 60 : 10 }, (_, i) => [
		`${prefix}${i}`, { type: "frame", ...(i ? { parent: `${prefix}${i - 1}` } : {}) },
	])));
	const { db, boardId } = await board({ items });
	await assert.rejects(applyBoard(db, { spaceId, boardId, actorId, apply: { patch: { items: { s0: { parent: "c59" } } } } }), (error: unknown) => error instanceof BoardError && error.code === "PARENT_DEPTH");
	assert.ok(parseBoardDocument(await readBoard(db, { spaceId, boardId })).ok);
});
