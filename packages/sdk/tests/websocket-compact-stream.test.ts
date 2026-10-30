import assert from "node:assert/strict";
import { test } from "node:test";
import { WebsocketClient } from "../src/websocket.js";
import type { ChannelEnvelope } from "@cohub/protocol/realtime";

function createPatchEnvelope(input: {
	seq: number;
	baseSeq: number;
	ops: unknown[];
}): ChannelEnvelope {
	return {
		id: `patch-${input.seq}`,
		timestamp: Date.now(),
		domain: "session",
		type: "session.turn.patch",
		spaceId: "space-1",
		sessionId: "session-1",
		payload: {
			turnId: "turn-1",
			messageId: "turn:turn-1:assistant:0",
			messageOrdinal: 0,
			sourceMessageId: "turn:turn-1:assistant:0",
			anchorUserMessageId: "user-1",
			seq: input.seq,
			baseSeq: input.baseSeq,
			ops: input.ops,
			_rt: { sid: "stream-1" },
		},
	};
}

test("compact stream resumes after a full patch seeds the stream", () => {
	const client = new WebsocketClient({
		url: "ws://localhost",
		getAccessToken: () => "token",
	});
	const events: ChannelEnvelope[] = [];
	client.on("event", (event) => events.push(event));

	const handleMessage = (
		client as unknown as { handleMessage(raw: unknown): void }
	).handleMessage.bind(client);

	handleMessage(
		JSON.stringify(
			createPatchEnvelope({
				seq: 12,
				baseSeq: 0,
				ops: [{ o: "append", p: "/message/content/blocks/0/text", v: "hello" }],
			}),
		),
	);
	handleMessage(
		JSON.stringify(
			createPatchEnvelope({
				seq: 13,
				baseSeq: 12,
				ops: [{ v: " world" }],
			}),
		),
	);
	handleMessage(
		JSON.stringify({
			t: "d",
			sid: "stream-1",
			s: 14,
			b: 13,
			v: "!",
		}),
	);

	const patchSeqs = events
		.filter((event) => event.type === "session.turn.patch")
		.map((event) => event.payload.seq);
	assert.deepEqual(patchSeqs, [12, 13, 14]);
});

test("releases buffered patches after a missing seq times out", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const client = new WebsocketClient({
		url: "ws://localhost",
		getAccessToken: () => "token",
	});
	const seqs: unknown[] = [];
	client.on("event", (event) => seqs.push(event.payload.seq));
	const handleMessage = (
		client as unknown as { handleMessage(raw: unknown): void }
	).handleMessage.bind(client);
	const send = (seq: number, baseSeq: number) =>
		handleMessage(JSON.stringify(createPatchEnvelope({ seq, baseSeq, ops: [] })));

	send(1, 0);
	send(3, 2);
	send(4, 3);
	assert.deepEqual(seqs, [1]);

	t.mock.timers.tick(1_500);
	assert.deepEqual(seqs, [1, 3, 4]);

	send(5, 4);
	assert.deepEqual(seqs, [1, 3, 4, 5]);
});
