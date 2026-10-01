import assert from "node:assert/strict";
import { test } from "node:test";
import { readSessionTurnOrigin, type SessionTurnOrigin, type SessionTurnRecord } from "@cohub/protocol/model";
import { turnToUserMessage } from "../lib/session-turn-render.ts";
import { mergeTurnsById } from "../lib/stores/turn-cache.ts";

const origin: SessionTurnOrigin = {
	kind: "prompt",
	spaceId: "11111111-1111-4111-8111-111111111111",
	sessionId: "22222222-2222-4222-8222-222222222222",
	turnId: "33333333-3333-4333-8333-333333333333",
	toolCallId: "call_review",
	depth: 1,
};

const turn: SessionTurnRecord = {
	id: "44444444-4444-4444-8444-444444444444",
	sessionId: "55555555-5555-4555-8555-555555555555",
	sequence: 1,
	status: "queued",
	intent: "followup",
	userUuid: null,
	userContent: [{ type: "text", text: "Review changes" }],
	userText: "Review changes",
	assistantContent: null,
	assistantText: null,
	provider: null,
	model: null,
	stopReason: null,
	errorMessage: null,
	finalUsage: null,
	totalUsage: null,
	summary: null,
	intermediateIndex: null,
	intermediateSummary: null,
	meta: { origin, source: "cli" },
	startedAt: null,
	completedAt: null,
	durationMs: null,
	createdAt: "2026-09-30T00:00:00.000Z",
	updatedAt: "2026-09-30T00:00:00.000Z",
};

test("server origin survives cache cloning, refresh and timeline projection without extra fetching", () => {
	const cached = structuredClone(turn);
	const [updated] = mergeTurnsById([cached], [{ ...turn, status: "completed", updatedAt: "2026-09-30T00:01:00.000Z" }]);
	assert.ok(updated);
	const message = turnToUserMessage(updated);
	assert.deepEqual(readSessionTurnOrigin(message.meta?.turn?.meta), origin);
	assert.equal(message.meta?.turn?.meta?.source, "cli");
});

test("late queued events do not replace a completed turn or its origin", () => {
	const completed: SessionTurnRecord = { ...turn, status: "completed", updatedAt: "2026-09-30T00:01:00.000Z" };
	const [updated] = mergeTurnsById([completed], [turn]);
	assert.equal(updated?.status, "completed");
	assert.deepEqual(readSessionTurnOrigin(updated?.meta), origin);
});
