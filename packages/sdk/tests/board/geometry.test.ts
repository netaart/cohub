import assert from "node:assert/strict";
import { test } from "node:test";
import type { BoardFrame } from "../../src/board/model/index.js";
import {
	angleFromCenter,
	clampZoom,
	degToRad,
	fitToContent,
	frameContainsPoint,
	frameCornerRotationHandleAt,
	frameCorners,
	frameEdgeHandleAt,
	frameHandlePosition,
	frameRayIntersection,
	itemBounds,
	MIN_ITEM_SIZE,
	normalizeRotation,
	normalizeViewport,
	panBy,
	pointToWorld,
	rectCenter,
	rectsIntersect,
	resizeFrame,
	rotateFrames,
	rotatePointAround,
	rotationHandlePosition,
	scaleFrames,
	screenPoint,
	selectionBounds,
	unionRects,
	worldPoint,
	worldToScreen,
	zoomAround,
} from "../../src/board/model/index.js";

const approx = (a: number, b: number, eps = 1e-6) =>
	assert.ok(Math.abs(a - b) < eps, `expected ${a} ≈ ${b}`);

/** World position of a point expressed in a frame's local (unrotated) space. */
function localToWorld(frame: BoardFrame, lx: number, ly: number) {
	const center = {
		x: frame.x + frame.width / 2,
		y: frame.y + frame.height / 2,
	};
	return rotatePointAround({ x: lx, y: ly }, center, degToRad(frame.rotation));
}

test("clampZoom bounds the zoom range", () => {
	approx(clampZoom(10), 8);
	approx(clampZoom(0.001), 0.05);
	approx(clampZoom(1.5), 1.5);
	approx(clampZoom(Number.NaN), 1);
	approx(clampZoom(Number.POSITIVE_INFINITY), 1);
});

test("normalizeViewport recovers invalid camera fields independently", () => {
	assert.deepEqual(
		normalizeViewport(
			{ x: Number.NaN, y: 20, zoom: Number.POSITIVE_INFINITY },
			{ x: 10, y: 15, zoom: 2 },
		),
		{ x: 10, y: 20, zoom: 2 },
	);
	assert.deepEqual(
		normalizeViewport(
			{ x: Number.NaN, y: Number.NEGATIVE_INFINITY, zoom: Number.NaN },
			{ x: Number.NaN, y: Number.NaN, zoom: Number.NaN },
		),
		{ x: 0, y: 0, zoom: 1 },
	);
});

test("unionRects merges bounds and returns null for empty", () => {
	assert.equal(unionRects([]), null);
	const union = unionRects([
		{ x: 0, y: 0, width: 10, height: 10 },
		{ x: 20, y: 5, width: 10, height: 10 },
	]);
	assert.deepEqual(union, { x: 0, y: 0, width: 30, height: 15 });
});

test("itemBounds expands for rotated frames", () => {
	const axisAligned = itemBounds({
		x: 0,
		y: 0,
		width: 100,
		height: 50,
		rotation: 0,
	});
	assert.deepEqual(axisAligned, { x: 0, y: 0, width: 100, height: 50 });

	const rotated = itemBounds({
		x: 0,
		y: 0,
		width: 100,
		height: 50,
		rotation: 90,
	});
	approx(rotated.width, 50);
	approx(rotated.height, 100);
	approx(rotated.x, 25);
	approx(rotated.y, -25);
});

test("frameContainsPoint accounts for rotation", () => {
	const frame: BoardFrame = {
		x: 0,
		y: 0,
		width: 100,
		height: 100,
		rotation: 45,
	};
	// Center is always inside.
	assert.ok(frameContainsPoint(frame, worldPoint(50, 50)));
	// The top vertex of the 45°-rotated square sits at (50, 50 - 70.7).
	assert.ok(frameContainsPoint(frame, worldPoint(50, -20)));
	assert.ok(!frameContainsPoint(frame, worldPoint(50, -22)));
	// A corner of the axis-aligned bounding box is outside the diamond.
	assert.ok(!frameContainsPoint(frame, worldPoint(2, 2)));
});

test("resizeFrame anchors the opposite corner (axis aligned)", () => {
	const frame: BoardFrame = {
		x: 0,
		y: 0,
		width: 100,
		height: 60,
		rotation: 0,
	};
	const result = resizeFrame(frame, "se", worldPoint(150, 90));
	approx(result.width, 150);
	approx(result.height, 90);
	approx(result.x, 0);
	approx(result.y, 0);
});

