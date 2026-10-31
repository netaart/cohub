/**
 * What a score text amounts to before the dialect reads it: an empty score has no view, any other
 * text is handed to the dialect as written.
 */
export type ScoreViewState =
	| { kind: "empty" }
	| { kind: "score"; text: string };

export function scoreViewState(
	text: string | null | undefined,
): ScoreViewState {
	if (typeof text !== "string" || text.trim() === "") return { kind: "empty" };
	return { kind: "score", text };
}

/**
 * The position the staff cursor takes for an audio element's current time: the same seconds, or
 * no cursor while the time is not a readable position.
 */
export function scorePlayPosition(
	seconds: number | null | undefined,
): number | null {
	return typeof seconds === "number" && Number.isFinite(seconds) && seconds >= 0
		? seconds
		: null;
}
