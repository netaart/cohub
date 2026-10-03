import assert from "node:assert/strict";
import { test } from "node:test";
import type { SessionTurnRecord } from "@cohub/protocol/model";
import {
	buildSentTurnIndex,
	sentTurnForToolCall,
	sentTurnsForTurn,
} from "../lib/sent-turns.ts";
import { mergeTurnsById } from "../lib/stores/turn-cache.ts";

const SPACE = "11111111-1111-4111-8111-111111111111";
const CALLER_SESSION = "22222222-2222-4222-8222-222222222222";
const CALLER_TURN = "33333333-3333-4333-8333-333333333333";
const CHILD_SESSION = "44444444-4444-4444-8444-444444444444";
const CHILD_TURN = "55555555-5555-4555-8555-555555555555";
const TOOL_CALL = "call_review";

const callerTurn: SessionTurnRecord = {
	id: CALLER_TURN,
	sessionId: CALLER_SESSION,
	sequence: 1,
	status: "completed",
	intent: "followup",
	userUuid: null,
	userContent: [{ type: "text", text: "spawn a reviewer" }],
	userText: "spawn a reviewer",
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
	meta: {
		messagesSent: [
			{ sessionId: CHILD_SESSION, turnId: CHILD_TURN, kind: "prompt" },
		],
	},
	startedAt: null,
	completedAt: null,
	durationMs: null,
	createdAt: "2026-09-30T00:00:00.000Z",
	updatedAt: "2026-09-30T00:00:00.000Z",
};

const childTurn: SessionTurnRecord = {
	...callerTurn,
	id: CHILD_TURN,
	sessionId: CHILD_SESSION,
	meta: {
		origin: {
			kind: "prompt",
			spaceId: SPACE,
			sessionId: CALLER_SESSION,
			turnId: CALLER_TURN,
			toolCallId: TOOL_CALL,
			depth: 1,
		},
	},
};

test("fan-out and tool-call lookups project from the loaded Turns alone", () => {
	const index = buildSentTurnIndex([callerTurn, childTurn], SPACE);
	assert.equal(sentTurnsForTurn(index, callerTurn).length, 1);
	assert.equal(sentTurnsForTurn(index, callerTurn)[0]?.turnId, CHILD_TURN);
	// The child's own origin names the tool call that sent it.
	assert.equal(sentTurnForToolCall(index, TOOL_CALL)?.turnId, CHILD_TURN);
	assert.equal(sentTurnForToolCall(index, "call_unknown"), null);
});

test("a Turn that sent nothing contributes no links", () => {
	const plain: SessionTurnRecord = { ...callerTurn, meta: { source: "web" } };
	const index = buildSentTurnIndex([plain, childTurn], SPACE);
	assert.deepEqual(sentTurnsForTurn(index, plain), []);
	assert.equal(sentTurnForToolCall(index, TOOL_CALL), null);
	assert.deepEqual(buildSentTurnIndex([callerTurn, childTurn], null).links, []);
});

test("fan-out survives a cache refresh and a late queued event", () => {
	const refreshed = mergeTurnsById(
		[structuredClone(callerTurn)],
		[{ ...callerTurn, updatedAt: "2026-09-30T00:02:00.000Z" }],
	);
	assert.equal(buildSentTurnIndex(refreshed, SPACE).links.length, 1);
	const late = mergeTurnsById(refreshed, [{ ...callerTurn, status: "queued" }]);
	assert.equal(buildSentTurnIndex(late, SPACE).links.length, 1);
});
