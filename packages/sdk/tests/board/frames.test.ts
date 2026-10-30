import assert from "node:assert/strict";
import { test } from "node:test";
import type { BoardPatch } from "../../src/board/model/index.js";
import { createBoardEditor } from "../../src/board/editor/index.js";
import { boardDocument, pointer } from "./fixtures.js";

const card = (x: number, y: number, extra: Record<string, unknown> = {}) => ({
	type: "shape",
	position: { x, y },
	size: { width: 80, height: 80 },
	...extra,
});

function board(items: Record<string, unknown>, animations: Record<string, unknown> = {}) {
	const commits: BoardPatch[] = [];
	const editor = createBoardEditor({
		document: boardDocument({ items, animations }),
		onCommit(patch) { commits.push(patch); },
	});
	return { editor, commits };
}

function drag(editor: ReturnType<typeof board>["editor"], from: [number, number], to: [number, number]) {
	editor.pointerDown(pointer(...from));
	editor.pointerMove(pointer(...to));
	editor.pointerUp(pointer(...to, { buttons: 0 }));
}

const framed = {
	f: { type: "frame", position: { x: 0, y: 0 }, size: { width: 400, height: 300 } },
	c: card(20, 20, { parent: "f" }),
	r: card(200, 150),
	g: { type: "frame", position: { x: 500, y: 0 }, size: { width: 200, height: 200 } },
	d: card(20, 20, { parent: "g" }),
};

test("dragging blank space inside a selected frame moves the frame and its children", () => {
	const { editor } = board(framed);
	editor.setSelection(["f"]);
	drag(editor, [300, 60], [340, 110]);
	assert.deepEqual(editor.selection, ["f"]);
	assert.equal(editor.itemById("f")?.frame.x, 40);
	assert.equal(editor.itemById("c")?.frame.y, 70);
	editor.destroy();
});

test("a drag from a card inside a selected frame moves the whole selection; a click narrows to the card", () => {
	const { editor } = board(framed);
	editor.selectAll();
	drag(editor, [50, 50], [90, 80]);
	assert.deepEqual(new Set(editor.selection), new Set(["f", "r", "g"]));
	assert.deepEqual([editor.itemById("f")?.frame.x, editor.itemById("r")?.frame.x, editor.itemById("g")?.frame.x], [40, 240, 540]);
	assert.equal(editor.itemById("c")?.frame.y, 50);
	drag(editor, [90, 80], [90, 80]);
	assert.deepEqual(editor.selection, ["c"]);
	editor.destroy();
});

test("a marquee inside a frame reaches loose cards on it but not the frames around it", () => {
	const { editor } = board(framed);
	drag(editor, [390, 290], [10, 10]);
	assert.deepEqual(new Set(editor.selection), new Set(["c", "r"]));
	drag(editor, [250, 290], [650, 100]);
	assert.deepEqual(new Set(editor.selection), new Set(["r", "g"]));
	drag(editor, [-50, -50], [450, 350]);
	assert.deepEqual(new Set(editor.selection), new Set(["f", "r"]));
	editor.destroy();
});

test("a drawn frame adopts the siblings it fully encloses in one undoable commit", () => {
	const { editor, commits } = board(
		{
			a: card(100, 100),
			b: card(150, 100),
			l: card(100, 140, { locked: true }),
			k: card(110, 120),
			q: card(100, 150),
			arrow: { type: "arrow", props: { start: { x: 110, y: 110 }, end: { x: 150, y: 150 } } },
		},
		{
			intro: {
				duration: 1000,
				tracks: {
					t: { target: "k", property: "position.y", composite: "add", keyframes: [{ at: 0, value: 0 }] },
					s: { target: "q", property: "rotation", keyframes: [{ at: 0, value: 0 }] },
				},
			},
		},
	);
	editor.tool = "frame";
	drag(editor, [90, 90], [200, 240]);
	const [id] = editor.selection;
	assert.ok(id);
	assert.equal(commits.length, 1);
	assert.equal(editor.itemById("a")?.parent, id);
	assert.deepEqual(editor.itemById("a")?.frame, { x: 100, y: 100, width: 80, height: 80, rotation: 0 });
	for (const loose of ["b", "l", "k", "q", "arrow"]) assert.equal(editor.itemById(loose)?.parent, undefined, loose);
	editor.undo();
	assert.equal(editor.itemById(id), null);
	assert.equal(editor.itemById("a")?.parent, undefined);
	editor.destroy();
});
