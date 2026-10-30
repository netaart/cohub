import assert from "node:assert/strict";
import { test } from "node:test";
import type { ContentBlock } from "@cohub/protocol/core";
import {
	isArchivedMessageIdentity,
	isSameLiveMessage,
	shouldPreserveLivePreviewOnArchive,
} from "../lib/session-generation-stream-guards";

/**
 * Integration-style pure scenarios for intermediate archive + stale guards.
 * Uses the shared production helpers (not a hand-copied mirror).
 */

type StreamingIntermediateMessage = {
	id?: string;
	messageId?: string | null;
	messageOrdinal?: number | null;
	content: ContentBlock[];
};

type GenerationState = {
	status: string;
	contentBlocks: ContentBlock[];
	intermediateMessages: StreamingIntermediateMessage[];
	streamMessageId: string | null;
	messageOrdinal: number | null;
	patchSeq: number;
	turnId: string | null;
};

function archiveIntermediateRound(
	current: GenerationState,
	input: {
		intermediateMessages: StreamingIntermediateMessage[];
		archived?: StreamingIntermediateMessage | null;
		turnId?: string | null;
	},
): GenerationState {
	const archived = input.archived ?? null;
	const previewAlreadyMovedOn = shouldPreserveLivePreviewOnArchive(
		{
			messageOrdinal: current.messageOrdinal,
			streamMessageId: current.streamMessageId,
		},
		archived,
	);
	const status =
		current.status === "idle" || current.status === "pending"
			? "streaming"
			: current.status;

	if (previewAlreadyMovedOn) {
		return {
			...current,
			status,
			intermediateMessages: input.intermediateMessages,
			turnId: input.turnId ?? current.turnId,
		};
	}

	return {
		...current,
		status,
		contentBlocks: [],
		intermediateMessages: input.intermediateMessages,
		streamMessageId: null,
		messageOrdinal: null,
		patchSeq: 0,
		turnId: input.turnId ?? current.turnId,
	};
}

function applyStatePatch(
	current: GenerationState,
	event: {
		turnId: string | null;
		patchSeq: number;
		messageId: string | null;
		messageOrdinal: number | null;
		contentBlocks: ContentBlock[];
		intermediateMessages: StreamingIntermediateMessage[];
	},
): GenerationState | "dropped" {
	const sameTurn = Boolean(
		current.turnId && event.turnId && current.turnId === event.turnId,
	);
	const eventIdentity = {
		messageOrdinal: event.messageOrdinal,
		messageId: event.messageId,
	};
	if (
		sameTurn &&
		isArchivedMessageIdentity(current.intermediateMessages, eventIdentity)
	) {
		return "dropped";
	}
	const sameLiveMessage = isSameLiveMessage(current, eventIdentity);
	if (
		sameTurn &&
		sameLiveMessage &&
		event.patchSeq > 0 &&
		current.patchSeq >= event.patchSeq
	) {
		return "dropped";
	}
	return {
		...current,
		status: "streaming",
		contentBlocks: event.contentBlocks,
		intermediateMessages: event.intermediateMessages,
		streamMessageId: event.messageId,
		messageOrdinal: event.messageOrdinal,
		patchSeq: event.patchSeq,
		turnId: event.turnId ?? current.turnId,
	};
}

const toolBlocks: ContentBlock[] = [
	{
		type: "tool_use",
		id: "tool-1",
		name: "bash",
		input: { command: "pwd" },
	},
	{
		type: "tool_result",
		tool_use_id: "tool-1",
		content: "/workspace",
	},
];

const archivedRound: StreamingIntermediateMessage = {
	id: "msg-intermediate-1",
	messageId: "turn:t1:assistant:0",
	messageOrdinal: 0,
	content: toolBlocks,
};

test("archive clears the same round when persisted and stream ids differ", () => {
	const next = archiveIntermediateRound(
		{
			status: "streaming",
			contentBlocks: toolBlocks,
			intermediateMessages: [],
			streamMessageId: "turn:t1:assistant:0",
			messageOrdinal: 0,
			patchSeq: 4,
			turnId: "t1",
		},
		{
			intermediateMessages: [archivedRound],
			archived: { ...archivedRound, messageId: "db-message-uuid" },
			turnId: "t1",
		},
	);

	assert.deepEqual(next.contentBlocks, []);
	assert.equal(next.streamMessageId, null);
	assert.equal(next.messageOrdinal, null);
	assert.equal(next.patchSeq, 0);
	assert.equal(next.intermediateMessages.length, 1);
});

