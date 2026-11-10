import { DURATION_PANEL } from "$lib/motion";

export function prefersReducedMotionNow(): boolean {
	if (typeof window === "undefined") return false;
	return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/**
 * Keep DOM mounted through an exit animation, then unmount.
 *
 * - visible → mount immediately (and cancel any pending unmount)
 * - hidden → stay mounted for `durationMs`, then unmount
 * - reduced motion / SSR / duration ≤ 0 → unmount immediately
 *
 * Initial `mounted` matches the first `getVisible()` so cold start never
 * mounts-then-tears-down when already hidden.
 */
export function createDeferredMount(
	getVisible: () => boolean,
	getDurationMs: () => number = () => DURATION_PANEL,
) {
	let mounted = $state(getVisible());

	$effect(() => {
		if (getVisible()) {
			mounted = true;
			return;
		}
		const durationMs = getDurationMs();
		if (
			typeof window === "undefined" ||
			prefersReducedMotionNow() ||
			durationMs <= 0
		) {
			mounted = false;
			return;
		}
		const timer = window.setTimeout(() => {
			mounted = false;
		}, durationMs);
		return () => window.clearTimeout(timer);
	});

	return {
		get mounted() {
			return mounted;
		},
	};
}