test("resizeFrame keeps the opposite corner fixed when rotated", () => {
	const frame: BoardFrame = {
		x: 0,
		y: 0,
		width: 100,
		height: 100,
		rotation: 90,
	};
	// Opposite of "se" is the local north-west corner.
	const anchorBefore = localToWorld(frame, frame.x, frame.y);
	const result = resizeFrame(frame, "se", worldPoint(220, 40));
	const anchorAfter = localToWorld(result, result.x, result.y);
	approx(anchorAfter.x, anchorBefore.x, 1e-4);
	approx(anchorAfter.y, anchorBefore.y, 1e-4);
	approx(result.rotation, 90);
	assert.ok(result.width >= MIN_ITEM_SIZE);
	assert.ok(result.height >= MIN_ITEM_SIZE);
});

test("resizeFrame clamps to the minimum size", () => {
	const frame: BoardFrame = {
		x: 0,
		y: 0,
		width: 100,
		height: 100,
		rotation: 0,
	};
	const result = resizeFrame(frame, "se", worldPoint(5, 5));
	approx(result.width, MIN_ITEM_SIZE);
	approx(result.height, MIN_ITEM_SIZE);
});

test("scaleFrames scales a group proportionally from the opposite corner", () => {
	const frames: BoardFrame[] = [
		{ x: 0, y: 0, width: 50, height: 50, rotation: 0 },
	];
	const bounds = { x: 0, y: 0, width: 100, height: 100 };
	const [scaled] = scaleFrames(frames, bounds, "se", worldPoint(200, 200));
	assert.ok(scaled);
	approx(scaled.width, 100);
	approx(scaled.height, 100);
	approx(scaled.x, 0);
	approx(scaled.y, 0);
});

test("rotateFrames orbits centers around the pivot and adds rotation", () => {
	const frames: BoardFrame[] = [
		{ x: 100, y: 0, width: 100, height: 100, rotation: 0 },
	];
	const [rotated] = rotateFrames(frames, worldPoint(50, 50), 90);
	assert.ok(rotated);
	approx(rotated.x, 0);
	approx(rotated.y, 100);
	approx(rotated.rotation, 90);
});

test("normalizeRotation folds into [-180, 180] and snaps near zero", () => {
	approx(normalizeRotation(350), -10);
	approx(normalizeRotation(190), -170);
	approx(normalizeRotation(-190), 170);
	approx(normalizeRotation(90), 90);
	approx(normalizeRotation(0.004), 0);
});

test("zoomAround keeps the cursor's world point stationary", () => {
	const viewport = { x: 0, y: 0, zoom: 1 };
	const screen = screenPoint(100, 50);
	const world = pointToWorld(screen, viewport);
	const zoomed = zoomAround(viewport, screen, 2);
	const roundTrip = pointToWorld(screen, zoomed);
	approx(roundTrip.x, world.x);
	approx(roundTrip.y, world.y);
	approx(zoomed.zoom, 2);
});

test("zoomAround recovers from invalid camera values without jumping", () => {
	const zoomed = zoomAround(
		{ x: Number.NaN, y: Number.POSITIVE_INFINITY, zoom: Number.NaN },
		screenPoint(100, 50),
		2,
	);
	assert.deepEqual(zoomed, { x: -100, y: -50, zoom: 2 });
	assert.deepEqual(
		zoomAround({ x: 10, y: 20, zoom: 2 }, screenPoint(100, 50), Number.NaN),
		{ x: 10, y: 20, zoom: 2 },
	);
});

test("worldToScreen and pointToWorld are inverses", () => {
	const viewport = { x: 30, y: -20, zoom: 1.5 };
	const world = worldPoint(120, 80);
	const screen = worldToScreen(world, viewport);
	const back = pointToWorld(screen, viewport);
	approx(back.x, world.x);
	approx(back.y, world.y);
});

test("panBy translates the viewport", () => {
	const viewport = { x: 0, y: 0, zoom: 1 };
	const panned = panBy(viewport, 10, -5);
	assert.deepEqual(panned, { x: 10, y: -5, zoom: 1 });
});

test("fitToContent centers content with padding", () => {
	const content = { x: 0, y: 0, width: 200, height: 100 };
	const viewport = fitToContent(content, { width: 500, height: 300 }, 50);
	approx(viewport.zoom, 2);
	approx(viewport.x, 50);
	approx(viewport.y, 50);
});

test("selection handle positions sit on the frame corners", () => {
	const frame: BoardFrame = {
		x: 0,
		y: 0,
		width: 100,
		height: 60,
		rotation: 0,
	};
	assert.deepEqual(frameHandlePosition(frame, "nw"), { x: 0, y: 0 });
	assert.deepEqual(frameHandlePosition(frame, "se"), { x: 100, y: 60 });
	assert.deepEqual(frameHandlePosition(frame, "n"), { x: 50, y: 0 });
});

