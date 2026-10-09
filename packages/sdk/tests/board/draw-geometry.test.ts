import assert from "node:assert/strict";
import { test } from "node:test";
import {
	buildStrokeOutline,
	buildStrokeRibbonGeometry,
	computeDrawBounds,
	createStrokeRibbonBuilder,
	sampleRadius,
} from "../../src/board/core/draw-geometry.js";

const sharpReversal = [
	{ x: 0, y: 0, p: 0.2 },
	{ x: 80, y: 0, p: 0.8 },
	{ x: 5, y: 3, p: 0.3 },
	{ x: 80, y: 6, p: 1 },
	{ x: 5, y: 9, p: 0.5 },
];

test("freehand outlines stay finite and inside their pressure bounds", () => {
	const bounds = computeDrawBounds(sharpReversal, 8);
	const outline = buildStrokeOutline(sharpReversal, 8);
	assert.ok(outline.length > sharpReversal.length);
	for (const point of outline) {
		assert.ok(Number.isFinite(point.x));
		assert.ok(Number.isFinite(point.y));
		assert.ok(point.x >= bounds.x - 1e-6);
		assert.ok(point.x <= bounds.x + bounds.width + 1e-6);
		assert.ok(point.y >= bounds.y - 1e-6);
		assert.ok(point.y <= bounds.y + bounds.height + 1e-6);
	}
});

test("freehand outline derivation preserves raw samples", () => {
	const points = sharpReversal.map((point) => ({ ...point }));
	const before = structuredClone(points);
	buildStrokeOutline(points, 8);
	assert.deepEqual(points, before);
});

test("ribbon geometry keeps a folded stroke as bounded primitives", () => {
	const ribbon = buildStrokeRibbonGeometry(sharpReversal, 8);
	assert.ok(ribbon.positions.length > 0);
	assert.equal(ribbon.positions.length, ribbon.uvs.length);
	assert.equal(ribbon.positions.length, ribbon.progress.length * 2);
	for (const value of ribbon.positions) assert.ok(Number.isFinite(value));
	for (let offset = 0; offset < ribbon.indices.length; offset += 3) {
		const a = ribbon.indices[offset] as number;
		const b = ribbon.indices[offset + 1] as number;
		const c = ribbon.indices[offset + 2] as number;
		const ax = ribbon.positions[a * 2] as number;
		const ay = ribbon.positions[a * 2 + 1] as number;
		const bx = ribbon.positions[b * 2] as number;
		const by = ribbon.positions[b * 2 + 1] as number;
		const cx = ribbon.positions[c * 2] as number;
		const cy = ribbon.positions[c * 2 + 1] as number;
		const area = Math.abs((bx - ax) * (cy - ay) - (by - ay) * (cx - ax));
		assert.ok(area < 1_000, `unexpected giant triangle area: ${area}`);
	}
});

test("a single sample remains a compact round dot", () => {
	const point = { x: 12, y: 24, p: 0.5 };
	const radius = sampleRadius(8, point.p);
	const outline = buildStrokeOutline([point], 8);
	assert.equal(outline.length, 8);
	for (const sample of outline) {
		assert.ok(Math.abs(Math.hypot(sample.x - point.x, sample.y - point.y) - radius) < 1e-6);
	}
});

test("a growing stroke builds exactly what a full build would", () => {
	const points: Array<{ x: number; y: number; p: number }> = [];
	const builder = createStrokeRibbonBuilder(6);
	for (let index = 0; index < 120; index += 1) {
		const angle = index < 60 ? index / 10 : index * 2.1;
		points.push({ x: index * 3 + Math.cos(angle) * 20, y: Math.sin(angle) * 20, p: 0.2 + (index % 7) / 10 });
		const grown = builder.build(points);
		const full = createStrokeRibbonBuilder(6).build(points);
		assert.deepEqual([...grown.positions], [...full.positions]);
		assert.deepEqual([...grown.indices], [...full.indices]);
	}
});
