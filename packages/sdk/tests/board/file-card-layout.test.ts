import assert from "node:assert/strict";
import { test } from "node:test";
import {
	fileCategoryAccent,
	fileMetaLine,
} from "../../src/board/model/file-preview.js";
import {
	containCoverRect,
	ellipsizeWrappedLines,
	fitLineWithEllipsis,
} from "../../src/board/render/renderers/file-card-renderer.js";

test("cover layout contains square images without cropping", () => {
	assert.deepEqual(containCoverRect(260, 116, 1024, 1024), {
		x: 72,
		y: 0,
		width: 116,
		height: 116,
	});
});

test("cover layout centers landscape and portrait images", () => {
	assert.deepEqual(containCoverRect(200, 100, 400, 100), {
		x: 0,
		y: 25,
		width: 200,
		height: 50,
	});
	assert.deepEqual(containCoverRect(200, 100, 100, 400), {
		x: 87.5,
		y: 0,
		width: 25,
		height: 100,
	});
});

test("cover layout safely handles missing dimensions", () => {
	assert.deepEqual(containCoverRect(200, 100, 0, 100), {
		x: 0,
		y: 0,
		width: 0,
		height: 0,
	});
});

test("ellipsize leaves short wraps untouched", () => {
	assert.equal(ellipsizeWrappedLines(["one", "two"], 3), "one\ntwo");
	assert.equal(ellipsizeWrappedLines(["only"], 1), "only");
});

test("ellipsize keeps the first N lines and marks the cut", () => {
	assert.equal(
		ellipsizeWrappedLines(["alpha", "bravo", "charlie", "delta"], 2),
		"alpha\nbravo…",
	);
	assert.equal(ellipsizeWrappedLines(["alpha", "bravo"], 1), "alpha…");
});

test("ellipsize handles empty and zero-line budgets", () => {
	assert.equal(ellipsizeWrappedLines([], 2), "");
	assert.equal(ellipsizeWrappedLines(["x"], 0), "");
	// Content that already fits is left alone, even if it is only whitespace.
	assert.equal(ellipsizeWrappedLines(["   "], 1), "   ");
	// Trailing whitespace on a truncated last line is stripped before the mark.
	assert.equal(ellipsizeWrappedLines(["alpha  ", "bravo"], 1), "alpha…");
});

test("fitLineWithEllipsis keeps a line that already fits with the mark", () => {
	const measure = (value: string) => value.length;
	assert.equal(fitLineWithEllipsis("hello", 10, measure), "hello…");
});

test("category accent maps onto existing palette tokens", () => {
	const palette = {
		text: 1,
		rare: 2,
		epic: 3,
		legendary: 4,
		muted: 5,
	};
	assert.equal(fileCategoryAccent("doc", palette), 1);
	assert.equal(fileCategoryAccent("code", palette), 2);
	assert.equal(fileCategoryAccent("data", palette), 3);
	assert.equal(fileCategoryAccent("media", palette), 4);
	assert.equal(fileCategoryAccent("other", palette), 5);
});

test("meta line is empty without a type or size", () => {
	assert.equal(fileMetaLine("docs/notes.md", 2048), "MD · 2.0 KB");
});

test("fitLineWithEllipsis binary-searches a long line without walking char-by-char", () => {
	const measure = (value: string) => value.length;
	// wrapWidth 6 → longest allowed is 5 chars of content + "…" (length 6).
	assert.equal(fitLineWithEllipsis("abcdefghij", 6, measure), "abcde…");
	assert.equal(fitLineWithEllipsis("abcdefghij", 1, measure), "…");
	assert.equal(fitLineWithEllipsis("   ", 4, measure), "…");
});
