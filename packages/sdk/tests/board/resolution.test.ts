import assert from "node:assert/strict";
import { test } from "node:test";
import type { Text } from "pixi.js";
import { boardTextResolution, syncTextResolution } from "../../src/board/render/text-resolution.js";

test("text density is exact at rest and bounded by texture size", () => {
	assert.equal(boardTextResolution(1.9, 1.37, false), 2);
	assert.equal(boardTextResolution(1.9, 2, true), 1.9);
	const text = { bounds: { width: 65_536, height: 24 }, style: { padding: 0 }, resolution: 1 } as Text;
	syncTextResolution(text, 1);
	assert.equal(text.resolution, 0.0625);
	text.bounds.width = 511.2;
	text.style.padding = 2;
	syncTextResolution(text, 100);
	assert.ok(Math.ceil(Math.ceil(text.bounds.width + 4) * text.resolution) <= 4096);
});
