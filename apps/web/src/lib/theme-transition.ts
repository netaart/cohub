import { setTheme } from "#lib/theme.svelte.ts";
import type { ThemeMode } from "#lib/theme-registry.ts";

type ViewTransitionDocument = Document & {
	startViewTransition?: (callback: () => void) => {
		finished: Promise<void>;
	};
};

const TRANSITION_ATTR = "data-theme-transition";
const CIRCLE_TRANSITION = "circle";

function prefersReducedMotion(): boolean {
	return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

function getTransitionOrigin(event?: MouseEvent): { x: number; y: number } {
	if (!(event?.currentTarget instanceof HTMLElement)) {
		return { x: window.innerWidth / 2, y: window.innerHeight / 2 };
	}

	const rect = event.currentTarget.getBoundingClientRect();
	return {
		x: rect.left + rect.width / 2,
		y: rect.top + rect.height / 2,
	};
}

function getTransitionRadius(origin: { x: number; y: number }): number {
	return Math.hypot(
		Math.max(origin.x, window.innerWidth - origin.x),
		Math.max(origin.y, window.innerHeight - origin.y),
	);
}

export function setThemeWithTransition(mode: ThemeMode, event?: MouseEvent) {
	if (typeof document === "undefined" || typeof window === "undefined") {
		setTheme(mode);
		return;
	}

	const viewTransitionDocument = document as ViewTransitionDocument;
	if (!viewTransitionDocument.startViewTransition || prefersReducedMotion()) {
		setTheme(mode);
		return;
	}

	const origin = getTransitionOrigin(event);
	const radius = getTransitionRadius(origin);
	const root = document.documentElement;
	root.style.setProperty("--theme-transition-x", `${origin.x}px`);
	root.style.setProperty("--theme-transition-y", `${origin.y}px`);
	root.style.setProperty("--theme-transition-radius", `${radius}px`);

	const transition = viewTransitionDocument.startViewTransition(() => {
		root.setAttribute(TRANSITION_ATTR, CIRCLE_TRANSITION);
		setTheme(mode);
	});

	void transition.finished
		.finally(() => {
			root.removeAttribute(TRANSITION_ATTR);
			root.style.removeProperty("--theme-transition-x");
			root.style.removeProperty("--theme-transition-y");
			root.style.removeProperty("--theme-transition-radius");
		})
		.catch(() => undefined);
}
