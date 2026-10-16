import assert from "node:assert/strict";
import { test } from "node:test";
import type { SessionTurnRecord } from "@cohub/protocol/model";
import { canForkChatMessage } from "../lib/chat-message-fork.ts";
import type { ChatMessage } from "../lib/session-tree.ts";

function message(
	turnOverrides: Partial<SessionTurnRecord> = {},
	messageOverrides: Partial<ChatMessage> = {},
): ChatMessage {
	const turn: SessionTurnRecord = {
		id: "turn-1",
		sessionId: "session-1",
		sequence: 1,
		status: "completed",
		intent: "followup",
		userUuid: null,
		userContent: [{ type: "text", text: "Hello" }],
		userText: "Hello",
		assistantContent: [{ type: "text", text: "World" }],
		assistantText: "World",
		provider: null,
		model: null,
		stopReason: null,
		errorMessage: null,
		finalUsage: null,
		totalUsage: null,
		summary: null,
		intermediateIndex: null,
		intermediateSummary: null,
		meta: { harness: "codex" },
		startedAt: null,
		completedAt: null,
		durationMs: null,
		createdAt: "2026-10-12T00:00:00.000Z",
		updatedAt: "2026-10-12T00:00:00.000Z",
		...turnOverrides,
	};
	return {
		id: "message-1",
		role: "assistant",
		content: turn.assistantContent ?? [],
		text: "World",
		sequence: 1,
		createdAt: turn.createdAt,
		meta: { turn, messageKind: "assistant_final" },
		...messageOverrides,
	};
}

test("settled Codex responses can fork without a Cohub checkpoint", () => {
	for (const [status, kind] of [
		["completed", "assistant_final"],
		["failed", "assistant_error"],
		["interrupted", "assistant_interrupted"],
	] as const) {
		const response = message({ status });
		response.meta = { ...response.meta, messageKind: kind };
		assert.equal(canForkChatMessage(response), true, status);
	}
});

test("unsettled and unexecuted Codex turns cannot fork even with a checkpoint", () => {
	for (const status of [
		"queued",
		"running",
		"abort_requested",
		"cancelled",
		"merged",
	] as const) {
		assert.equal(
			canForkChatMessage(
				message({
					status,
					meta: { harness: "codex", agentSessionEntryId: "old-checkpoint" },
				}),
			),
			false,
			status,
		);
	}
});

test("only final assistant messages can fork", () => {
	for (const role of ["user", "system"] as const) {
		assert.equal(canForkChatMessage(message({}, { role })), false, role);
	}
	for (const kind of [
		"assistant_streaming_preview",
		"turn_user",
		"assistant_intermediate",
		null,
	]) {
		const response = message();
		response.meta = { ...response.meta, messageKind: kind };
		assert.equal(canForkChatMessage(response), false, String(kind));
	}
	const streaming = message();
	streaming.meta = { ...streaming.meta, streaming: true };
	assert.equal(canForkChatMessage(streaming), false);
	assert.equal(canForkChatMessage(message({}, { meta: undefined })), false);
});

test("Cohub checkpoint and direct generation support is retained", () => {
	for (const meta of [
		{ agentSessionEntryId: "checkpoint" },
		{ agent: { leafEntryId: "checkpoint" } },
	]) {
		assert.equal(canForkChatMessage(message({ meta })), true);
		assert.equal(canForkChatMessage(message({ meta, status: "merged" })), true);
	}
	for (const status of [
		"completed",
		"failed",
		"interrupted",
		"cancelled",
	] as const) {
		assert.equal(
			canForkChatMessage(
				message({ status, executionKind: "direct_generation", meta: {} }),
			),
			true,
			status,
		);
	}
	assert.equal(canForkChatMessage(message({ meta: {} })), false);
	assert.equal(canForkChatMessage(message({ meta: { harness: "pi" } })), false);
	assert.equal(canForkChatMessage(message({ meta: { agent: [] } })), false);
});
