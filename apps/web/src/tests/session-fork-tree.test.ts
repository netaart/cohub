import assert from "node:assert/strict";
import { test } from "node:test";
import type { SessionRecord } from "@neta-art/cohub";
import {
	buildSessionForkTree,
	type SessionForkEdge,
} from "../lib/session-fork-tree.ts";

const session = (id: string, minute: number, running = false) =>
	({
		id,
		title: id,
		lastMessageAt: new Date(Date.UTC(2026, 0, 1, 0, minute)).toISOString(),
		activeTurn: running ? { status: "running" } : null,
	}) as unknown as SessionRecord;
const edge = (childSessionId: string, parentSessionId: string) =>
	({ childSessionId, parentSessionId }) satisfies SessionForkEdge;

// Display order: p, f1, g1, f2, f3, h, f4, f5, e
// p ─┬─ f1 ── g1
//    ├─ f2
//    ├─ f3 ── h (running)
//    ├─ f4 (running)
//    └─ f5
// e
const sessions = [
	session("p", 0),
	session("f1", 10),
	session("g1", 20),
	session("f2", 18),
	session("f3", 5),
	session("h", 16, true),
	session("f4", 14, true),
	session("f5", 12),
	session("e", 1),
];
const forks = [
	edge("f1", "p"),
	edge("g1", "f1"),
	edge("f2", "p"),
	edge("f3", "p"),
	edge("h", "f3"),
	edge("f4", "p"),
	edge("f5", "p"),
];
const running = (row: SessionRecord) => row.activeTurn != null;
type Row = ReturnType<typeof buildSessionForkTree>[number];
const view = (rows: Row[]) =>
	rows.map(({ session, tree, fold }) => [
		session.id,
		tree.depth,
		tree.last,
		tree.hasChildren,
		tree.rails,
		fold ? [fold.expanded, fold.hidden, fold.hiddenUnread] : null,
	]);

test("without fold options the tree is unchanged", () => {
	const rows = buildSessionForkTree(sessions, forks);
	assert.deepEqual(
		rows.map((row) => [row.session.id, row.tree.depth, "fold" in row]),
		[
			["p", 0, false],
			["f1", 1, false],
			["g1", 2, false],
			["f2", 1, false],
			["f3", 1, false],
			["h", 2, false],
			["f4", 1, false],
			["f5", 1, false],
			["e", 0, false],
		],
	);
});

test("expanded groups keep every row; small groups get no fold", () => {
	const rows = buildSessionForkTree(sessions, forks, {
		collapsed: new Set(["f1"]),
	});
	assert.equal(rows.length, sessions.length);
	assert.deepEqual(
		rows.flatMap((row) => (row.fold ? [[row.session.id, row.fold]] : [])),
		[["p", { expanded: true, hidden: 0, hiddenUnread: 0 }]],
	);
});

test("a collapsed group keeps its first three rows and counts the rest", () => {
	const rows = buildSessionForkTree(sessions, forks, {
		collapsed: new Set(["p"]),
		unread: (row) => row.id === "f5" || row.id === "h",
	});
	assert.deepEqual(view(rows), [
		["p", 0, false, true, [], [false, 4, 2]],
		["f1", 1, false, true, [], null],
		["g1", 2, true, false, [1], null],
		["f2", 1, true, false, [], null],
		["e", 0, true, false, [], null],
	]);
});

test("running and kept rows stay visible past the first three", () => {
	const rows = buildSessionForkTree(sessions, forks, {
		collapsed: new Set(["p"]),
		keep: (row) => running(row) || row.id === "f5",
		unread: (row) => row.id === "f3",
	});
	assert.deepEqual(view(rows), [
		["p", 0, false, true, [], [false, 1, 1]],
		["f1", 1, false, true, [], null],
		["g1", 2, true, false, [1], null],
		["f2", 1, false, false, [], null],
		["h", 1, false, false, [], null],
		["f4", 1, false, false, [], null],
		["f5", 1, true, false, [], null],
		["e", 0, true, false, [], null],
	]);
});

test("deep chains keep the first rows and stay under the depth cap", () => {
	const ids = ["r0", "r1", "r2", "r3", "r4", "r5", "r6", "r7"];
	const chain = ids.map((id, i) => session(id, i, id === "r7"));
	const chainForks = ids.slice(1).map((id, i) => edge(id, ids[i]));
	const rows = buildSessionForkTree(chain, chainForks, {
		collapsed: new Set(["r1"]),
		keep: running,
	});
	assert.deepEqual(
		rows.map(({ session, tree, fold }) => [
			session.id,
			tree.depth,
			fold?.hidden ?? null,
		]),
		[
			["r0", 0, 0],
			["r1", 1, 2],
			["r2", 2, null],
			["r3", 3, null],
			["r4", 4, null],
			["r7", 4, null],
		],
	);
});
