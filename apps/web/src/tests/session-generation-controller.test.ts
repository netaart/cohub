import assert from "node:assert/strict";
import { test } from "node:test";
import type { ContentBlock } from "@cohub/protocol/core";
import { mergeStreamingDeltaBlocks } from "../lib/session-streaming.ts";

type MiniGenerationState = {
	status: string;
	contentBlocks: ContentBlock[];
	intermediateMessages: ContentBlock[][];
	streamMessageId: string | null;
};

function textFromBlocks(blocks: ContentBlock[] | undefined) {
	const block = blocks?.[0];
	assert.ok(block && block.type === "text");
	return block.text;
}

function resolveStreamMessageId(input: {
	sessionId: string;
	turnId?: string | null;
	messageId?: string | null;
	messageOrdinal?: number | null;
}) {
	if (input.messageId?.trim()) return input.messageId.trim();
	if (input.messageOrdinal == null) return null;
	if (input.turnId?.trim()) {
		return `turn:${input.turnId.trim()}:assistant:${input.messageOrdinal}`;
	}
	return `session:${input.sessionId}:assistant:${input.messageOrdinal}:unknown`;
}

function applyProgressToMiniState(
	state: MiniGenerationState,
	input: {
		sessionId: string;
		turnId?: string | null;
		messageId?: string | null;
		messageOrdinal?: number | null;
		content: ContentBlock[];
	},
) {
	const nextStreamMessageId = resolveStreamMessageId(input);
	const messageChanged = Boolean(
		nextStreamMessageId &&
			state.contentBlocks.length > 0 &&
			((state.streamMessageId &&
				nextStreamMessageId !== state.streamMessageId) ||
				(!state.streamMessageId && state.status === "streaming")),
	);
	return {
		...state,
		status: "streaming",
		contentBlocks: mergeStreamingDeltaBlocks(
			messageChanged ? [] : state.contentBlocks,
			input.content,
		),
		intermediateMessages: messageChanged
			? [...state.intermediateMessages, state.contentBlocks]
			: state.intermediateMessages,
		streamMessageId: nextStreamMessageId ?? state.streamMessageId,
	};
}

test("progress stream folds existing preview when first identified message arrives", () => {
	let state: MiniGenerationState = {
		status: "pending",
		contentBlocks: [],
		intermediateMessages: [],
		streamMessageId: null,
	};
	state = applyProgressToMiniState(state, {
		sessionId: "s1",
		turnId: "t1",
		content: [{ type: "text", text: "first" }],
	});
	state = applyProgressToMiniState(state, {
		sessionId: "s1",
		turnId: "t1",
		messageId: "turn:t1:assistant:1",
		messageOrdinal: 1,
		content: [{ type: "text", text: "second" }],
	});

	assert.equal(textFromBlocks(state.contentBlocks), "second");
	assert.equal(state.intermediateMessages.length, 1);
	assert.equal(textFromBlocks(state.intermediateMessages[0]), "first");
});

test("progress stream folds existing preview when message id changes", () => {
	let state: MiniGenerationState = {
		status: "pending",
		contentBlocks: [],
		intermediateMessages: [],
		streamMessageId: null,
	};
	state = applyProgressToMiniState(state, {
		sessionId: "s1",
		turnId: "t1",
		messageId: "turn:t1:assistant:0",
		messageOrdinal: 0,
		content: [{ type: "text", text: "first" }],
	});
	state = applyProgressToMiniState(state, {
		sessionId: "s1",
		turnId: "t1",
		messageId: "turn:t1:assistant:1",
		messageOrdinal: 1,
		content: [{ type: "text", text: "second" }],
	});

	assert.equal(textFromBlocks(state.contentBlocks), "second");
	assert.equal(state.intermediateMessages.length, 1);
	assert.equal(textFromBlocks(state.intermediateMessages[0]), "first");
});
