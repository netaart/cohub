import assert from "node:assert/strict";
import { test } from "node:test";
import {
	type Rect,
	rectContainsPoint,
	rectsIntersect,
} from "../../src/board/model/index.js";
import {
	createSpatialIndex,
	type SpatialEntry,
} from "../../src/board/editor/spatial.js";

/** Deterministic PRNG so the randomized tests are reproducible. */
function createRng(seed: number) {
	let state = seed >>> 0;
	return () => {
		state = (state * 1664525 + 1013904223) >>> 0;
		return state / 0xffffffff;
	};
}

function randomRect(rng: () => number, extent: number): Rect {
	const x = rng() * extent;
	const y = rng() * extent;
	return { x, y, width: 1 + rng() * 80, height: 1 + rng() * 80 };
}

function makeEntries(count: number, seed: number): SpatialEntry[] {
	const rng = createRng(seed);
	return Array.from({ length: count }, (_, order) => ({
		id: `item-${order}`,
		order,
		rect: randomRect(rng, 4000),
	}));
}

function bruteIdsInRect(entries: SpatialEntry[], range: Rect): Set<string> {
	return new Set(
		entries
			.filter((entry) => rectsIntersect(entry.rect, range))
			.map((entry) => entry.id),
	);
}

test("idsInRect matches brute force over random data", () => {
	const entries = makeEntries(500, 42);
	const index = createSpatialIndex();
	index.rebuild(entries);
	const rng = createRng(7);
	for (let i = 0; i < 200; i++) {
		const range = randomRect(rng, 4000);
		const expected = bruteIdsInRect(entries, range);
		const actual = new Set(index.idsInRect(range));
		assert.deepEqual(actual, expected, `mismatch for range ${i}`);
	}
});

test("idsInRect returns nothing for an empty index", () => {
	const index = createSpatialIndex();
	index.rebuild([]);
	assert.equal(index.size, 0);
	assert.deepEqual(
		index.idsInRect({ x: 0, y: 0, width: 100, height: 100 }),
		[],
	);
});

test("idsInRect handles a single degenerate (point-like) item", () => {
	const index = createSpatialIndex();
	index.rebuild([
		{ id: "a", order: 0, rect: { x: 5, y: 5, width: 1, height: 1 } },
	]);
	assert.deepEqual(index.idsInRect({ x: 0, y: 0, width: 10, height: 10 }), [
		"a",
	]);
	assert.deepEqual(
		index.idsInRect({ x: 100, y: 100, width: 10, height: 10 }),
		[],
	);
});

test("idsAtPoint returns topmost-first and matches brute force", () => {
	const entries = makeEntries(300, 99);
	const index = createSpatialIndex();
	index.rebuild(entries);
	const rng = createRng(13);
	for (let i = 0; i < 200; i++) {
		const point = { x: rng() * 4000, y: rng() * 4000 };
		const expected = entries
			.filter((entry) => rectContainsPoint(entry.rect, point))
			.sort((a, b) => b.order - a.order)
			.map((entry) => entry.id);
		assert.deepEqual(index.idsAtPoint(point), expected, `point ${i}`);
	}
});

test("idsAtPoint orders overlapping items by z-order", () => {
	const index = createSpatialIndex();
	index.rebuild([
		{ id: "bottom", order: 0, rect: { x: 0, y: 0, width: 100, height: 100 } },
		{ id: "top", order: 1, rect: { x: 0, y: 0, width: 100, height: 100 } },
	]);
	assert.deepEqual(index.idsAtPoint({ x: 50, y: 50 }), ["top", "bottom"]);
});

test("rebuild replaces previous contents", () => {
	const index = createSpatialIndex();
	index.rebuild([
		{ id: "a", order: 0, rect: { x: 0, y: 0, width: 10, height: 10 } },
	]);
	assert.equal(index.size, 1);
	index.rebuild([
		{ id: "b", order: 0, rect: { x: 50, y: 50, width: 10, height: 10 } },
	]);
	assert.equal(index.size, 1);
	assert.deepEqual(index.idsInRect({ x: 0, y: 0, width: 20, height: 20 }), []);
	assert.deepEqual(index.idsInRect({ x: 40, y: 40, width: 30, height: 30 }), [
		"b",
	]);
});

test("large collinear dataset does not hang subdivision", () => {
	// All items share the same y, forcing degenerate vertical bounds.
	const entries: SpatialEntry[] = Array.from({ length: 1000 }, (_, order) => ({
		id: `n-${order}`,
		order,
		rect: { x: order * 10, y: 0, width: 8, height: 8 },
	}));
	const index = createSpatialIndex();
	index.rebuild(entries);
	assert.equal(index.size, 1000);
	const hits = index.idsInRect({ x: 0, y: -5, width: 100, height: 20 });
	assert.ok(hits.length >= 10);
});
