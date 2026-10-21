import assert from "node:assert/strict";
import { test } from "node:test";
import type { BoardPlaybackSnapshot } from "@cohub/protocol";
import { createBoardPlayer, playbackClockAt } from "../../src/board/player/index.js";
import { boardDocument } from "./fixtures.js";

function playing(animationId: string, position = 0): BoardPlaybackSnapshot {
	return { playbackId: "p", animationId, animationRevision: 0, status: "playing", position, timeScale: 1, seed: "s", effectiveAt: 0, commandId: "c", revision: 1 };
}

const document = boardDocument({
	items: { box: { type: "shape" } },
	animations: {
		hold: { duration: 1000, tracks: { fade: { target: "box", property: "opacity", keyframes: [{ at: 0, value: 0 }, { at: 1000, value: 1 }] } } },
		reset: { duration: 1000, end: "reset" },
		loop: { duration: 1000, loop: true },
		paused: { duration: 1000, markers: [{ at: 400, pause: true }] },
	},
});

test("a playback advances only while its position moves", () => {
	assert.deepEqual(playbackClockAt(playing("hold"), document, 500), { time: 500, advancing: true });
	assert.deepEqual(playbackClockAt(playing("hold"), document, 5000), { time: 1000, advancing: false });
	assert.deepEqual(playbackClockAt(playing("reset"), document, 5000), { time: null, advancing: false });
	assert.deepEqual(playbackClockAt(playing("loop"), document, 5250), { time: 250, advancing: true });
	assert.deepEqual(playbackClockAt(playing("paused"), document, 900), { time: 400, advancing: false });
	assert.deepEqual(playbackClockAt({ ...playing("hold", 300), status: "paused" }, document, 900), { time: 300, advancing: false });
});

test("a finished playback holds its last frame without running", () => {
	const player = createBoardPlayer();
	const live = player.frame(document, playing("hold"), 0, 500, null);
	assert.equal(live.running, true);
	const finished = player.frame(document, playing("hold"), 0, 5000, null);
	assert.equal(finished.running, false);
	assert.equal(finished.playbackTime, 1000);
	assert.equal(finished.items.get("box")?.opacity, 1);
});
