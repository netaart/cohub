import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import type { ChannelEnvelope } from "@cohub/protocol/realtime";
import type { MessageRecord } from "@cohub/protocol/model";
import {
	parseAssistantMessageCommit,
	SessionGenerationStreamClient,
} from "../src/session-generation-stream.js";
import { WebsocketClient } from "../src/websocket.js";

function createPatchEnvelope(input: {
	id: string;
	seq: number;
	baseSeq: number;
	text: string;
	messageId?: string;
	messageOrdinal?: number;
}): ChannelEnvelope {
	return {
		id: input.id,
		timestamp: Date.now(),
		domain: "session",
		type: "session.turn.patch",
		spaceId: "space-1",
		sessionId: "session-1",
		payload: {
			turnId: "turn-1",
			messageId: input.messageId ?? "turn:turn-1:assistant:0",
			messageOrdinal: input.messageOrdinal ?? 0,
			sourceMessageId: input.messageId ?? "turn:turn-1:assistant:0",
			anchorUserMessageId: "user-1",
			seq: input.seq,
			baseSeq: input.baseSeq,
			ops: [
				{
					o: "add",
					p: "/message/content/blocks/0",
					v: { type: "text", text: input.text },
				},
			],
		},
	};
}

test("generation subscriptions keep independent stream reducer state", () => {
	const websocket = new WebsocketClient({
		url: "ws://localhost",
		getAccessToken: () => "token",
	});
	websocket.state = "open";
	const generation = new SessionGenerationStreamClient(
		websocket,
		"space-1",
		"session-1",
	);
	const emit = (
		websocket as unknown as { emit(type: "event", event: ChannelEnvelope): void }
	).emit.bind(websocket);

	const firstTexts: string[] = [];
	const stopFirst = generation.subscribe({
		state: (event) => {
			const block = event.state.contentBlocks[0];
			if (block?.type === "text") firstTexts.push(block.text);
		},
	});
	emit("event", createPatchEnvelope({ id: "p1", seq: 1, baseSeq: 0, text: "one" }));
	stopFirst();

	const secondTexts: string[] = [];
	const outOfSyncReasons: string[] = [];
	const stopSecond = generation.subscribe({
		state: (event) => {
			const block = event.state.contentBlocks[0];
			if (block?.type === "text") secondTexts.push(block.text);
		},
		outOfSync: (event) => outOfSyncReasons.push(event.reason),
	});
	emit("event", createPatchEnvelope({ id: "p2", seq: 1, baseSeq: 0, text: "two" }));
	stopSecond();

	assert.deepEqual(firstTexts, ["one"]);
	assert.deepEqual(secondTexts, ["two"]);
	assert.deepEqual(outOfSyncReasons, []);
});

const createSnapshot = () => ({
	snapshot: {
		version: 2 as const,
		spaceId: "space-1",
		sessionId: "session-1",
		turnId: "turn-1",
		anchorUserMessageId: "user-1",
		seq: 12,
		current: {
			messageId: "turn:turn-1:assistant:1",
			messageOrdinal: 1,
			content: [{ type: "text", text: "hello" }],
			appendPath: "/message/content/blocks/0/text",
		},
		intermediateMessages: [
			{
				messageId: "turn:turn-1:assistant:0",
				messageOrdinal: 0,
				content: [{ type: "text", text: "earlier" }],
			},
		],
		lifecycle: null,
		updatedAt: Date.now(),
	},
});

test("generation subscriptions compact duplicate keyless snapshot intermediates", async () => {
	const websocket = new WebsocketClient({
		url: "ws://localhost",
		getAccessToken: () => "token",
	});
	websocket.state = "open";
	const generation = new SessionGenerationStreamClient(
		websocket,
		"space-1",
		"session-1",
	);
	const snapshot = createSnapshot().snapshot;
	snapshot.intermediateMessages = [
		{
			messageId: null,
			messageOrdinal: null,
			content: [{ type: "text", text: "same" }],
		},
		{
			messageId: null,
			messageOrdinal: null,
			content: [{ type: "text", text: "same" }],
		},
	];

	let intermediateCount = 0;
	const stop = generation.subscribe(
		{
			state: (event) => {
				intermediateCount = event.intermediateMessages.length;
			},
		},
		{ initialSnapshot: snapshot },
	);
	await delay(0);
	stop();

	assert.equal(intermediateCount, 1);
});

