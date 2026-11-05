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

// a ─┬─ b ── c (c is the newest row overall)
//    └─ d
// e
const sessions = [
	session("a", 1),
	session("b", 2),
	session("c", 9),
	session("d", 3, true),
	session("e", 5),
];
const forks = [edge("b", "a"), edge("c", "b"), edge("d", "a")];
const view = (rows: ReturnType<typeof buildSessionForkTree>) =>
	rows.map(({ session, tree, fold }) => ({
		id: session.id,
		...tree,
		...(fold && { fold }),
	}));

test("without fold options the tree is unchanged", () => {
	assert.deepEqual(
		buildSessionForkTree(sessions, forks).map((row) => [
			row.session.id,
			row.tree.depth,
			"fold" in row,
		]),
		[
			["a", 0, false],
			["b", 1, false],
			["c", 2, false],
			["d", 1, false],
			["e", 0, false],
		],
	);
});

test("collapsing hides the whole subtree and keeps group order", () => {
	const rows = buildSessionForkTree(sessions, forks, {
		collapsed: new Set(["a"]),
		unread: (row) => row.id === "c",
	});
	assert.deepEqual(view(rows), [
		{
			id: "a",
			depth: 0,
			last: false,
			hasChildren: false,
			rails: [],
			fold: { expanded: false, hidden: 3, hiddenUnread: 1 },
		},
		{ id: "e", depth: 0, last: true, hasChildren: false, rails: [] },
	]);
});

test("kept forks stay under the collapsed row with recomputed rails", () => {
	const rows = buildSessionForkTree(sessions, forks, {
		collapsed: new Set(["a"]),
		keep: (row) => row.activeTurn != null,
	});
	assert.deepEqual(view(rows).slice(0, 2), [
		{
			id: "a",
			depth: 0,
			last: false,
			hasChildren: true,
			rails: [],
			fold: { expanded: false, hidden: 2, hiddenUnread: 0 },
		},
		{ id: "d", depth: 1, last: true, hasChildren: false, rails: [] },
	]);
});

test("collapsing a nested fork recomputes last and rails for visible rows", () => {
	const rows = buildSessionForkTree(sessions, forks, {
		collapsed: new Set(["b"]),
	});
	assert.deepEqual(view(rows).slice(0, 3), [
		{
			id: "a",
			depth: 0,
			last: false,
			hasChildren: true,
			rails: [],
			fold: { expanded: true, hidden: 0, hiddenUnread: 0 },
		},
		{
			id: "b",
			depth: 1,
			last: false,
			hasChildren: false,
			rails: [],
			fold: { expanded: false, hidden: 1, hiddenUnread: 0 },
		},
		{ id: "d", depth: 1, last: true, hasChildren: false, rails: [] },
	]);
});

test("deep chains fold below the depth cap and keep running descendants", () => {
	const ids = ["r0", "r1", "r2", "r3", "r4", "r5", "r6", "r7"];
	const chain = ids.map((id, i) => session(id, i, id === "r7"));
	const chainForks = ids.slice(1).map((id, i) => edge(id, ids[i]));
	const rows = buildSessionForkTree(chain, chainForks, {
		collapsed: new Set(["r5"]),
		keep: (row) => row.activeTurn != null,
	});
	assert.deepEqual(
		rows.map(({ session, tree, fold }) => [
			session.id,
			tree.depth,
			tree.hasChildren,
			fold?.hidden ?? null,
		]),
		[
			["r0", 0, true, 0],
			["r1", 1, true, 0],
			["r2", 2, true, 0],
			["r3", 3, true, 0],
			["r4", 4, false, 0],
			["r5", 4, false, 1],
			["r7", 4, false, null],
		],
	);
});
