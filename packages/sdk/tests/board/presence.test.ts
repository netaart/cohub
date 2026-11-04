import assert from "node:assert/strict";
import { test } from "node:test";
import type { BoardAwarenessUpdate } from "@cohub/protocol/realtime";
import { createBoardEditor } from "../../src/board/editor/index.js";
import { type BoardPresenceChannel, type BoardPresencePayload, createBoardPresence } from "../../src/board/presence/index.js";
import { boardDocument, pointer } from "./fixtures.js";

function room() {
	const members = new Map<string, { actorId: string; seq: number; awareness: Set<(event: { payload: BoardPresencePayload }) => void> }>();
	return {
		channel(connectionId: string, actorId = connectionId): BoardPresenceChannel & { sent: BoardAwarenessUpdate[] } {
			const awareness = new Set<(event: { payload: BoardPresencePayload }) => void>();
			const member = { actorId, seq: 0, awareness };
			members.set(connectionId, member);
			const sent: BoardAwarenessUpdate[] = [];
			return {
				connectionId,
				sent,
				async updateAwareness(update) {
					sent.push(update);
					member.seq += 1;
					const payload = { connectionId, actorId, actorName: actorId, seq: member.seq, update };
					for (const [id, other] of members) if (id !== connectionId) for (const receive of other.awareness) receive({ payload });
				},
				subscribe(handlers) {
					if (handlers.awareness) awareness.add(handlers.awareness);
					return () => handlers.awareness && awareness.delete(handlers.awareness);
				},
			};
		},
	};
}

const ITEMS = { a: { type: "shape", size: { width: 100, height: 100 }, script: { src: "a.js" } } };

function client(channel: BoardPresenceChannel, items: Record<string, unknown> = ITEMS) {
	const editor = createBoardEditor({ document: boardDocument({ items }), onCommit: () => undefined });
	editor.surfaceSize = { width: 800, height: 600 };
	const presence = createBoardPresence({ editor, channel });
	return { editor, presence };
}

test("peers see each other's selection, cursor and dragged items, and both agree on one script leader", async (t) => {
	const shared = room();
	const one = client(shared.channel("c1"));
	const two = client(shared.channel("c2"));
	t.after(() => Promise.all([one.presence.destroy(), two.presence.destroy()]));

	one.editor.setSelection(["a"]);
	one.presence.setCursor({ x: 50, y: 40, pointerType: "mouse" });
	await new Promise((resolve) => setTimeout(resolve, 60));
	const [peer] = two.presence.peers;
	assert.equal(peer?.connectionId, "c1");
	assert.deepEqual(peer?.state?.selection.ids, ["a"]);
	const [cursor] = two.presence.cursors;
	assert.deepEqual([cursor?.x, cursor?.y, cursor?.pointerType], [50, 40, "mouse"]);

	one.editor.tool = "select";
	one.editor.pointerDown(pointer(50, 50));
	one.editor.pointerMove(pointer(150, 90));
	await new Promise((resolve) => setTimeout(resolve, 60));
	assert.equal(two.presence.cursors[0]?.action, "moving");
	assert.equal(two.presence.previews().get("a")?.position?.x, 100);

	assert.notEqual(one.presence.leadsScripts(), two.presence.leadsScripts());
});
