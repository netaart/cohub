import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test } from "node:test";
import { installViewportOffsetGuard } from "#lib/viewport-offset-guard.ts";

type Listener = () => void;

/**
 * Minimal window/document double: a pannable document, a visual viewport
 * with scale, a focusable active element, synchronous rAF and manual timers.
 */
function mountPage() {
	const listeners = new Set<Listener>();
	const timers: Listener[] = [];
	const viewport = { scale: 1, offsetTop: 0, pageTop: 0 };
	const state = {
		scrollY: 0,
		scrollToCalls: 0,
		activeElement: null as { tagName: string; editable?: true } | null,
	};
	const target = {
		addEventListener: (_: string, fn: Listener) => listeners.add(fn),
		removeEventListener: (_: string, fn: Listener) => listeners.delete(fn),
	};

	const previous = {
		window: globalThis.window,
		document: globalThis.document,
		raf: globalThis.requestAnimationFrame,
	};
	globalThis.window = {
		...target,
		get scrollY() {
			return state.scrollY;
		},
		scrollX: 0,
		scrollTo: (_x: number, y: number) => {
			state.scrollToCalls += 1;
			state.scrollY = y;
		},
		visualViewport: { ...target, ...viewport },
		setTimeout: (fn: Listener) => timers.push(fn),
		clearTimeout: () => {},
	} as unknown as Window & typeof globalThis;
	globalThis.document = {
		...target,
		get activeElement() {
			const el = state.activeElement;
			return el
				? {
						tagName: el.tagName,
						getAttribute: () => (el.editable ? "" : null),
					}
				: null;
		},
	} as unknown as Document;
	globalThis.requestAnimationFrame = (fn) => {
		fn(0);
		return 1;
	};
	globalThis.cancelAnimationFrame = () => {};
	const vv = globalThis.window.visualViewport as unknown as typeof viewport;
	return {
		state,
		vv,
		pan: (y: number) => {
			state.scrollY = y;
		},
		focus: (tagName: string, editable?: true) => {
			state.activeElement = { tagName, editable };
		},
		blur: () => {
			state.activeElement = null;
			for (const fn of listeners) fn();
		},
		resize: () => {
			for (const fn of listeners) fn();
		},
		flushTimers: () => {
			for (const fn of timers.splice(0)) fn();
		},
		listenerCount: () => listeners.size,
		restore: () => {
			globalThis.window = previous.window;
			globalThis.document = previous.document;
			globalThis.requestAnimationFrame = previous.raf;
		},
	};
}

describe("viewport offset guard", () => {
	let page: ReturnType<typeof mountPage>;
	let stop: () => void;

	beforeEach(() => {
		page = mountPage();
		stop = installViewportOffsetGuard();
	});

	afterEach(() => {
		stop();
		page.restore();
	});

	test("snaps the document back once the input blurs", () => {
		page.focus("TEXTAREA");
		page.pan(200);
		page.blur();
		assert.equal(page.state.scrollY, 0);
		assert.equal(page.state.scrollToCalls, 1);
	});

	test("leaves the document alone while an input is focused", () => {
		page.focus("TEXTAREA");
		page.pan(200);
		page.resize();
		assert.equal(page.state.scrollY, 200);
		assert.equal(page.state.scrollToCalls, 0);
	});

	test("treats contenteditable as a focused input", () => {
		page.focus("DIV", true);
		page.pan(120);
		page.resize();
		assert.equal(page.state.scrollY, 120);
	});

	test("leaves a pinch-zoomed viewport alone", () => {
		page.vv.scale = 2;
		page.pan(300);
		page.resize();
		assert.equal(page.state.scrollY, 300);
		assert.equal(page.state.scrollToCalls, 0);
	});

	test("does not scroll when the document is already at origin", () => {
		page.resize();
		page.blur();
		page.flushTimers();
		assert.equal(page.state.scrollToCalls, 0);
	});

	test("late passes catch an offset left behind by the keyboard animation", () => {
		page.focus("TEXTAREA");
		page.blur();
		page.pan(90);
		page.flushTimers();
		assert.equal(page.state.scrollY, 0);
		assert.equal(page.state.scrollToCalls, 1);
	});

	test("cleanup removes listeners and silences pending timers", () => {
		page.focus("TEXTAREA");
		page.blur();
		stop();
		assert.equal(page.listenerCount(), 0);
		page.pan(70);
		page.flushTimers();
		assert.equal(page.state.scrollY, 70);
	});
});
