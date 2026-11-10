import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveBoardAnimationCamera } from "../../src/board/model/index.js";

test("an animation camera frames its viewport the same on every screen", () => {
	const shot = { zoom: 8, center: { x: 100, y: 50 } };
	const small = resolveBoardAnimationCamera(shot, () => undefined, { width: 800, height: 600 }, 0);
	assert.equal(small.zoom, 4);
	assert.deepEqual({ x: (400 - small.x) / 4, y: (300 - small.y) / 4 }, shot.center);
	const portrait = resolveBoardAnimationCamera(shot, () => undefined, { width: 900, height: 1600 }, 0, undefined, { width: 900, height: 1600 });
	assert.equal(portrait.zoom, 8);
});
