import assert from "node:assert/strict";
import { test } from "node:test";
import type { ContentBlock } from "@cohub/protocol/core";
import type { SessionFileRecord } from "@cohub/protocol/model";
import type { TaskRunRecord } from "@neta-art/cohub";
import {
	extractLiveFileChanges,
	type LiveFileChange,
	mergeSessionFiles,
	mergeTaskRunPage,
	pruneCoveredLiveChanges,
	upsertTaskRuns,
	workspacePathFromToolPath,
} from "../lib/features/space/side-panel/side-panel-data.ts";

const SPACE = "11111111-1111-4111-8111-111111111111";

function run(
	id: string,
	createdAt: string,
	overrides: Partial<TaskRunRecord> = {},
): TaskRunRecord {
	return {
		id,
		jobId: id,
		cronJobId: null,
		taskType: "generation",
		status: "completed",
		payload: null,
		result: null,
		errorMessage: null,
		attemptCount: 1,
		spaceId: "space",
		sessionId: "session",
		turnId: null,
		userUuid: null,
		scheduledAt: null,
		startedAt: null,
		finishedAt: null,
		createdAt,
		updatedAt: createdAt,
		...overrides,
	};
}

function file(path: string, lastChangedAt: string): SessionFileRecord {
	return {
		path,
		lastKind: "edit",
		kinds: ["edit"],
		changeCount: 1,
		firstChangedAt: lastChangedAt,
		lastChangedAt,
		lastTurnId: "turn",
		lastTurnSequence: 3,
	};
}

const tool = (id: string, name: string, path: string): ContentBlock => ({
	type: "tool_use",
	id,
	name,
	input: { path: `/workspace/${path}` },
});

const cursorAt = (createdAt: string, id: string) => `${createdAt}|${id}`;

test("the first page covers from the top through its last row", () => {
	const current = [
		run("new", "2026-09-01T00:00:09Z"),
		run("a", "2026-09-01T00:00:05Z"),
		run("gone", "2026-09-01T00:00:04Z"),
		run("older", "2026-09-01T00:00:01Z"),
	];
	const page = [
		run("a", "2026-09-01T00:00:05Z", { status: "failed" }),
		run("b", "2026-09-01T00:00:03Z"),
	];
	const first = mergeTaskRunPage(current, page, {
		cursor: null,
		complete: false,
		keepIds: new Set(["new"]),
	});
	assert.deepEqual(
		first.runs.map((item) => [item.id, item.status]),
		[
			["new", "completed"],
			["a", "failed"],
			["b", "completed"],
			["older", "completed"],
		],
		"rows past the page stay; realtime arrivals survive",
	);
	assert.deepEqual(first.removedIds, ["gone"]);

	const complete = mergeTaskRunPage(current, page, {
		cursor: null,
		complete: true,
	});
	assert.deepEqual(
		complete.runs.map((item) => item.id),
		["a", "b"],
	);
	assert.deepEqual(complete.removedIds, ["new", "gone", "older"]);
});

test("rows on a boundary millisecond are kept", () => {
	const at = "2026-09-01T00:00:05Z";
	const current = [
		run("c", at),
		run("b", at),
		run("a", at),
		run("z", "2026-09-01T00:00:09Z"),
	];
	assert.deepEqual(
		mergeTaskRunPage(current, [run("c", at), run("b", at)], {
			cursor: null,
			complete: false,
		}).removedIds,
		["z"],
		"`a` may belong to the next page",
	);
	assert.deepEqual(
		mergeTaskRunPage(current, [], { cursor: cursorAt(at, "b"), complete: true })
			.removedIds,
		[],
		"rows sharing the cursor millisecond may belong to the previous page",
	);
});

test("a later page covers the span below the cursor it was requested with", () => {
	const current = [
		run("p1", "2026-09-01T00:00:05Z"),
		run("gap", "2026-09-01T00:00:03Z"),
		run("n1", "2026-09-01T00:00:01Z"),
		run("beyond", "2026-09-01T00:00:00Z"),
	];
	const cursor = cursorAt("2026-09-01T00:00:05.000Z", "p1");
	const next = mergeTaskRunPage(current, [run("n1", "2026-09-01T00:00:01Z")], {
		cursor,
		complete: false,
	});
	assert.deepEqual(next.removedIds, ["gap"], "rows above the cursor stay");
	assert.deepEqual(
		mergeTaskRunPage(current, [], { cursor, complete: true }).removedIds,
		["gap", "n1", "beyond"],
		"an empty last page ends the list",
	);
	assert.deepEqual(
		mergeTaskRunPage(current, [], { cursor: "not-a-cursor", complete: true })
			.removedIds,
		[],
		"an unreadable cursor covers nothing",
	);
});

