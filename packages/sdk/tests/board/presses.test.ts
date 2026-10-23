import assert from "node:assert/strict";
import { test } from "node:test";
import { screenPoint, worldPoint } from "../../src/board/model/index.js";
import { type BoardPointerEvent, createBoardEditor } from "../../src/board/editor/index.js";
import { boardDocument } from "./fixtures.js";

function pointer(pointerType: string, x: number, y: number, buttons = 1): BoardPointerEvent {
	return {
		pointerId: 1,
		screen: screenPoint(x, y),
		world: worldPoint(x, y),
		shiftKey: false,
		metaKey: false,
		ctrlKey: false,
		altKey: false,
		button: 0,
		buttons,
		pointerType,
		cancelled: false,
		pressure: 0.5,
	};
}

test("a touch on the selected item drags it even where its ports reach in", () => {
	const editor = createBoardEditor({
		document: boardDocument({ items: { a: { type: "image", size: { width: 100, height: 100 }, props: { src: "img/a.png" } } } }),
		onCommit() {},
	});
	editor.setSelection(["a"]);
	editor.pointerDown(pointer("touch", 50, 95));
	assert.equal(editor.interaction.type, "translating");
	editor.pointerMove(pointer("touch", 50, 135));
	editor.pointerUp(pointer("touch", 50, 135, 0));
	assert.equal(editor.itemById("a")?.frame.y, 40);
	editor.destroy();
});