test("intermediate archive clears live preview and folds tools into history", () => {
	const current: GenerationState = {
		status: "streaming",
		contentBlocks: toolBlocks,
		intermediateMessages: [],
		streamMessageId: "turn:t1:assistant:0",
		messageOrdinal: 0,
		patchSeq: 4,
		turnId: "t1",
	};

	const next = archiveIntermediateRound(current, {
		intermediateMessages: [archivedRound],
		archived: archivedRound,
		turnId: "t1",
	});

	assert.deepEqual(next.contentBlocks, []);
	assert.equal(next.streamMessageId, null);
	assert.equal(next.messageOrdinal, null);
	assert.equal(next.patchSeq, 0);
	assert.equal(next.intermediateMessages.length, 1);
});

test("late intermediate archive preserves next-round identity before first token", () => {
	const current: GenerationState = {
		status: "streaming",
		contentBlocks: [],
		intermediateMessages: [],
		streamMessageId: "turn:t1:assistant:1",
		messageOrdinal: 1,
		patchSeq: 1,
		turnId: "t1",
	};

	const next = archiveIntermediateRound(current, {
		intermediateMessages: [archivedRound],
		archived: archivedRound,
		turnId: "t1",
	});

	assert.equal(next.streamMessageId, "turn:t1:assistant:1");
	assert.equal(next.messageOrdinal, 1);
	assert.equal(next.patchSeq, 1);
	assert.equal(next.intermediateMessages.length, 1);
});

test("late intermediate archive does not wipe next-round thinking preview", () => {
	const current: GenerationState = {
		status: "streaming",
		contentBlocks: [{ type: "thinking", thinking: "next round" }],
		intermediateMessages: [],
		streamMessageId: "turn:t1:assistant:1",
		messageOrdinal: 1,
		patchSeq: 2,
		turnId: "t1",
	};

	const next = archiveIntermediateRound(current, {
		intermediateMessages: [archivedRound],
		archived: archivedRound,
		turnId: "t1",
	});

	assert.equal(next.contentBlocks.length, 1);
	assert.equal(
		(next.contentBlocks[0] as Extract<ContentBlock, { type: "thinking" }>)
			.thinking,
		"next round",
	);
	assert.equal(next.streamMessageId, "turn:t1:assistant:1");
	assert.equal(next.messageOrdinal, 1);
	assert.equal(next.intermediateMessages.length, 1);
});

test("archived previous-round late patch cannot revive tools in live preview", () => {
	const afterArchive = archiveIntermediateRound(
		{
			status: "streaming",
			contentBlocks: toolBlocks,
			intermediateMessages: [],
			streamMessageId: "turn:t1:assistant:0",
			messageOrdinal: 0,
			patchSeq: 9,
			turnId: "t1",
		},
		{
			intermediateMessages: [archivedRound],
			archived: archivedRound,
			turnId: "t1",
		},
	);

	const result = applyStatePatch(afterArchive, {
		turnId: "t1",
		patchSeq: 5,
		messageId: "turn:t1:assistant:0",
		messageOrdinal: 0,
		contentBlocks: toolBlocks,
		intermediateMessages: [archivedRound],
	});

	assert.equal(result, "dropped");
	assert.deepEqual(afterArchive.contentBlocks, []);
});

test("next-round first patch is accepted after previous-round high patchSeq", () => {
	const afterArchive = archiveIntermediateRound(
		{
			status: "streaming",
			contentBlocks: toolBlocks,
			intermediateMessages: [],
			streamMessageId: "turn:t1:assistant:0",
			messageOrdinal: 0,
			patchSeq: 9,
			turnId: "t1",
		},
		{
			intermediateMessages: [archivedRound],
			archived: archivedRound,
			turnId: "t1",
		},
	);

	const next = applyStatePatch(afterArchive, {
		turnId: "t1",
		patchSeq: 1,
		messageId: "turn:t1:assistant:1",
		messageOrdinal: 1,
		contentBlocks: [{ type: "thinking", thinking: "fresh" }],
		intermediateMessages: [archivedRound],
	});

	assert.notEqual(next, "dropped");
	if (next === "dropped") return;
	assert.equal(next.patchSeq, 1);
	assert.equal(next.messageOrdinal, 1);
	assert.equal(
		(next.contentBlocks[0] as Extract<ContentBlock, { type: "thinking" }>)
			.thinking,
		"fresh",
	);
});

test("stale same-message patch is still dropped", () => {
	const current: GenerationState = {
		status: "streaming",
		contentBlocks: [{ type: "text", text: "hello" }],
		intermediateMessages: [],
		streamMessageId: "turn:t1:assistant:1",
		messageOrdinal: 1,
		patchSeq: 3,
		turnId: "t1",
	};

	const result = applyStatePatch(current, {
		turnId: "t1",
		patchSeq: 2,
		messageId: "turn:t1:assistant:1",
		messageOrdinal: 1,
		contentBlocks: [{ type: "text", text: "stale" }],
		intermediateMessages: [],
	});

	assert.equal(result, "dropped");
});
