import { toSpaceIdPath } from "$lib/stores/space-address";
import { COMPACT_SHELL_MAX_WIDTH_PX } from "./layout/breakpoints.ts";

/**
 * Mobile IM-style navigation transitions (View Transitions API).
 * Path matchers are pure; viewport gates live in resolve helpers.
 */
export type MobileSessionNavTransition = "session-forward" | "session-back";

const NAV_TRANSITION_ATTR = "data-nav-transition";

type ViewTransitionDocument = Document & {
	startViewTransition?: (callback: () => void | Promise<void>) => {
		finished: Promise<void>;
		ready: Promise<void>;
		updateCallbackDone: Promise<void>;
	};
};

export function isSessionsListPath(pathname: string): boolean {
	return pathname === "/sessions" || pathname === "/sessions/";
}

/** Cross-space new-chat draft on the sessions inbox. */
export function isUserNewSessionPath(pathname: string): boolean {
	return pathname === "/sessions/new" || pathname === "/sessions/new/";
}

/** Space root, which renders the new-session draft. */
export function isSpaceSessionLandingPath(pathname: string): boolean {
	const match = toSpaceIdPath(pathname).match(/^\/spaces\/([^/]+)\/?$/);
	return Boolean(match && match[1] !== "new");
}

/** Space-scoped chat detail (not the new landing). */
export function isSpaceSessionDetailPath(pathname: string): boolean {
	const match = toSpaceIdPath(pathname).match(
		/^\/spaces\/[^/]+\/sessions\/([^/]+)\/?$/,
	);
	if (!match) return false;
	return match[1] !== "new";
}

export function isCompactViewport(): boolean {
	if (typeof window === "undefined") return false;
	return window.innerWidth <= COMPACT_SHELL_MAX_WIDTH_PX;
}

export function prefersReducedMotion(): boolean {
	if (typeof window === "undefined") return false;
	return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/**
 * Pure path pair → transition kind. Viewport / a11y gates are separate so
 * unit tests can cover routing without a browser.
 */
export function matchMobileSessionNavTransition(
	fromPath: string,
	toPath: string,
): MobileSessionNavTransition | null {
	if (
		isSessionsListPath(fromPath) &&
		(isSpaceSessionLandingPath(toPath) ||
			isSpaceSessionDetailPath(toPath) ||
			isUserNewSessionPath(toPath))
	) {
		return "session-forward";
	}
	if (
		(isSpaceSessionLandingPath(fromPath) ||
			isSpaceSessionDetailPath(fromPath) ||
			isUserNewSessionPath(fromPath)) &&
		isSessionsListPath(toPath)
	) {
		return "session-back";
	}
	return null;
}

/**
 * Mobile IM-style push between the global Chats list and a space session.
 * Desktop keeps an instant swap (split pane already shows the conversation).
 */
export function resolveMobileSessionNavTransition(
	fromPath: string,
	toPath: string,
): MobileSessionNavTransition | null {
	if (!isCompactViewport() || prefersReducedMotion()) return null;
	return matchMobileSessionNavTransition(fromPath, toPath);
}

/**
 * Wire into SvelteKit `onNavigate`. Returns a Promise that SvelteKit awaits
 * so the DOM update runs inside `document.startViewTransition`.
 *
 * @see https://svelte.dev/docs/kit/$app-navigation#onNavigate
 */
export function beginMobileSessionViewTransition(
	kind: MobileSessionNavTransition,
	navigation: { complete: Promise<void> },
): Promise<void> | void {
	if (typeof document === "undefined") return;
	const doc = document as ViewTransitionDocument;
	if (!doc.startViewTransition) return;

	const root = document.documentElement;
	root.setAttribute(NAV_TRANSITION_ATTR, kind);

	return new Promise<void>((resolve) => {
		const transition = doc.startViewTransition(async () => {
			resolve();
			await navigation.complete;
		});
		void transition.finished
			.finally(() => {
				if (root.getAttribute(NAV_TRANSITION_ATTR) === kind) {
					root.removeAttribute(NAV_TRANSITION_ATTR);
				}
			})
			.catch(() => undefined);
	});
}
