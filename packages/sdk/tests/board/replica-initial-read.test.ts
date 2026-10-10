import assert from "node:assert/strict";
import { test } from "node:test";
import type { BoardPlaybackSnapshot, BoardReadResult } from "@cohub/protocol";
import { createBoardReplica } from "../../src/board/replica/index.js";
import { boardDocument } from "./fixtures.js";

const response = (version: number): BoardReadResult => ({
	id: "b", title: "Board", version, updatedAt: null, playback: null,
	...boardDocument({ items: { [`v${version}`]: { type: "shape" } } }),
});

function readSync(get: () => Promise<BoardReadResult>) {
	return createBoardReplica({
		remote: { get, apply: async () => { throw new Error("Unexpected write"); } },
		storage: {
			listPending: async () => [], readDocument: async () => null,
			putPending: async () => undefined, deletePending: async () => undefined,
			writeDocument: async () => undefined,
		},
	});
}

test("an event received during the first GET forces a follow-up snapshot", async () => {
	const firstRead = Promise.withResolvers<BoardReadResult>();
	const startedRead = Promise.withResolvers<void>();
	let reads = 0;
	const replica = readSync(async () => {
		reads += 1;
		if (reads > 1) return response(2);
		startedRead.resolve();
		return firstRead.promise;
	});
	const start = replica.start();
	await startedRead.promise;
	replica.receive({ mutationId: "remote", baseVersion: 1, version: 2 });
	firstRead.resolve(response(1));
	await start;
	assert.equal(reads, 2);
	assert.equal(replica.state.version, 2);
	assert.ok(replica.state.document?.items.v2);
	assert.equal(replica.state.document?.items.v1, undefined);
	replica.dispose();
});

const playing: BoardPlaybackSnapshot = {
	playbackId: "play", animationId: "intro", animationRevision: 1, revision: 1,
	status: "playing", position: 0, effectiveAt: 0, timeScale: 1, seed: "intro", commandId: "start",
};

for (const event of [playing, null]) {
	test(`an in-flight GET cannot overwrite a newer ${event ? "play" : "stop"} event`, async () => {
		let deferred: Promise<BoardReadResult> | null = null;
		const replica = readSync(async () => deferred ?? response(1));
		await replica.start();
		const pending = Promise.withResolvers<BoardReadResult>();
		deferred = pending.promise;
		const refresh = replica.refresh();
		replica.receivePlayback(event);
		pending.resolve({ ...response(1), playback: event ? null : playing });
		await refresh;
		assert.deepEqual(replica.state.playback, event);
		replica.dispose();
	});
}
