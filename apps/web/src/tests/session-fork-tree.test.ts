import assert from "node:assert/strict";
import { test } from "node:test";
import type { SessionRecord } from "@neta-art/cohub";
import {
	buildSessionForkTree,
	type SessionForkEdge,
} from "../lib/session-fork-tree.ts";

const session = (id: string, minute: number) =>
	({
		id,
		title: id,
		lastMessageAt: new Date(Date.UTC(2026, 0, 1, 0, minute)).toISOString(),
	}) as unknown as SessionRecord;
const edge = (childSessionId: string, parentSessionId: string) =>
	({ childSessionId, parentSessionId }) satisfies SessionForkEdge;

type Row = ReturnType<typeof buildSessionForkTree>[number];
const view = (rows: Row[]) =>
	rows.map(({ session, tree }) => [
		session.id,
		tree.depth,
		tree.last,
		tree.hasChildren,
		tree.rails,
	]);

const ids = ["r0", "r1", "r2", "r3", "r4", "r5", "r6", "r7"];
const chain = ids.map((id, i) => session(id, i));
const chainForks = ids.slice(1).map((id, i) => edge(id, ids[i]));

test("rows past the depth cap flatten newest first", () => {
	const rows = buildSessionForkTree(
		[...chain, session("s4", 6), session("t5", 9)],
		[...chainForks, edge("s4", "r3"), edge("t5", "s4")],
	);
	assert.deepEqual(view(rows), [
		["r0", 0, true, true, []],
		["r1", 1, true, true, []],
		["r2", 2, true, true, []],
		["r3", 3, true, true, []],
		["t5", 4, false, false, []],
		["r7", 4, false, false, []],
		["s4", 4, false, false, []],
		["r6", 4, false, false, []],
		["r5", 4, false, false, []],
		["r4", 4, true, false, []],
	]);
});
