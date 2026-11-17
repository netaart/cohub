import assert from "node:assert/strict";
import { test } from "node:test";
import type { AnimationPlayer } from "@pixi/3d";
import type { BoardModelPlayback } from "../../src/board/model/model-clips.js";
import { createModelPlayback } from "../../src/board/render/model3d/playback.js";

function fakePlayer(durations: Record<string, number>) {
	const states = new Map(Object.entries(durations).map(([label, duration]) => [label, {
		animation: { duration },
		time: 0,
		weight: 1,
		loop: true,
		playing: false,
		play() { this.playing = true; return this; },
		stop() { this.playing = false; return this; },
	}]));
	const player = {
		animationLabels: Object.keys(durations),
		getAnimation: (label: string) => states.get(label)?.animation,
		getState: (label: string) => states.get(label),
		update() {},
	};
	const shown = () => Object.fromEntries([...states].filter(([, state]) => state.playing).map(([label, state]) => [label, { time: +state.time.toFixed(3), weight: +state.weight.toFixed(3) }]));
	return { player: player as unknown as AnimationPlayer, shown };
}

const run = (clip: string | null, extra: Partial<BoardModelPlayback> = {}): BoardModelPlayback => ({ clip, time: null, loop: true, fade: 200, running: true, ...extra });

test("clips play by Board time and crossfade into the next", () => {
	const { player, shown } = fakePlayer({ Idle: 2, Run: 1 });
	const playback = createModelPlayback(player);
	assert.equal(playback.pose(run(null), 2500), true);
	assert.deepEqual(shown(), { Idle: { time: 0.5, weight: 1 } });
	playback.pose(run("Run"), 3000);
	playback.pose(run("Run"), 3100);
	assert.deepEqual(shown(), { Idle: { time: 1.1, weight: 0.5 }, Run: { time: 0.1, weight: 0.5 } });
	playback.pose(run("Run"), 3400);
	assert.deepEqual(shown(), { Run: { time: 0.4, weight: 1 } });
	assert.equal(playback.pose(run("Run", { loop: false }), 3500), true, "turning loop off keeps the clip's place");
	assert.deepEqual(shown(), { Run: { time: 0.5, weight: 1 } });
	assert.equal(playback.pose(run("Run", { loop: false }), 4100), false, "a finished one-shot clip stops asking for frames");
	playback.pose(run("Missing", { fade: 0 }), 4200);
	assert.deepEqual(shown(), { Idle: { time: 0, weight: 1 } });
});
