import { prefersReducedMotion } from "$lib/navigation-transition";

export const COMPOSER_BOUNDS_SELECTOR = "[data-composer-bounds]";
export const COMPOSER_CHROME_SELECTOR = "[data-composer-chrome]";

export const COMPACT_COMPOSER_MIN_HEIGHT = 44;
const COMPACT_COMPOSER_MAX_HEIGHT = 220;

const EXPANDED_COMPOSER_MIN_HEIGHT = { desktop: 168, mobile: 144 };
const EXPANDED_COMPOSER_TOP_GAP = { desktop: 96, mobile: 12 };

export function getCompactComposerMaxHeight(
	viewportHeight: number,
	mobile: boolean,
): number {
	return Math.max(
		COMPACT_COMPOSER_MIN_HEIGHT,
		Math.min(
			viewportHeight * (mobile ? 0.34 : 0.38),
			COMPACT_COMPOSER_MAX_HEIGHT,
		),
	);
}

export type ExpandedComposerGeometry = {
	boundsHeight: number;
	viewportHeight: number;
	chromeHeight: number;
	inputHeight: number;
	mobile: boolean;
};

export function getExpandedComposerHeight({
	boundsHeight,
	viewportHeight,
	chromeHeight,
	inputHeight,
	mobile,
}: ExpandedComposerGeometry): number {
	const variant = mobile ? "mobile" : "desktop";
	const room =
		Math.min(boundsHeight, viewportHeight) -
		(chromeHeight - inputHeight) -
		EXPANDED_COMPOSER_TOP_GAP[variant];
	return Math.max(EXPANDED_COMPOSER_MIN_HEIGHT[variant], Math.floor(room));
}

export function getBottomAnchoredScrollTop({
	scrollTop,
	scrollHeight,
	fromHeight,
	toHeight,
}: {
	scrollTop: number;
	scrollHeight: number;
	fromHeight: number;
	toHeight: number;
}): number {
	const maxScrollTop = Math.max(0, scrollHeight - toHeight);
	return Math.min(Math.max(0, scrollTop + fromHeight - toHeight), maxScrollTop);
}

export type ComposerMenuPlacement = "above" | "inside-top" | "inside-bottom";

export const COMPOSER_MENU_LAYER: Record<
	ComposerMenuPlacement,
	{ desktop: string; mobile: string; card: string }
> = {
	above: {
		desktop: "bottom-[calc(100%+0.75rem)] md:block",
		mobile: "bottom-[calc(100%+0.5rem)]",
		card: "",
	},
	"inside-top": {
		desktop: "inset-y-0 md:flex md:flex-col",
		mobile: "pointer-events-none inset-y-0 flex flex-col",
		card: "flex max-h-full flex-col",
	},
	"inside-bottom": {
		desktop: "inset-y-0 md:flex md:flex-col md:justify-end",
		mobile: "pointer-events-none inset-y-0 flex flex-col justify-end",
		card: "flex max-h-full flex-col",
	},
};

const TRANSITION_ATTR = "data-composer-transition";
const TRANSITION_NAME = "session-composer";
let activeTransition: object | null = null;

export function runComposerResizeTransition(
	surface: HTMLElement | null,
	update: () => void,
) {
	if (
		!surface ||
		typeof document.startViewTransition !== "function" ||
		prefersReducedMotion()
	) {
		update();
		return;
	}

	const root = document.documentElement;
	const token = {};
	activeTransition = token;
	root.setAttribute(TRANSITION_ATTR, "");
	surface.style.viewTransitionName = TRANSITION_NAME;
	void document
		.startViewTransition(update)
		.finished.finally(() => {
			if (activeTransition !== token) return;
			activeTransition = null;
			root.removeAttribute(TRANSITION_ATTR);
			surface.style.removeProperty("view-transition-name");
		})
		.catch(() => undefined);
}
