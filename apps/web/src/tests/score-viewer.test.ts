import assert from "node:assert/strict";
import { test } from "node:test";
import {
	scorePlayPosition,
	scoreViewState,
} from "../lib/score-editor/score-viewer.ts";

test("an audio time maps to the same position on the staff", () => {
	assert.equal(scorePlayPosition(0), 0);
	assert.equal(scorePlayPosition(12.5), 12.5);
});

test("a time the audio does not have clears the cursor", () => {
	for (const value of [null, undefined, Number.NaN, Number.POSITIVE_INFINITY, -1]) {
		assert.equal(scorePlayPosition(value), null, String(value));
	}
});

test("an empty or blank score shows nothing", () => {
	assert.deepEqual(scoreViewState(""), { kind: "empty" });
	assert.deepEqual(scoreViewState("  \n\t "), { kind: "empty" });
	assert.deepEqual(scoreViewState(null), { kind: "empty" });
	assert.deepEqual(scoreViewState(undefined), { kind: "empty" });
});

test("a score keeps its text, so the dialect reads exactly what the file holds", () => {
	const text = "X:1\nT:kept\nK:C\nc16|\n";
	assert.deepEqual(scoreViewState(text), { kind: "score", text });
	assert.deepEqual(scoreViewState(`  ${text}`), {
		kind: "score",
		text: `  ${text}`,
	});
});
