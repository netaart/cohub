import { COMPACT_SHELL_MAX_WIDTH_PX } from "./breakpoints.ts";

const QUERY = `(max-width: ${COMPACT_SHELL_MAX_WIDTH_PX}px)`;

// One shared listener: every consumer reads the same reactive shell width.
let compact = $state(
	typeof window !== "undefined" && window.matchMedia(QUERY).matches,
);

if (typeof window !== "undefined") {
	window.matchMedia(QUERY).addEventListener("change", (event) => {
		compact = event.matches;
	});
}

/** Reactive: is the shell at compact (mobile) width, i.e. under 960px? */
export function useCompactShell(): boolean {
	return compact;
}
