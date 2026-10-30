import assert from "node:assert/strict";
import { test } from "node:test";
import { createBoardEditor } from "../../src/board/editor/index.js";
import { boardDocument } from "./fixtures.js";

test("a paste whose spot is out of view lands mid-view", () => {
	const editor = createBoardEditor({
		document: boardDocument({ items: { a: { type: "shape", position: { x: 100, y: 100 }, size: { width: 80, height: 80 } } } }),
		onCommit() {},
	});
	editor.surfaceSize = { width: 1000, height: 600 };
	editor.setSelection(["a"]);
	editor.copySelection();
	editor.pasteClipboard();
	assert.equal(editor.selectedItems[0]?.frame.x, 124);
	editor.setCamera({ x: -5000, y: 0, zoom: 1 });
	editor.pasteClipboard();
	assert.equal(editor.selectedItems[0]?.frame.x, 5460);
	editor.destroy();
});
