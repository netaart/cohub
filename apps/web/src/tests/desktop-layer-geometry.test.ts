import assert from "node:assert/strict";
import { test } from "node:test";
import {
	hotAppIdsAt,
	inputRegionContains,
	isTrackedInputRegion,
	ownsInput,
	pruneHotAppIds,
	resolveOverlayStyle,
	sameGeometry,
	sameInputRegion,
} from "#lib/features/space/modules/desktop-layer-geometry.ts";

const viewport = { width: 1000, height: 600 };

test("an overlay without a size fills the whole layer", () => {
	assert.equal(
		resolveOverlayStyle({}, viewport),
		"left: 0px; top: 0px; width: 1000px; height: 600px",
	);
});

test("each axis is resolved on its own", () => {
	assert.equal(
		resolveOverlayStyle({ width: 320 }, viewport),
		"left: 0px; top: 0px; width: 320px; height: 600px",
	);
	assert.equal(
		resolveOverlayStyle(
			{ anchor: "bottom-right", height: 100, y: 12 },
			viewport,
		),
		"left: 0px; top: 488px; width: 1000px; height: 100px",
	);
});

test("size is clamped to the viewport", () => {
	assert.equal(
		resolveOverlayStyle({ width: 5000, height: 0 }, viewport),
		"left: 0px; top: 0px; width: 1000px; height: 1px",
	);
});

test("the overlay never leaves the viewport, whatever the anchor", () => {
	const size = { width: 400, height: 100 };
	assert.equal(
		resolveOverlayStyle(
			{ ...size, anchor: "top-left", x: 900, y: -20 },
			viewport,
		),
		"left: 600px; top: 0px; width: 400px; height: 100px",
	);
	assert.equal(
		resolveOverlayStyle(
			{ ...size, anchor: "bottom-right", x: 900, y: 12 },
			viewport,
		),
		"left: 0px; top: 488px; width: 400px; height: 100px",
	);
	assert.equal(
		resolveOverlayStyle({ ...size, anchor: "center", x: 800, y: 0 }, viewport),
		"left: 600px; top: 250px; width: 400px; height: 100px",
	);
});

test("anchors measure the offset from their own edge", () => {
	const size = { width: 100, height: 100 };
	assert.equal(
		resolveOverlayStyle(
			{ ...size, anchor: "top-right", x: 12, y: 12 },
			viewport,
		),
		"left: 888px; top: 12px; width: 100px; height: 100px",
	);
	assert.equal(
		resolveOverlayStyle(
			{ ...size, anchor: "bottom-left", x: 12, y: 12 },
			viewport,
		),
		"left: 12px; top: 488px; width: 100px; height: 100px",
	);
	assert.equal(
		resolveOverlayStyle({ ...size, anchor: "center", x: 10, y: -10 }, viewport),
		"left: 460px; top: 240px; width: 100px; height: 100px",
	);
});

test("only rect regions need the pointer tracked", () => {
	assert.equal(isTrackedInputRegion("none"), false);
	assert.equal(isTrackedInputRegion("all"), false);
	assert.equal(isTrackedInputRegion([]), false);
	assert.equal(
		isTrackedInputRegion([{ x: 0, y: 0, width: 1, height: 1 }]),
		true,
	);
});

test("input region decides which points the overlay owns", () => {
	assert.equal(inputRegionContains("all", 5, 5), true);
	assert.equal(inputRegionContains("none", 5, 5), false);
	assert.equal(inputRegionContains([], 5, 5), false);
	const rects = [
		{ x: 0, y: 0, width: 80, height: 80 },
		{ x: 200, y: 200, width: 10, height: 10 },
	];
	assert.equal(inputRegionContains(rects, 40, 40), true);
	assert.equal(inputRegionContains(rects, 80, 80), true);
	assert.equal(inputRegionContains(rects, 81, 40), false);
	assert.equal(inputRegionContains(rects, 205, 205), true);
	assert.equal(inputRegionContains(rects, 150, 150), false);
});

test("geometry and input region compare structurally", () => {
	assert.equal(
		sameGeometry(
			{ anchor: "top-right", x: 12, width: 260 },
			{ anchor: "top-right", x: 12, width: 260 },
		),
		true,
	);
	assert.equal(sameGeometry({ x: 12 }, { x: 12, height: 100 }), false);
	assert.equal(sameInputRegion("all", "all"), true);
	assert.equal(sameInputRegion("all", []), false);
	const rect = { x: 0, y: 0, width: 80, height: 80 };
	assert.equal(sameInputRegion([rect], [{ ...rect }]), true);
	assert.equal(sameInputRegion([rect], [{ ...rect, x: 1 }]), false);
	assert.equal(sameInputRegion([rect], [rect, rect]), false);
});

const origin = { left: 0, top: 0 };
const region = [{ x: 300, y: 300, width: 120, height: 120 }];
const overlayA = { appId: "a", geometry: {}, inputRegion: region };
const overlayB = { appId: "b", geometry: {}, inputRegion: region };

test("hot ids follow the point across overlapping tracked regions", () => {
	assert.deepEqual(
		[
			...hotAppIdsAt(
				[overlayA, overlayB],
				{ x: 350, y: 350 },
				viewport,
				origin,
			),
		],
		["a", "b"],
	);
	assert.deepEqual(
		[
			...hotAppIdsAt(
				[overlayA, overlayB],
				{ x: 700, y: 500 },
				viewport,
				origin,
			),
		],
		[],
	);
	// "all" and "none" overlays are never part of the tracked set.
	assert.deepEqual(
		[
			...hotAppIdsAt(
				[{ appId: "c", geometry: {}, inputRegion: "all" }],
				{ x: 350, y: 350 },
				viewport,
				origin,
			),
		],
		[],
	);
});

test("only a tracked region can own the pointer", () => {
	assert.equal(ownsInput(overlayA, new Set(["a"])), true);
	assert.equal(
		ownsInput({ ...overlayA, inputRegion: "none" }, new Set(["a"])),
		false,
	);
	assert.equal(
		ownsInput({ ...overlayA, inputRegion: "all" }, new Set(["a"])),
		false,
	);
	assert.equal(ownsInput(overlayA, new Set()), false);
});

test("opting out revokes ownership even while hot (the mid-press P1 case)", () => {
	// overlayA was hot, then switched to `none` while the button was held; a
	// sibling still tracks the pointer, so nothing else clears the set.
	const hot = new Set(["a"]);
	const pruned = pruneHotAppIds(hot, [
		{ ...overlayA, inputRegion: "none" },
		overlayB,
	]);
	assert.deepEqual([...pruned], []);
	assert.equal(ownsInput({ ...overlayA, inputRegion: "none" }, pruned), false);
});

test("pruning drops closed overlays and keeps the rest", () => {
	const hot = new Set(["a", "b", "gone"]);
	assert.deepEqual([...pruneHotAppIds(hot, [overlayA, overlayB])].sort(), [
		"a",
		"b",
	]);
	assert.deepEqual([...pruneHotAppIds(new Set(["a"]), [overlayA])], ["a"]);
	assert.deepEqual([...pruneHotAppIds(new Set(["a"]), [])], []);
});
