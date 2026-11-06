export type TurnRailMarkerAnchor = {
	sequence: number;
	absoluteTop: number;
	offsetHeight: number;
};

/**
 * Find the current turn for a content-space probe point (scrollTop plus the
 * viewport probe offset). Anchors ascend by document position, so the current
 * turn is the closest one at or above the probe — the first one when the
 * probe sits above them all. Replaces the former per-node viewport scan with
 * a binary search over cached geometry.
 */
export function findCurrentTurnAnchorSequence(
	anchors: TurnRailMarkerAnchor[],
	probe: number,
): number | null {
	if (anchors.length === 0) return null;
	let low = 0;
	let high = anchors.length - 1;
	let candidate = -1;
	while (low <= high) {
		const mid = (low + high) >> 1;
		if (anchors[mid].absoluteTop <= probe) {
			candidate = mid;
			low = mid + 1;
		} else {
			high = mid - 1;
		}
	}
	return anchors[candidate >= 0 ? candidate : 0].sequence;
}

/**
 * Map loaded user-turn anchors onto the custom scroll rail as a content minimap.
 *
 * Tops are document fractions of the timeline content range that starts at the
 * first measured user turn, so the first user message sits flush at the rail
 * top. Jump/scroll comfort offsets are intentionally excluded — those belong
 * only to scroll-into-view behavior, not marker placement.
 */
export function measureTurnRailMarkers(input: {
	scrollHeight: number;
	clientHeight: number;
	anchors: TurnRailMarkerAnchor[];
}): { positions: Record<number, number>; heights: Record<number, number> } {
	const scrollHeight = Math.max(1, input.scrollHeight);
	const anchors = input.anchors.filter((anchor) =>
		Number.isFinite(anchor.sequence),
	);
	if (anchors.length === 0) {
		return { positions: {}, heights: {} };
	}

	// Content origin = first user bubble top (includes timeline padding). Zeroing
	// here keeps the first turn marker flush with the rail top.
	const origin = Math.min(
		...anchors.map((anchor) => Math.max(0, anchor.absoluteTop)),
	);
	const contentSpan = Math.max(1, scrollHeight - origin);

	const ranges = anchors.map((anchor, index) => {
		const start = Math.max(0, anchor.absoluteTop - origin);
		const next = anchors[index + 1];
		const nextStart = next
			? Math.max(0, next.absoluteTop - origin)
			: contentSpan;
		return {
			sequence: anchor.sequence,
			offsetHeight: anchor.offsetHeight,
			start,
			end: Math.max(start, nextStart),
		};
	});

	const positions: Record<number, number> = {};
	const heights: Record<number, number> = {};
	for (const range of ranges) {
		const turnHeight = Math.max(range.offsetHeight, range.end - range.start);
		const position = Math.min(
			100,
			Math.max(0, (range.start / contentSpan) * 100),
		);
		positions[range.sequence] = Math.round(position * 10) / 10;
		const heightPercent = (turnHeight / contentSpan) * 100;
		heights[range.sequence] = Math.round(
			Math.min(22, Math.max(8, heightPercent)),
		);
	}
	return { positions, heights };
}
