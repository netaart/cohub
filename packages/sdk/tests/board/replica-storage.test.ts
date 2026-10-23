import "fake-indexeddb/auto";
import assert from "node:assert/strict";
import { test } from "node:test";
import type { BoardReadResult } from "@cohub/protocol";
import {
	createBoardReplica,
	createIndexedDbBoardReplicaStorage,
} from "../../src/board/replica/index.js";
import { boardDocument } from "./fixtures.js";

let databases = 0;
const scoped = () => {
	databases += 1;
	const storage = createIndexedDbBoardReplicaStorage({ userKey: "u", spaceId: "s", boardId: "b" }, { database: `board-test-${databases}` });
	return { storage };
};

function remote(options: { offline?: boolean } = {}) {
	let document = boardDocument({});
	let version = 1;
	const reads: number[] = [];
	const handlers: { resync?: () => void } = {};
	return {
		reads,
		handlers,
		set offline(value: boolean) {
			options.offline = value;
		},
		remote: {
			async get(): Promise<BoardReadResult> {
				reads.push(version);
				const { board, items, animations } = document;
				return { id: "b", title: "B", version, updatedAt: null, board, items, animations, playback: null };
			},
			async apply(patch: Parameters<typeof boardDocument>[0], { mutationId }: { mutationId: string }) {
				if (options.offline) throw new Error("offline");
				document = boardDocument({ items: { ...document.items, ...(patch.items as object) } });
				version += 1;
				return { mutationId, status: "applied" as const, replayed: false, version, changed: { board: false, items: [], animations: [] }, diagnostics: [] };
			},
			subscribe(next: { resync?: () => void }) {
				handlers.resync = next.resync;
				return () => undefined;
			},
		},
	};
}

test("an edit made offline survives a reload and is sent once back online", async () => {
	const { storage } = scoped();
	const server = remote({ offline: true });
	const first = createBoardReplica({ remote: server.remote, storage, persistIntervalMs: 0 });
	await first.start();
	await first.apply({ items: { note: { type: "text", props: { text: "kept" } } } });
	first.dispose();
	assert.equal((await storage.listPending()).length, 1);

	server.offline = false;
	const reloaded = createBoardReplica({ remote: server.remote, storage, persistIntervalMs: 0 });
	await reloaded.start();
	assert.equal(reloaded.state.pending, 0);
	assert.equal(reloaded.state.document?.items.note?.type, "text");
	assert.deepEqual(await storage.listPending(), []);
	reloaded.dispose();
});

test("stored writes go out before writes made while they load, even across a reconnect", async () => {
	const { storage } = scoped();
	await storage.putPending({ mutationId: "old", patch: { items: { note: { type: "text", props: { text: "old" } } } } });
	let release = () => {};
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	const slow = { ...storage, listPending: () => gate.then(() => storage.listPending()) };
	const server = remote();
	const replica = createBoardReplica({ remote: server.remote, storage: slow, persistIntervalMs: 0 });
	const started = replica.start();
	await replica.apply({ items: { note: { type: "text", props: { text: "new" } } } });
	server.handlers.resync?.();
	await new Promise((resolve) => setTimeout(resolve, 0));
	release();
	await started;
	await replica.refresh();
	const note = replica.state.document?.items.note;
	assert.ok(note);
	assert.equal((note.props as { text?: string }).text, "new");
	replica.dispose();
});

test("a stalled cache does not hold back the server document", async () => {
	const { storage } = scoped();
	await storage.putPending({ mutationId: "kept", patch: { items: { note: { type: "text", props: { text: "kept" } } } } });
	let release = () => {};
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	const stalled = { ...storage, listPending: () => gate.then(() => storage.listPending()) };
	const server = remote();
	const replica = createBoardReplica({ remote: server.remote, storage: stalled, persistIntervalMs: 0 });
	const started = replica.start();
	await new Promise((resolve) => setTimeout(resolve, 0));
	assert.equal(replica.state.loaded, true);
	assert.ok(replica.state.document);
	release();
	await started;
	assert.equal(replica.state.pending, 0);
	const note = replica.state.document?.items.note;
	assert.ok(note);
	assert.equal((note.props as { text?: string }).text, "kept");
	replica.dispose();
});
