import assert from "node:assert/strict";
import { test } from "node:test";
import type { BoardPlaybackCommand, BoardPlaybackSnapshot } from "@cohub/protocol";
import { BoardClient } from "../../src/board/client/index.js";
import { createBoardEditor } from "../../src/board/editor/index.js";
import { createBoardTransport, nextLocalPlayback } from "../../src/board/player/index.js";
import type { HttpTransport } from "../../src/transport.js";
import { boardDocument } from "./fixtures.js";

const document = boardDocument({ animations: { intro: { duration: 1_000 } } });

test("a late play response acknowledges the command without rolling back the replica", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
	const response = Promise.withResolvers<{ playback: BoardPlaybackSnapshot }>();
	const http = {
		request: (path: string) => path.endsWith("/playback")
			? response.promise
			: Promise.resolve({ ...document, id: "board", title: "Board", version: 1, playback: null }),
	} as unknown as HttpTransport;
	const board = new BoardClient({ boardId: "board", http, websocket: null });
	const { replica, release } = board.replica();
	t.after(release);
	await new Promise<void>((resolve) => {
		const stop = replica.subscribe(({ loaded }) => {
			if (!loaded) return;
			stop();
			resolve();
		});
	});
	const sent = Promise.withResolvers<BoardPlaybackSnapshot | null>();
	const commands: BoardPlaybackCommand[] = [];
	const editor = createBoardEditor({ document, onCommit: () => assert.fail("Playback must not edit the Board") });
	const transport = createBoardTransport({ editor, send(command) {
		commands.push(command);
		void board.control(command).then(sent.resolve, sent.reject);
		return sent.promise;
	} });
	t.after(transport.destroy);
	t.after(replica.subscribe(({ playback }) => transport.setPlayback(playback)));
	transport.seek(100);
	transport.play();
	const command = commands[0];
	assert.ok(command);
	const accepted = nextLocalPlayback(null, command, document);
	assert.ok(accepted);
	t.mock.timers.tick(4_000);
	const seek = nextLocalPlayback(accepted, { type: "seek", commandId: "seek", position: 500 }, document);
	assert.ok(seek);
	replica.receivePlayback(seek);
	response.resolve({ playback: accepted });
	assert.strictEqual(await sent.promise, accepted);
	assert.strictEqual(replica.state.playback, seek);
	assert.equal(editor.playhead, null);
	assert.equal(transport.getSnapshot().time, 500);
});
