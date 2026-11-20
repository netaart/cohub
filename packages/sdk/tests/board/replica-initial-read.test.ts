import assert from "node:assert/strict";
import { test } from "node:test";
import type { BoardPlaybackSnapshot, BoardReadResult } from "@cohub/protocol";
import { BoardClient } from "../../src/board/client/index.js";
import { createBoardReplica } from "../../src/board/replica/index.js";
import type { HttpTransport } from "../../src/transport.js";
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

test("a play command overlapping the initial GET is reconciled without realtime", async (t) => {
	const firstRead = Promise.withResolvers<BoardReadResult>();
	const command = Promise.withResolvers<{ playback: BoardPlaybackSnapshot }>();
	const next = { ...playing, playbackId: "next", animationId: "outro", revision: 2, commandId: "play-next" };
	let reads = 0;
	const http = {
		request(path: string) {
			if (path.endsWith("/playback")) return command.promise;
			return ++reads === 1 ? firstRead.promise : Promise.resolve({ ...response(1), playback: next });
		},
	} as unknown as HttpTransport;
	const board = new BoardClient({ boardId: "b", http, websocket: null });
	const { replica, release } = board.replica();
	t.after(release);
	const control = board.control({ type: "play", commandId: next.commandId, animationId: next.animationId });
	const initial = Promise.withResolvers<void>();
	const reconciled = Promise.withResolvers<void>();
	t.after(replica.subscribe(({ playback }) => {
		if (playback === playing) initial.resolve();
		if (playback === next) reconciled.resolve();
	}));
	firstRead.resolve({ ...response(1), playback: playing });
	await initial.promise;
	command.resolve({ playback: next });
	assert.strictEqual(await control, next);
	await reconciled.promise;
	assert.equal(reads, 2);
});

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
