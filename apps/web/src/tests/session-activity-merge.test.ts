import assert from "node:assert/strict";
import { test } from "node:test";
import type { SessionRecord, SessionTurnRecord } from "@neta-art/cohub";
import { mergeSessionRecord } from "../lib/session-record-merge.ts";
import { mergeSessionTurnState } from "../lib/session-turn-state.ts";

const session: SessionRecord = {
	id: "session",
	spaceId: "space",
	userUuid: "user",
	title: "Title",
	source: "web",
	status: "active",
	externalSessionId: null,
	latestMessageText: "Saved message",
	lastMessageAt: null,
	lastMessageId: null,
	createdAt: "2026-10-01T00:00:00Z",
	updatedAt: "2026-10-01T00:00:00Z",
	meta: { custom: "keep" },
};
const turn = (
	sequence: number,
	status: SessionTurnRecord["status"],
): Partial<SessionTurnRecord> => ({
	id: `turn-${sequence}`,
	sessionId: "session",
	sequence,
	status,
	provider: null,
	model: null,
	startedAt: null,
});
const active = (
	session: SessionRecord,
	sequence: number,
	status: "queued" | "running" | "abort_requested",
	updatedAt?: string,
) =>
	mergeSessionRecord(session, {
		...session,
		activeTurnSequence: sequence,
		activeTurn: {
			id: `turn-${sequence}`,
			sequence,
			status,
			provider: null,
			model: null,
			startedAt: null,
			updatedAt: updatedAt ?? null,
			anchorUserMessageId: null,
		},
		lastTurnIssue: null,
	});

test("Turn updates keep title, metadata, and preview intact", () => {
	const running = mergeSessionTurnState(session, turn(1, "running"));
	assert.equal(running.title, session.title);
	assert.equal(running.latestMessageText, session.latestMessageText);
	assert.deepEqual(running.meta, session.meta);
	assert.equal(running.activeTurn?.status, "running");
});

test("a queued follow-up never replaces the running Turn", () => {
	const running = mergeSessionTurnState(session, turn(1, "running"));
	assert.equal(mergeSessionTurnState(running, turn(2, "queued")), running);
});

test("a settled Turn is not revived by a late live event", () => {
	const settled = active(session, 1, "running");
	const ended = mergeSessionTurnState(settled, turn(1, "completed"));
	assert.equal(ended.activeTurn, null);
	assert.equal(
		mergeSessionTurnState(ended, turn(1, "running")).activeTurn,
		null,
	);
	assert.equal(
		mergeSessionTurnState(ended, turn(2, "running")).activeTurn?.id,
		"turn-2",
	);
});

test("a steer rollback is honored", () => {
	const stopping = mergeSessionTurnState(
		mergeSessionTurnState(session, turn(1, "running")),
		turn(1, "abort_requested"),
	);
	assert.equal(stopping.activeTurn?.status, "abort_requested");
	assert.equal(
		mergeSessionTurnState(stopping, turn(1, "running")).activeTurn?.status,
		"running",
	);
});

test("a late snapshot cannot regress a newer Turn update", () => {
	const live = mergeSessionTurnState(session, {
		...turn(2, "running"),
		updatedAt: "2026-10-01T00:00:10.000Z",
	});
	assert.equal(live.activeTurn?.id, "turn-2");
	assert.equal(
		active(live, 1, "running", "2026-10-01T00:00:01.000Z").activeTurn?.id,
		"turn-2",
	);
});

test("parallel direct generation does not hide the running Agent Turn", () => {
	const agent = mergeSessionTurnState(session, turn(1, "running"));
	assert.equal(mergeSessionTurnState(agent, turn(2, "running")), agent);
	assert.equal(
		mergeSessionTurnState(agent, turn(1, "completed")).activeTurn,
		null,
	);
});
