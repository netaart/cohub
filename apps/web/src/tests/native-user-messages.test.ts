import assert from "node:assert/strict";
import { test } from "node:test";
import type { ContentBlock } from "@cohub/protocol/core";
import { createStreamingIntermediateMessage } from "../lib/session-streaming-message";
import { buildTurnTimelineItems } from "../lib/session-turn-render";

const content: ContentBlock[] = [
	{
		type: "text",
		text: "Please use this image",
		_meta: { nativeUserMessage: true },
	},
	{
		type: "image",
		source: { type: "url", url: "https://example.com/image.png" },
		_meta: { nativeUserMessage: true },
	},
];

test("native follow-up text and images keep their user role during streaming", () => {
	const message = createStreamingIntermediateMessage({
		sessionId: "session",
		turnId: "turn",
		contentBlocks: content,
	});
	assert.equal(message?.role, "user");
	assert.equal(message?.meta?.messageKind, "user_steering");
	assert.deepEqual(message?.content, content);
});

test("a native follow-up currently at the stream tail is a user bubble", () => {
	const items = buildTurnTimelineItems({
		sessionId: "session",
		turns: [],
		streaming: {
			sessionId: "session",
			turnId: "turn",
			status: "streaming",
			contentBlocks: content,
		},
	});
	const message = items.find((item) => item.kind === "message");
	assert.equal(message?.kind, "message");
	if (message?.kind !== "message") throw new Error("Missing user bubble");
	assert.equal(message.message.role, "user");
	assert.deepEqual(message.message.content, content);
});
