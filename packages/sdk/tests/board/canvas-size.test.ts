import assert from "node:assert/strict";
import { test } from "node:test";
import { boardCanvasSize } from "../../src/board/stage/canvas-size.js";

test("canvas keeps its CSS size when DPR disagrees with the device box", () => {
	const box = { width: 412, height: 876, density: 2.625, device: { width: 824, height: 1752 } };
	assert.deepEqual(boardCanvasSize(box, box, 2.625), { width: 412, height: 876, resolution: 2 });
});
