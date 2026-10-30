import assert from "node:assert/strict";
import { test } from "node:test";
import {
	isArchivedMessageIdentity,
	isSameLiveMessage,
	shouldPreserveLivePreviewOnArchive,
} from "../lib/session-generation-stream-guards";

test("isSameLiveMessage matches by ordinal or stream id", () => {
	assert.equal(
		isSameLiveMessage(
			{ messageOrdinal: 1, streamMessageId: "turn:t1:assistant:1" },
			{ messageOrdinal: 1, messageId: "turn:t1:assistant:1" },
		),
		true,
	);
	assert.equal(
		isSameLiveMessage(
			{ messageOrdinal: 1, streamMessageId: "turn:t1:assistant:1" },
			{ messageOrdinal: 0, messageId: "turn:t1:assistant:0" },
		),
		false,
	);
	assert.equal(
		isSameLiveMessage(
			{ messageOrdinal: null, streamMessageId: null },
			{ messageOrdinal: null, messageId: null },
		),
		true,
	);
});

test("isArchivedMessageIdentity rejects revived previous-round patches", () => {
	const intermediates = [
		{
			id: "msg-intermediate-1",
			messageId: "turn:t1:assistant:0",
			messageOrdinal: 0,
		},
	];
	assert.equal(
		isArchivedMessageIdentity(intermediates, {
			messageOrdinal: 0,
			messageId: "turn:t1:assistant:0",
		}),
		true,
	);
	assert.equal(
		isArchivedMessageIdentity(intermediates, {
			messageOrdinal: 1,
			messageId: "turn:t1:assistant:1",
		}),
		false,
	);
});

test("archive identity uses ordinal before ids and falls back to ids", () => {
	assert.equal(
		shouldPreserveLivePreviewOnArchive(
			{ messageOrdinal: 0, streamMessageId: "turn:t1:assistant:0" },
			{ messageOrdinal: 0, messageId: "db-message-uuid" },
		),
		false,
	);
	assert.equal(
		shouldPreserveLivePreviewOnArchive(
			{ messageOrdinal: 1, streamMessageId: "same-id" },
			{ messageOrdinal: 0, messageId: "same-id" },
		),
		true,
	);
	assert.equal(
		shouldPreserveLivePreviewOnArchive(
			{ streamMessageId: "next-stream" },
			{ messageId: "previous-stream" },
		),
		true,
	);
	assert.equal(
		shouldPreserveLivePreviewOnArchive(
			{ streamMessageId: "same-stream" },
			{ messageId: "same-stream" },
		),
		false,
	);
});

test("shouldPreserveLivePreviewOnArchive ignores empty contentBlocks", () => {
	// Next-round identity already advanced, first token not yet arrived.
	assert.equal(
		shouldPreserveLivePreviewOnArchive(
			{
				messageOrdinal: 1,
				streamMessageId: "turn:t1:assistant:1",
			},
			{
				messageOrdinal: 0,
				messageId: "turn:t1:assistant:0",
			},
		),
		true,
	);
	assert.equal(
		shouldPreserveLivePreviewOnArchive(
			{
				messageOrdinal: 0,
				streamMessageId: "turn:t1:assistant:0",
			},
			{
				messageOrdinal: 0,
				messageId: "turn:t1:assistant:0",
			},
		),
		false,
	);
});