test("an older snapshot never replaces a newer row", () => {
	const completed = run("a", "2026-09-01T00:00:00Z", {
		status: "completed",
		updatedAt: "2026-09-01T00:00:09Z",
	});
	const staleListRow = run("a", "2026-09-01T00:00:00Z", {
		status: "running",
		updatedAt: "2026-09-01T00:00:02Z",
		payload: { data: { model: "m" } },
	});
	const merged = mergeTaskRunPage([completed], [staleListRow], {
		cursor: null,
		complete: true,
		keepIds: new Set(["a"]),
	});
	assert.equal(
		merged.runs[0]?.status,
		"completed",
		"a late list response loses",
	);

	const fullRow = { ...completed, payload: { data: { model: "m" } } };
	const byId = upsertTaskRuns(new Map([["a", completed]]), [fullRow]);
	assert.deepEqual(
		byId.get("a")?.payload,
		{ data: { model: "m" } },
		"same time: the full row wins",
	);
});

test("tool paths resolve against the Sandbox workspace", () => {
	assert.equal(workspacePathFromToolPath("/workspace/src/a.ts"), "src/a.ts");
	assert.equal(workspacePathFromToolPath("src/./lib/../a.ts"), "src/a.ts");
	assert.equal(workspacePathFromToolPath("/workspace"), null);
	assert.equal(workspacePathFromToolPath("/tmp/a.ts"), null);
	assert.equal(workspacePathFromToolPath("../outside.ts"), null);
	assert.equal(workspacePathFromToolPath(42), null);
	assert.equal(
		workspacePathFromToolPath(`/workspace/${"a".repeat(1024)}`),
		null,
	);
});

test("live changes are active only while their round streams without a result", () => {
	const live = extractLiveFileChanges({
		spaceId: SPACE,
		liveBlocks: [
			tool("t2", "edit", "src/b.ts"),
			tool("t3", "read", "src/c.ts"),
		],
		archivedBlocks: [tool("t1", "write", "src/a.ts")],
		streaming: true,
		turnId: "turn",
		previous: new Map(),
		now: 1_000,
	});
	assert.deepEqual(
		[...live.values()].map((change) => [
			change.path,
			change.kind,
			change.active,
		]),
		[
			["src/a.ts", "write", false],
			["src/b.ts", "edit", true],
		],
	);

	const done = extractLiveFileChanges({
		spaceId: SPACE,
		liveBlocks: [
			tool("t2", "edit", "src/b.ts"),
			{ type: "tool_result", tool_use_id: "t2", content: "ok" },
		],
		archivedBlocks: [],
		streaming: true,
		turnId: "turn",
		previous: live,
		now: 5_000,
	});
	assert.equal(done.get("src/b.ts")?.active, false);
	assert.equal(
		done.get("src/b.ts")?.at,
		1_000,
		"first observation time is kept",
	);

	const stopped = extractLiveFileChanges({
		spaceId: SPACE,
		liveBlocks: [],
		archivedBlocks: [],
		streaming: false,
		turnId: null,
		previous: live,
		now: 9_000,
	});
	assert.equal(stopped.get("src/b.ts")?.active, false);
});

test("live changes overlay the server list until their turn is indexed", () => {
	const change = (
		path: string,
		turnId: string | null,
		active = false,
	): LiveFileChange => ({
		path,
		kind: "edit",
		at: Date.parse("2026-09-01T00:10:00Z"),
		turnId,
		active,
	});
	const live = new Map([
		["same-turn.ts", change("same-turn.ts", "turn-live")],
		// The prior turn's record landing late must not hide this turn's change.
		["prior-turn.ts", change("prior-turn.ts", "turn-live")],
		["running.ts", change("running.ts", "turn-live", true)],
		["no-turn.ts", change("no-turn.ts", null)],
	]);
	const server = [
		{
			...file("same-turn.ts", "2026-09-01T00:09:59Z"),
			lastTurnId: "turn-live",
			lastTurnSequence: 5,
		},
		{
			...file("prior-turn.ts", "2026-09-01T00:12:00Z"),
			lastTurnId: "turn-prior",
		},
		{ ...file("running.ts", "2026-09-01T00:09:00Z"), lastTurnId: "turn-live" },
		// Later end time but an earlier turn: records follow turn order.
		{ ...file("no-turn.ts", "2026-09-01T00:11:00Z"), lastTurnId: "turn-prior" },
	];
	assert.deepEqual([...pruneCoveredLiveChanges(live, server).keys()].sort(), [
		"prior-turn.ts",
		"running.ts",
	]);
	assert.deepEqual(
		mergeSessionFiles(server, live).map((entry) => [
			entry.path,
			entry.live,
			entry.active,
		]),
		[
			["prior-turn.ts", true, false],
			["running.ts", true, true],
			["same-turn.ts", false, false],
			["no-turn.ts", false, false],
		],
	);
});
