import assert from "node:assert/strict";
import { test } from "node:test";
import type { BoardPlaybackSnapshot, BoardReadResult } from "@cohub/protocol";
import { createBoardSync } from "../lib/board/board-sync.ts";
import { boardDocument } from "./board/fixtures.ts";

const response = (version: number): BoardReadResult => ({
	id: "b", title: "Board", version, updatedAt: null, playback: null,
	...boardDocument({ items: { [`v${version}`]: { type: "shape" } } }),
});

function readSync(get: () => Promise<BoardReadResult>) {
	return createBoardSync({
		transport: { get, apply: async () => { throw new Error("Unexpected write"); } },
		store: {
			listPending: async () => [], readDocument: async () => null,
			putPending: async () => undefined, deletePending: async () => undefined,
			writeDocument: async () => undefined,
		},
		onChange: () => undefined,
	});
}

test("an event received during the first GET forces a follow-up snapshot", async () => {
	const firstRead = Promise.withResolvers<BoardReadResult>();
	const startedRead = Promise.withResolvers<void>();
	let reads = 0;
	const sync = readSync(async () => {
		reads += 1;
		if (reads > 1) return response(2);
		startedRead.resolve();
		return firstRead.promise;
	});
	const start = sync.start();
	await startedRead.promise;
	sync.receive({ mutationId: "remote", baseVersion: 1, version: 2 });
	firstRead.resolve(response(1));
	await start;
	assert.equal(reads, 2);
	assert.equal(sync.state.version, 2);
	assert.ok(sync.state.document?.items.v2);
	assert.equal(sync.state.document?.items.v1, undefined);
	sync.dispose();
});

const playing: BoardPlaybackSnapshot = {
	playbackId: "play", animationId: "intro", animationRevision: 1, revision: 1,
	status: "playing", position: 0, effectiveAt: 0, timeScale: 1, seed: "intro", commandId: "start",
};

for (const event of [playing, null]) {
	test(`an in-flight GET cannot overwrite a newer ${event ? "play" : "stop"} event`, async () => {
		let deferred: Promise<BoardReadResult> | null = null;
		const sync = readSync(async () => deferred ?? response(1));
		await sync.start();
		const pending = Promise.withResolvers<BoardReadResult>();
		deferred = pending.promise;
		const refresh = sync.refresh();
		sync.receivePlayback(event);
		pending.resolve({ ...response(1), playback: event ? null : playing });
		await refresh;
		assert.deepEqual(sync.state.playback, event);
		sync.dispose();
	});
}
