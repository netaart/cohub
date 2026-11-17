import assert from "node:assert/strict";
import { test } from "node:test";
import { applyBoardPatchToDocument, createDocumentLayout, parseBoardDocument, pruneBoardTrack } from "./src/index.js";

function document(input: unknown) {
	const parsed = parseBoardDocument(input);
	assert.ok(parsed.ok);
	return parsed.document;
}

test("deleting a focus target retains the other camera keyframes", () => {
	const base = document({ items: { a: { type: "shape" }, b: { type: "shape" } }, animations: { tour: { duration: 1000, tracks: {
		focus: { target: "camera", property: "focus", keyframes: [{ at: 0, value: "a" }, { at: 1000, value: "b" }] },
	} } } });
	const removed = applyBoardPatchToDocument(base, { items: { a: null } }, { cascade: true });
	assert.ok(removed.ok);
	assert.deepEqual(removed.document.animations.tour?.tracks.focus?.keyframes, [{ at: 1000, value: "b" }]);
	const original = base.animations.tour?.tracks.focus;
	assert.ok(original);
	const cleaned = pruneBoardTrack(original, new Set(["a"]));
	assert.ok(cleaned);
	const explicit = applyBoardPatchToDocument(base, { items: { a: null }, animations: { tour: { tracks: { focus: cleaned } } } });
	assert.ok(explicit.ok);
	assert.deepEqual(explicit.document, removed.document);
});

test("detached arrow endpoints retain world positions inside transformed frames", () => {
	const base = document({ items: {
		f: { type: "frame", position: { x: 300, y: 200 }, rotation: 30, scale: 2 },
		a: { type: "shape", position: { x: 10, y: 20 } },
		b: { type: "shape", position: { x: 800, y: 200 } },
		arrow: { type: "arrow", parent: "f", position: { x: 15, y: 25 }, props: { start: { item: "a" }, end: { item: "b" } } },
	} });
	const before = createDocumentLayout(base.items).arrowEnd("arrow", "start");
	const result = applyBoardPatchToDocument(base, { items: { a: null } });
	assert.ok(result.ok);
	const after = createDocumentLayout(result.document.items).arrowEnd("arrow", "start");
	assert.ok(Math.abs(before.x - after.x) < 1e-6);
	assert.ok(Math.abs(before.y - after.y) < 1e-6);
});

test("type replacements validate existing children, bindings and tracks", () => {
	const base = document({ items: {
		f: { type: "frame" }, child: { type: "text", parent: "f", props: { text: "Keep" } }, a: { type: "shape" },
		arrow: { type: "arrow", props: { start: { item: "a" }, end: { x: 500, y: 0 } } },
	}, animations: { reveal: { duration: 1000, tracks: { text: { target: "child", property: "props.reveal", keyframes: [{ at: 0, value: 0 }] } } } } });
	assert.equal(applyBoardPatchToDocument(base, { items: { f: { type: "shape" } } }).ok, false);
	assert.equal(applyBoardPatchToDocument(base, { items: { child: { type: "frame" } } }).ok, false);
	assert.equal(applyBoardPatchToDocument(base, { items: { a: { type: "arrow", props: { start: { x: 0, y: 0 }, end: { x: 10, y: 10 } } } } }).ok, false);
	const movedChild = applyBoardPatchToDocument(base, { items: { f: { type: "shape" }, child: { parent: null } } });
	assert.ok(movedChild.ok);
	assert.ok(parseBoardDocument(movedChild.document).ok);
});

test("attached items follow their target and stay put when it goes", () => {
	const base = document({ items: {
		hero: { type: "shape", position: { x: 300, y: 200 }, size: { width: 100, height: 100 }, rotation: 40 },
		slash: { type: "shape", position: { x: 10, y: -20 }, size: { width: 40, height: 40 }, attach: { item: "hero", node: "hand" } },
	} });
	const layout = createDocumentLayout(base.items);
	assert.deepEqual(layout.matrix("slash").slice(4), [360, 230]);
	const before = layout.frame("slash");
	const result = applyBoardPatchToDocument(base, { items: { hero: null } });
	assert.ok(result.ok);
	assert.equal(result.document.items.slash?.attach, undefined);
	const after = createDocumentLayout(result.document.items).frame("slash");
	assert.ok(Math.abs(before.x - after.x) < 1e-6 && Math.abs(before.y - after.y) < 1e-6);
	for (const [patch, code] of [
		[{ items: { slash: { attach: { item: "ghost" } } } }, "ATTACH_NOT_FOUND"],
		[{ items: { slash: { attach: { item: "slash" } } } }, "INVALID_ATTACH"],
		[{ items: { hero: { attach: { item: "slash" } } } }, "INVALID_ATTACH"],
		[{ items: { f: { type: "frame" }, slash: { parent: "f" } } }, "INVALID_ATTACH"],
		[{ items: { hero: { type: "arrow", props: { start: { x: 0, y: 0 }, end: { x: 10, y: 0 } } } } }, "INVALID_ATTACH"],
	] as const) {
		const rejected = applyBoardPatchToDocument(base, patch);
		assert.ok(!rejected.ok && rejected.diagnostics.some((diagnostic) => diagnostic.code === code), code);
	}
});