test("corner rotation zones sit outside resize handles in screen space", () => {
	const frame: BoardFrame = {
		x: 0,
		y: 0,
		width: 100,
		height: 60,
		rotation: 0,
	};
	assert.equal(
		frameCornerRotationHandleAt(frame, worldPoint(-12, -12), 1),
		"nw",
	);
	assert.equal(
		frameCornerRotationHandleAt(frame, worldPoint(112, 72), 1),
		"se",
	);
	assert.equal(frameCornerRotationHandleAt(frame, worldPoint(-4, -4), 1), null);
	assert.equal(frameCornerRotationHandleAt(frame, worldPoint(12, 12), 1), null);
	assert.equal(frameCornerRotationHandleAt(frame, worldPoint(-6, -6), 2), "nw");

	const rotated = { ...frame, rotation: 90 };
	const rotatedOutside = localToWorld(rotated, -12, -12);
	assert.equal(
		frameCornerRotationHandleAt(
			rotated,
			worldPoint(rotatedOutside.x, rotatedOutside.y),
			1,
		),
		"nw",
	);
});

test("rotation handle sits below the frame and follows its rotation", () => {
	const frame: BoardFrame = {
		x: 0,
		y: 100,
		width: 200,
		height: 50,
		rotation: 0,
	};
	const atZoom1 = rotationHandlePosition(frame, 1);
	approx(atZoom1.x, 100);
	assert.ok(atZoom1.y > 150);
	const atZoom2 = rotationHandlePosition(frame, 2);
	// Higher zoom pulls the handle closer in world units (constant screen size).
	assert.ok(atZoom2.y < atZoom1.y);

	const rotated = rotationHandlePosition({ ...frame, rotation: 90 }, 1);
	approx(rotated.x, 100);
	assert.ok(rotated.y > 225);
});

test("rotation handle geometry stays continuous across edge transitions", () => {
	const frame: BoardFrame = {
		x: 0,
		y: 0,
		width: 200,
		height: 50,
		rotation: 45,
	};
	const before = rotationHandlePosition(frame, 1);
	const after = rotationHandlePosition({ ...frame, rotation: 45.1 }, 1);
	assert.ok(Math.hypot(after.x - before.x, after.y - before.y) < 1);

	const towardPointer = frameRayIntersection(frame, worldPoint(300, 200));
	assert.ok(towardPointer.x > 100);
	assert.ok(towardPointer.y > 25);
});

test("frame corners and edge hit zones follow rotation", () => {
	const frame: BoardFrame = {
		x: 0,
		y: 0,
		width: 100,
		height: 60,
		rotation: 90,
	};
	const corners = frameCorners(frame);
	assert.equal(corners.length, 4);
	assert.deepEqual(corners[0], frameHandlePosition(frame, "nw"));

	const east = frameHandlePosition(frame, "e");
	assert.equal(frameEdgeHandleAt(frame, east, 1), "e");
	// A corner belongs to its point handle, not a continuous edge zone.
	const northwest = frameHandlePosition(frame, "nw");
	assert.equal(frameEdgeHandleAt(frame, northwest, 1), null);
});

test("angleFromCenter measures clockwise screen angles", () => {
	approx(angleFromCenter(worldPoint(0, 0), worldPoint(10, 0)), 0);
	approx(angleFromCenter(worldPoint(0, 0), worldPoint(0, 10)), 90);
	approx(angleFromCenter(worldPoint(0, 0), worldPoint(-10, 0)), 180);
});

test("rectsIntersect detects overlap and separation", () => {
	assert.ok(
		rectsIntersect(
			{ x: 0, y: 0, width: 10, height: 10 },
			{ x: 5, y: 5, width: 10, height: 10 },
		),
	);
	assert.ok(
		!rectsIntersect(
			{ x: 0, y: 0, width: 10, height: 10 },
			{ x: 20, y: 0, width: 10, height: 10 },
		),
	);
});

test("selectionBounds unions rotated item bounds", () => {
	const bounds = selectionBounds([
		{ x: 0, y: 0, width: 100, height: 100, rotation: 0 },
		{ x: 200, y: 0, width: 100, height: 100, rotation: 0 },
	]);
	assert.ok(bounds);
	approx(bounds.width, 300);
});

test("rectCenter returns the midpoint", () => {
	assert.deepEqual(rectCenter({ x: 0, y: 0, width: 10, height: 20 }), {
		x: 5,
		y: 10,
	});
});