test("generation subscriptions compact snapshot intermediates by ordinal", async () => {
	const websocket = new WebsocketClient({
		url: "ws://localhost",
		getAccessToken: () => "token",
	});
	websocket.state = "open";
	const generation = new SessionGenerationStreamClient(
		websocket,
		"space-1",
		"session-1",
	);
	const snapshot = createSnapshot().snapshot;
	snapshot.intermediateMessages = [
		{
			messageId: "turn:turn-1:assistant:0",
			messageOrdinal: 0,
			content: [{ type: "text", text: "synthetic" }],
		},
		{
			messageId: "db-message-1",
			messageOrdinal: 0,
			content: [{ type: "text", text: "db" }],
		},
	];

	let intermediateMessages: Array<{ content: unknown[] }> = [];
	const stop = generation.subscribe(
		{
			state: (event) => {
				intermediateMessages = event.intermediateMessages;
			},
		},
		{ initialSnapshot: snapshot },
	);
	await delay(0);
	stop();

	assert.equal(intermediateMessages.length, 1);
	assert.deepEqual(intermediateMessages[0]?.content, [
		{ type: "text", text: "db" },
	]);
});

test("compacted system messages are intermediate generation commits", () => {
	const message = {
		id: "compact-message",
		sessionId: "session-1",
		role: "system",
		content: [{ type: "system_note", note_type: "compacted", text: "Summary" }],
		meta: { messageKind: "compacted", turnId: "turn-1" },
	} as MessageRecord;

	const commit = parseAssistantMessageCommit(message);
	assert.equal(commit.kind, "intermediate");
	assert.equal(commit.isFinal, false);
});

test("snapshot compaction messages are placed before their retained message", async () => {
	const websocket = new WebsocketClient({
		url: "ws://localhost",
		getAccessToken: () => "token",
	});
	websocket.state = "open";
	const generation = new SessionGenerationStreamClient(
		websocket,
		"space-1",
		"session-1",
	);
	const snapshot = {
		...createSnapshot().snapshot,
		intermediateMessages: [
			{
				id: "retained-message",
				sequence: 10,
				messageId: "retained-message",
				messageOrdinal: 1,
				content: [{ type: "text", text: "retained" }],
			},
			{
				id: "compact-message",
				sequence: 10,
				role: "system" as const,
				messageId: "compact-message",
				messageOrdinal: null,
				content: [{ type: "system_note" as const, note_type: "compacted" as const, text: "summary" }],
				meta: {
					messageKind: "compacted",
					compaction: { placement: { beforeMessageId: "retained-message" } },
				},
			},
		],
	};

	let messageIds: Array<string | null> = [];
	const stop = generation.subscribe(
		{
			state: (event) => {
				messageIds = event.intermediateMessages.map((message) => message.messageId);
			},
		},
		{ initialSnapshot: snapshot },
	);
	await delay(0);
	stop();

	assert.deepEqual(messageIds, ["compact-message", "retained-message"]);
});

test("generation subscriptions can seed from a snapshot and replay buffered patches", async () => {
	const websocket = new WebsocketClient({
		url: "ws://localhost",
		getAccessToken: () => "token",
	});
	websocket.state = "open";
	const emit = (
		websocket as unknown as { emit(type: "event", event: ChannelEnvelope): void }
	).emit.bind(websocket);
	const fetchStreamSnapshot = async () => createSnapshot();
	const generation = new SessionGenerationStreamClient(
		websocket,
		"space-1",
		"session-1",
		fetchStreamSnapshot,
	);

	const states: Array<{ source: string; text: string; intermediateCount: number }> = [];
	const stop = generation.subscribe(
		{
			state: (event) => {
				const block = event.state.contentBlocks[0];
				states.push({
					source: event.source,
					text: block?.type === "text" ? block.text : "",
					intermediateCount: event.intermediateMessages.length,
				});
			},
		},
		{ recover: true },
	);

	await delay(0);
	emit(
		"event",
		createPatchEnvelope({
			id: "p13",
			seq: 13,
			baseSeq: 12,
			text: "hello world",
			messageId: "turn:turn-1:assistant:1",
			messageOrdinal: 1,
		}),
	);
	await delay(0);
	stop();

	assert.deepEqual(states[0], {
		source: "snapshot",
		text: "hello",
		intermediateCount: 1,
	});
	assert.equal(states.at(-1)?.text, "hello world");
});

const ordinalPatch = (ordinal: number, seq: number, text: string, turnId = "turn-1") => {
	const envelope = createPatchEnvelope({
		id: `${turnId}:${ordinal}:${seq}`,
		seq,
		baseSeq: seq - 1,
		text,
		messageId: `turn:${turnId}:assistant:${ordinal}`,
		messageOrdinal: ordinal,
	});
	return { ...envelope, payload: { ...envelope.payload, turnId } };
};

