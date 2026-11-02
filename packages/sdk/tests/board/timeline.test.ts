import assert from "node:assert/strict";
import { test } from "node:test";
import { createBoardEditor } from "../../src/board/editor/index.js";
import { boardDocumentAt, boardRemoveTime, boardTargetSpan } from "../../src/board/model/index.js";
import { boardDocument } from "./fixtures.js";

function setup() {
	const editor = createBoardEditor({
		document: boardDocument({
			items: {
				clip: { type: "video", size: { width: 320, height: 180 }, props: { src: "https://cdn.example.com/a.mp4", snapshot: { durationMs: 10_000 } } },
				title: { type: "text", props: { text: "Hi" } },
			},
			animations: { cut: { duration: 1000 } },
		}),
		onCommit() {},
	});
	editor.setPlayhead({ animationId: "cut", time: 0 });
	const span = (id: string) => boardTargetSpan(editor.document, editor.document.animations.cut as never, id);
	return { editor, span };
}

test("clips place end to end, trim, split and move without changing their motion", () => {
	const { editor, span } = setup();
	editor.placeOnTimeline(["clip", "title"], 500, { duration: 2000 });
	assert.deepEqual([span("clip"), span("title")], [{ start: 500, end: 2500 }, { start: 2500, end: 4500 }]);
	editor.trimOnTimeline("clip", "start", 1000);
	const at = (time: number) => boardDocumentAt(editor.document, "cut", time).document.items;
	assert.equal((at(1500).clip as { props: { time: number } }).props.time, 1000);
	assert.equal(at(500).clip?.visible, false);
	editor.setPlayhead({ animationId: "cut", time: 1500 });
	const [copy] = editor.splitAtPlayhead(["clip"]);
	assert.ok(copy);
	editor.shiftOnTimeline([copy], -2000);
	assert.deepEqual([span("clip"), span(copy)], [{ start: 1000, end: 1500 }, { start: 0, end: 1000 }]);
	assert.equal((at(500)[copy] as { props: { time: number } }).props.time, 1500);
});

test("removing time over a whole clip keeps it hidden", () => {
	const { editor, span } = setup();
	editor.placeOnTimeline(["title"], 1000, { duration: 1000 });
	const cut = boardRemoveTime(editor.document, editor.document.animations.cut as never, 500, 2500);
	assert.equal(boardTargetSpan(editor.document, cut, "title"), null);
	assert.equal(boardDocumentAt({ ...editor.document, animations: { cut } }, "cut", 0).document.items.title?.visible, false);
	assert.deepEqual(span("title"), { start: 1000, end: 2000 });
});
