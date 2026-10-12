import assert from "node:assert/strict";
import { test } from "node:test";
import {
	getBottomAnchoredScrollTop,
	getExpandedComposerHeight,
} from "$lib/composer-expansion";

test("expanded composer fills the visible panel", () => {
	assert.equal(
		getExpandedComposerHeight({
			boundsHeight: 760,
			viewportHeight: 420,
			chromeHeight: 200,
			inputHeight: 136,
			mobile: true,
		}),
		420 - 64 - 12,
	);
});

test("toggling keeps the bottom visible line in place", () => {
	assert.equal(
		getBottomAnchoredScrollTop({
			scrollTop: 1000,
			scrollHeight: 2000,
			fromHeight: 220,
			toHeight: 700,
		}),
		520,
	);
});
