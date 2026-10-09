import assert from "node:assert/strict";
import { test } from "node:test";
import { applyBoardPatchToDocument, emptyBoardDocument, parseBoardDocument } from "./src/index.js";

test("new nested tracks are included in same-patch cycle detection", () => {
	const result = applyBoardPatchToDocument(emptyBoardDocument(), { animations: {
		a: { duration: 100, tracks: { ab: { target: "b", property: "time", keyframes: [{ at: 0, value: 0 }] } } },
		b: { duration: 100, tracks: { ba: { target: "a", property: "time", keyframes: [{ at: 0, value: 0 }] } } },
	} });
	assert.equal(result.ok, false);
	assert.ok(!result.ok && result.diagnostics.some((entry) => entry.code === "ANIMATION_CYCLE"));
});

test("a parent cycle cannot hide beyond the depth limit", () => {
	const items = Object.fromEntries(Array.from({ length: 65 }, (_, i) => [`f${i}`, { type: "frame", parent: `f${(i + 1) % 65}` }]));
	const result = parseBoardDocument({ items });
	assert.equal(result.ok, false);
	assert.ok(!result.ok && result.diagnostics.some((entry) => entry.code === "PARENT_DEPTH" || entry.code === "PARENT_CYCLE"));
});

test("over-deep acyclic parents are rejected instead of partially validated", () => {
	const items = Object.fromEntries(Array.from({ length: 66 }, (_, i) => [`f${i}`, { type: "frame", ...(i ? { parent: `f${i - 1}` } : {}) }]));
	assert.equal(parseBoardDocument({ items }).ok, false);
	delete items.f65;
	assert.equal(parseBoardDocument({ items }).ok, true);
});

test("reparenting a deep subtree validates every descendant", () => {
	const items = Object.fromEntries(["c", "s"].flatMap((prefix) => Array.from({ length: prefix === "c" ? 60 : 10 }, (_, i) => [
		`${prefix}${i}`, { type: "frame", ...(i ? { parent: `${prefix}${i - 1}` } : {}) },
	])));
	const parsed = parseBoardDocument({ items });
	assert.ok(parsed.ok);
	const result = applyBoardPatchToDocument(parsed.document, { items: { s0: { parent: "c59" } } });
	assert.equal(result.ok, false);
	assert.ok(!result.ok && result.diagnostics.some((entry) => entry.code === "PARENT_DEPTH"));
});
