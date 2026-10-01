import assert from "node:assert/strict";
import { test } from "node:test";
import type { BoardApplyResult, BoardPatch, BoardReadResult } from "@cohub/protocol";
import { applyBoardPatchToDocument } from "@cohub/protocol";
import { type BoardPendingPatch, type BoardSyncState, createBoardSync } from "../lib/board/board-sync.ts";
import { boardDocument } from "./board/fixtures.ts";

/** An in-memory server and cache; `fail` makes the next applies throw. */
function harness(options: { items?: Record<string, unknown>; cached?: { version: number; items: Record<string, unknown> }; pending?: BoardPendingPatch[]; replayed?: number } = {}) {
	let server = boardDocument({ items: options.items ?? {} });
	let version = 1;
	const failures: Array<Error & { status?: number }> = [];
	const applied: string[] = [];
	const store = {
		pending: new Map((options.pending ?? []).map((entry) => [entry.mutationId, entry])),
		document: options.cached ? { version: options.cached.version, document: boardDocument({ items: options.cached.items }) } : null,
	};
	const states: BoardSyncState[] = [];
	let gate: Promise<void> | null = null;
	const sync = createBoardSync({
		transport: {
			async get(): Promise<BoardReadResult> {
				// The wire carries the parsed document: complete, defaults filled.
				const { board, items, animations } = server;
				return { id: "b", title: "Board", version, updatedAt: null, board, items, animations, playback: null };
			},
			async apply(patch: BoardPatch, { mutationId }): Promise<BoardApplyResult> {
				if (gate) await gate;
				const failure = failures.shift();
				if (failure) throw failure;
				const result = applyBoardPatchToDocument(server, patch, { cascade: true });
				assert.ok(result.ok);
				server = result.document;
				version += 1;
				applied.push(mutationId);
				if (options.replayed) return { mutationId, status: "applied", replayed: true, version: options.replayed, changed: { board: false, items: [], animations: [] }, diagnostics: [] };
				return { mutationId, status: "applied", replayed: false, version, changed: { board: false, items: [], animations: [] }, diagnostics: [] };
			},
		},
		store: {
			listPending: async () => [...store.pending.values()],
			putPending: async (entry) => void store.pending.set(entry.mutationId, entry),
			deletePending: async (id) => void store.pending.delete(id),
			readDocument: async () => store.document,
			writeDocument: async (nextVersion, document) => {
				store.document = { version: nextVersion, document };
			},
		},
		onChange: (state) => states.push(state),
	});
	return {
		sync,
		store,
		states,
		applied,
		failures,
		get version() {
			return version;
		},
		/** Report the next apply as a replay of a write at `version`. */
		replayAt(version?: number) {
			options.replayed = version;
		},
		/** Hold applies until the returned function is called. */
		hold() {
			let release = () => {};
			gate = new Promise((resolve) => {
				release = () => {
					gate = null;
					resolve();
				};
			});
			return release;
		},
		/** A write by another client, as its realtime payload. */
		remote(patch: BoardPatch) {
			const result = applyBoardPatchToDocument(server, patch, { cascade: true });
			assert.ok(result.ok);
			server = result.document;
			version += 1;
			const items = Object.fromEntries(Object.keys(patch.items ?? {}).map((id) => [id, server.items[id] ?? null]));
			return { mutationId: crypto.randomUUID(), baseVersion: version - 1, version, after: { items } };
		},
	};
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

test("the cached document shows before the server answers", async () => {
	const board = harness({ items: { a: { type: "shape" } }, cached: { version: 1, items: { cached: { type: "shape" } } } });
	const started = board.sync.start();
	await flush();
	assert.ok(board.states[0]?.document?.items.cached);
	assert.equal(board.states[0]?.loaded, false);
	await started;
	assert.ok(board.sync.state.document?.items.a);
	assert.equal(board.sync.state.document?.items.cached, undefined);
});

test("a local write shows at once and is adopted without a read", async () => {
	const board = harness();
	await board.sync.start();
	const release = board.hold();
	const committed = board.sync.commit({ items: { a: { type: "shape" } } });
	assert.ok(board.sync.state.document?.items.a);
	assert.equal(board.sync.state.pending, 1);
	release();
	await committed;
	assert.equal(board.sync.state.pending, 0);
	assert.equal(board.sync.state.version, 2);
	assert.equal(board.store.pending.size, 0);
	assert.equal(board.store.document?.version, 2);
});

test("pending writes survive a reload and are sent in order", async () => {
	const pending = [
		{ mutationId: "m1", patch: { items: { a: { type: "shape" } } } },
		{ mutationId: "m2", patch: { items: { a: { opacity: 0.5 } } } },
	];
	const board = harness({ pending });
	await board.sync.start();
	assert.deepEqual(board.applied, ["m1", "m2"]);
	assert.equal(board.sync.state.document?.items.a?.opacity, 0.5);
});

test("a replayed write is read back rather than applied to the current document", async () => {
	const board = harness({ items: { a: { type: "shape" } } });
	await board.sync.start();
	// The receipt is from an older version, so the patch cannot be applied locally.
	board.replayAt(2);
	await board.sync.commit({ items: { a: { opacity: 0.25 } } });
	await flush();
	await flush();
	assert.equal(board.sync.state.pending, 0);
	assert.equal(board.sync.state.version, board.version);
	assert.equal(board.sync.state.document?.items.a?.opacity, 0.25);
});

test("remote changes land under pending writes", async () => {
	const board = harness({ items: { a: { type: "shape" } } });
	await board.sync.start();
	const release = board.hold();
	const committed = board.sync.commit({ items: { a: { opacity: 0.25 } } });
	board.sync.receive(board.remote({ items: { a: { rotation: 30 } } }));
	const shown = board.sync.state.document?.items.a;
	assert.equal(shown?.rotation, 30);
	assert.equal(shown?.opacity, 0.25);
	release();
	await committed;
	await flush();
	assert.equal(board.sync.state.document?.items.a?.opacity, 0.25);
	assert.equal(board.sync.state.version, board.version);
});

test("a gap in realtime versions falls back to a read", async () => {
	const board = harness({ items: { a: { type: "shape" } } });
	await board.sync.start();
	board.remote({ items: { a: { rotation: 10 } } });
	const skipped = board.remote({ items: { b: { type: "text", props: { text: "Hi" } } } });
	board.sync.receive(skipped);
	await flush();
	await flush();
	assert.equal(board.sync.state.document?.items.a?.rotation, 10);
	assert.ok(board.sync.state.document?.items.b);
});

test("a rejected write is dropped; a failed one is kept for retry", async () => {
	const board = harness();
	await board.sync.start();
	board.failures.push(Object.assign(new Error("items.a.props.nope: unknown property"), { status: 400 }));
	await board.sync.commit({ items: { a: { type: "shape" } } });
	await flush();
	assert.equal(board.sync.state.pending, 0);
	assert.equal(board.sync.state.document?.items.a, undefined);
	assert.match(board.sync.state.error ?? "", /unknown property/);

	board.failures.push(Object.assign(new Error("offline"), { status: 503 }));
	await board.sync.commit({ items: { b: { type: "shape" } } });
	assert.equal(board.sync.state.pending, 1);
	assert.ok(board.sync.state.document?.items.b);
	await board.sync.retry();
	assert.equal(board.sync.state.pending, 0);
	board.sync.dispose();
});

for (const status of [401, 403]) {
	test(`authentication failure ${status} retains unsent edits until retry`, async () => {
		const board = harness();
		await board.sync.start();
		board.failures.push(Object.assign(new Error("Authentication required"), { status }));
		await board.sync.commit({ items: { unsent: { type: "shape" } } });
		assert.equal(board.sync.state.pending, 1);
		assert.equal(board.store.pending.size, 1);
		assert.ok(board.sync.state.document?.items.unsent);
		await board.sync.retry();
		assert.equal(board.sync.state.pending, 0);
		assert.equal(board.store.pending.size, 0);
		assert.ok(board.sync.state.document?.items.unsent);
		board.sync.dispose();
	});
}
