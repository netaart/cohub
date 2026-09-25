import assert from "node:assert/strict";
import test from "node:test";
import { createImageGestureHandlers } from "$lib/gestures/image-gesture";

function createSurface() {
	const image = {
		offsetWidth: 300,
		offsetHeight: 200,
		style: {
			transition: "",
			transform: "",
			removeProperty: () => undefined,
		},
	} as unknown as HTMLImageElement;
	const stage = {
		clientWidth: 200,
		clientHeight: 160,
		getBoundingClientRect: () => ({
			left: 0,
			top: 0,
			width: 200,
			height: 160,
		}),
		querySelector: () => image,
		setPointerCapture: () => undefined,
		hasPointerCapture: () => false,
		releasePointerCapture: () => undefined,
	} as unknown as HTMLElement;
	return { image, stage };
}

function pointer(
	stage: HTMLElement,
	pointerId: number,
	clientX: number,
	clientY: number,
	pointerType: "mouse" | "touch" | "pen" = "touch",
): PointerEvent {
	return {
		pointerId,
		pointerType,
		button: 0,
		clientX,
		clientY,
		currentTarget: stage,
		target: stage,
		preventDefault: () => undefined,
	} as unknown as PointerEvent;
}

test("keeps the pinch focus stable while scaling", () => {
	const { stage } = createSurface();
	let state = { zoom: 1, panX: 0, panY: 0 };
	const gesture = createImageGestureHandlers({
		getState: () => state,
		setState: (next) => (state = next),
	});

	gesture.onPointerDown(pointer(stage, 1, 90, 80));
	gesture.onPointerDown(pointer(stage, 2, 110, 80));
	gesture.onPointerMove(pointer(stage, 2, 120, 80));
	gesture.onPointerMove(pointer(stage, 1, 80, 80));

	assert.deepEqual(state, { zoom: 1, panX: 0, panY: 0 });
	gesture.onPointerUp(pointer(stage, 1, 80, 80));
	gesture.onPointerUp(pointer(stage, 2, 120, 80));

	assert.equal(state.zoom, 2);
	assert.equal(state.panX, 0);
	assert.equal(state.panY, 0);
});

test("pans a zoomed image and clamps it to the stage bounds", () => {
	const { stage } = createSurface();
	let state = { zoom: 2, panX: 0, panY: 0 };
	const gesture = createImageGestureHandlers({
		getState: () => state,
		setState: (next) => (state = next),
	});

	gesture.onPointerDown(pointer(stage, 1, 100, 80));
	gesture.onPointerMove(pointer(stage, 1, 500, -500));

	assert.deepEqual(state, { zoom: 2, panX: 0, panY: 0 });
	gesture.onPointerUp(pointer(stage, 1, 500, -500));

	assert.equal(state.panX, 200);
	assert.equal(state.panY, -120);
});
