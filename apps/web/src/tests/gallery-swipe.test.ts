import assert from "node:assert/strict";
import test from "node:test";
import {
	createGallerySwipe,
	type GallerySwipeOffset,
	type GallerySwipeOutcome,
} from "$lib/gestures/gallery-swipe";

const surface = { clientWidth: 400 } as HTMLElement;

function pointer(
	pointerId: number,
	clientX: number,
	clientY: number,
	timeStamp: number,
	pointerType: "mouse" | "touch" = "touch",
): PointerEvent {
	return {
		pointerId,
		pointerType,
		clientX,
		clientY,
		timeStamp,
		currentTarget: surface,
		target: surface,
	} as unknown as PointerEvent;
}

function setup(edges: { prev?: boolean; next?: boolean } = {}) {
	const moves: GallerySwipeOffset[] = [];
	const outcomes: GallerySwipeOutcome[] = [];
	const swipe = createGallerySwipe({
		canStart: () => true,
		canPrev: () => edges.prev ?? true,
		canNext: () => edges.next ?? true,
		onMove: (offset) => moves.push(offset),
		onEnd: (outcome) => outcomes.push(outcome),
	});
	return { swipe, moves, outcomes };
}

/** A slow, straight drag from `from` to `to`. */
function drag(
	swipe: ReturnType<typeof createGallerySwipe>,
	from: [number, number],
	to: [number, number],
) {
	swipe.onPointerDown(pointer(1, from[0], from[1], 0));
	swipe.onPointerMove(pointer(1, to[0], to[1], 1_000));
	swipe.onPointerUp(pointer(1, to[0], to[1], 1_100));
}

test("pages to the next item past the distance threshold", () => {
	const { swipe, moves, outcomes } = setup();
	drag(swipe, [300, 200], [180, 205]);
	assert.deepEqual(moves.at(-1), { x: -120, y: 0 });
	assert.deepEqual(outcomes, ["next"]);
});

test("snaps back from a short, slow drag", () => {
	const { swipe, outcomes } = setup();
	drag(swipe, [200, 200], [240, 200]);
	assert.deepEqual(outcomes, [null]);
});

test("pages on a short flick", () => {
	const { swipe, outcomes } = setup();
	swipe.onPointerDown(pointer(1, 200, 200, 0));
	swipe.onPointerMove(pointer(1, 240, 200, 40));
	swipe.onPointerUp(pointer(1, 240, 200, 50));
	assert.deepEqual(outcomes, ["prev"]);
});

test("resists and never pages past the first item", () => {
	const { swipe, moves, outcomes } = setup({ prev: false });
	drag(swipe, [100, 200], [300, 200]);
	assert.deepEqual(moves.at(-1), { x: 60, y: 0 });
	assert.deepEqual(outcomes, [null]);
});

test("dismisses on a downward drag and ignores upward ones", () => {
	const down = setup();
	drag(down.swipe, [200, 100], [210, 300]);
	assert.deepEqual(down.moves.at(-1), { x: 0, y: 200 });
	assert.deepEqual(down.outcomes, ["dismiss"]);

	const up = setup();
	drag(up.swipe, [200, 300], [205, 100]);
	assert.deepEqual(up.moves, []);
	assert.deepEqual(up.outcomes, []);
});

test("hands a second finger to pinch zoom", () => {
	const { swipe, outcomes } = setup();
	swipe.onPointerDown(pointer(1, 200, 200, 0));
	swipe.onPointerMove(pointer(1, 150, 200, 100));
	swipe.onPointerDown(pointer(2, 260, 200, 120));
	swipe.onPointerMove(pointer(1, 20, 200, 200));
	swipe.onPointerUp(pointer(1, 20, 200, 220));
	swipe.onPointerUp(pointer(2, 260, 200, 220));
	assert.deepEqual(outcomes, [null]);
});

test("does not turn a desktop mouse drag into a gallery swipe", () => {
	const { swipe, moves, outcomes } = setup();
	swipe.onPointerDown(pointer(1, 300, 200, 0, "mouse"));
	swipe.onPointerMove(pointer(1, 100, 200, 100, "mouse"));
	swipe.onPointerUp(pointer(1, 100, 200, 120, "mouse"));
	assert.deepEqual(moves, []);
	assert.deepEqual(outcomes, []);
});