const createGenerationClient = (
	fetchStreamSnapshot?: ConstructorParameters<typeof SessionGenerationStreamClient>[3],
) => {
	const websocket = new WebsocketClient({
		url: "ws://localhost",
		getAccessToken: () => "token",
	});
	websocket.state = "open";
	const emit = (
		websocket as unknown as { emit(type: "event", event: ChannelEnvelope): void }
	).emit.bind(websocket);
	return {
		emit,
		generation: new SessionGenerationStreamClient(
			websocket,
			"space-1",
			"session-1",
			fetchStreamSnapshot,
		),
	};
};

test("late events for another round or Turn do not stall the live stream", () => {
	const { emit, generation } = createGenerationClient();
	const texts: string[] = [];
	const outOfSync: string[] = [];
	const stop = generation.subscribe({
		state: (event) => {
			const block = event.state.contentBlocks[0];
			texts.push(block?.type === "text" ? block.text : "");
		},
		outOfSync: (event) => outOfSync.push(event.reason),
	});
	// Round 0 is committed only after round 1 has started streaming.
	emit("event", ordinalPatch(0, 1, "first"));
	emit("event", ordinalPatch(1, 1, "second"));
	emit("event", {
		id: "persisted:0",
		timestamp: Date.now(),
		domain: "session",
		type: "session.message.persisted",
		spaceId: "space-1",
		sessionId: "session-1",
		payload: {
			message: {
				id: "db-0",
				sessionId: "session-1",
				role: "assistant",
				content: [{ type: "text", text: "first" }],
				meta: { messageKind: "assistant_intermediate", turnId: "turn-1", messageOrdinal: 0 },
			},
		},
	});
	emit("event", ordinalPatch(1, 2, "second, continued"));
	assert.deepEqual(texts, ["first", "second", "second, continued"]);

	// Turn 1 finalizes after Turn 2 has started streaming.
	emit("event", ordinalPatch(0, 1, "next turn", "turn-2"));
	emit("event", {
		id: "finalized:turn-1",
		timestamp: Date.now(),
		domain: "session",
		type: "session.turn.finalized",
		spaceId: "space-1",
		sessionId: "session-1",
		payload: { turn: { id: "turn-1", sessionId: "session-1", status: "interrupted" } },
	});
	emit("event", ordinalPatch(0, 2, "next turn, continued", "turn-2"));
	stop();

	assert.deepEqual(outOfSync, []);
	assert.equal(texts.at(-1), "next turn, continued");
});

test("a patch that no longer applies resyncs from the snapshot once per message", async () => {
	let fetches = 0;
	const { emit, generation } = createGenerationClient(async () => {
		fetches += 1;
		return createSnapshot();
	});
	const outOfSync: string[] = [];
	const stop = generation.subscribe({
		outOfSync: (event) => outOfSync.push(event.reason),
	});
	// Joined mid-message: the snapshot covers seq 12, so seq 13 leaves no gap.
	emit("event", ordinalPatch(1, 12, "missed"));
	emit("event", ordinalPatch(1, 13, "continued"));
	await delay(0);
	assert.equal(fetches, 1);
	assert.deepEqual(outOfSync, []);

	// A repeat mismatch on the same message is reported instead of refetched.
	emit("event", ordinalPatch(1, 20, "gone"));
	await delay(0);
	assert.equal(fetches, 1);
	assert.deepEqual(outOfSync, ["version_mismatch"]);

	// A resync without a usable snapshot reports the patch that triggered it.
	stop();
	const fallback = createGenerationClient(async () => ({ snapshot: null }));
	const reported: string[] = [];
	const stopFallback = fallback.generation.subscribe({
		outOfSync: (event) => reported.push(event.reason),
	});
	fallback.emit("event", ordinalPatch(1, 12, "missed"));
	await delay(0);
	stopFallback();
	assert.deepEqual(reported, ["version_mismatch"]);
});

test("events replayed after a recovery stay buffered while a nested resync runs", async () => {
	const resynced = createSnapshot();
	resynced.snapshot.seq = 21;
	const { emit, generation } = createGenerationClient(async () => resynced);
	const outOfSync: string[] = [];
	const stop = generation.subscribe(
		{ outOfSync: (event) => outOfSync.push(event.reason) },
		{ initialSnapshot: createSnapshot().snapshot },
	);
	// Buffered while the initial snapshot seeds; seq 21 is the keyframe the resync keeps.
	emit("event", ordinalPatch(1, 20, "gap"));
	emit("event", ordinalPatch(1, 21, "recovered"));
	await delay(0);
	stop();

	assert.deepEqual(outOfSync, []);
});
