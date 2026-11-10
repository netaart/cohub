// Mirrors --ease-* (styles/theme.css) and --motion-panel-* (app.css).

import { prefersReducedMotion } from "svelte/motion";
import type { TransitionConfig } from "svelte/transition";

export const DURATION_MODAL_IN = 200;
export const DURATION_MODAL_OUT = 100;
export const DURATION_DRAWER_IN = 240;
export const DURATION_DRAWER_OUT = 180;
export const DURATION_PANEL = 280;
export const DURATION_PANEL_FADE_COLLAPSE = 120;

export const EASE_OUT = "cubic-bezier(0.16, 1, 0.3, 1)";
export const EASE_DRAWER = "cubic-bezier(0.32, 0.72, 0, 1)";

function cubicBezier(css: string): (t: number) => number {
	const n = String.raw`\s*(-?\d*\.?\d+)\s*`;
	const match = css.match(
		new RegExp(`^cubic-bezier\\(${n},${n},${n},${n}\\)$`),
	);
	const [x1, y1, x2, y2] = match?.slice(1).map(Number) ?? [];
	if (!match || [x1, x2].some((x) => x < 0 || x > 1))
		throw new Error(`Invalid cubic-bezier: ${css}`);
	const at = (a1: number, a2: number, t: number) =>
		((1 - 3 * a2 + 3 * a1) * t + (3 * a2 - 6 * a1)) * t * t + 3 * a1 * t;
	return (x) => {
		if (x <= 0) return 0;
		if (x >= 1) return 1;
		let lo = 0;
		let hi = 1;
		for (let i = 0; i < 20; i++) {
			const mid = (lo + hi) / 2;
			if (at(x1, x2, mid) < x) lo = mid;
			else hi = mid;
		}
		return at(y1, y2, (lo + hi) / 2);
	};
}

export const easeOut = cubicBezier(EASE_OUT);
const easeDrawer = cubicBezier(EASE_DRAWER);

// Svelte transitions are local: the element's nearest block must be the
// `{#if open}` itself (`{:else if}` is fine), or it never plays.

type OverlayKind = "fade" | "pop" | "sheet";

const MOVES: Record<OverlayKind, ((u: number) => string) | null> = {
	fade: null,
	pop: (u) => `opacity: ${1 - u}; scale: ${1 - u * 0.04}`,
	sheet: (u) => `translate: 0 ${u * 100}%`,
};

export function overlay(
	_node: Element,
	{
		kind = "fade",
		drawer = kind === "sheet",
	}: { kind?: OverlayKind; drawer?: boolean } = {},
) {
	return (run?: { direction: "in" | "out" }): TransitionConfig => {
		const move = prefersReducedMotion.current ? null : MOVES[kind];
		const [inMs, outMs] = drawer
			? [DURATION_DRAWER_IN, DURATION_DRAWER_OUT]
			: [DURATION_MODAL_IN, DURATION_MODAL_OUT];
		return {
			duration: run?.direction === "out" ? outMs : inMs,
			easing: kind === "sheet" && move ? easeDrawer : easeOut,
			css: move ? (_t, u) => move(u) : (t) => `opacity: ${t}`,
		};
	};
}

export function drawerTransition(open: boolean) {
	const ms = open ? DURATION_DRAWER_IN : DURATION_DRAWER_OUT;
	return {
		panel: prefersReducedMotion.current
			? "none"
			: `transform ${ms}ms ${EASE_DRAWER}`,
		backdrop: `opacity ${ms}ms ${EASE_OUT}`,
	};
}
