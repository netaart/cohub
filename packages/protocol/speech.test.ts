import assert from "node:assert/strict";
import { test } from "node:test";
import { toSpeechSegments } from "./src/speech.js";

test("speech segments start short, skip code and never leave a tiny tail", () => {
	const sentence = "This sentence is long enough to count as a real one. ";
	const segments = toSpeechSegments(sentence.repeat(30));
	assert.ok(segments.length > 2);
	assert.ok(Array.from(segments[0] ?? "").length <= 120);
	assert.ok(segments.every((segment) => Array.from(segment).length <= 480 + 20));
	assert.deepEqual(toSpeechSegments("```\nonly code\n```"), []);
});
