/**
 * Pure logic for the touch/pen drag layer.
 *
 * HTML5 drag and drop never fires on touch, so mobile needs its own gesture.
 * Everything here is side-effect free so the timing, hit-test ordering and
 * payload mapping can be unit tested without a DOM; `pointer-drag.svelte.ts`
 * wires it to real pointer events.
 */

/** Press duration before a drag takes over from a tap / scroll. */
export const POINTER_DRAG_ACTIVATE_MS = 350;
/** Movement past this before activation means the user meant to scroll. */
export const POINTER_DRAG_ACTIVATE_TOLERANCE_PX = 10;
/** Horizontal travel out of the source surface before it retracts. */
export const POINTER_DRAG_RETRACT_THRESHOLD_PX = 24;
/** Distance from a scroll container edge where autoscroll kicks in. */
export const POINTER_DRAG_AUTOSCROLL_ZONE_PX = 56;
/** Autoscroll speed at the very edge, in px per frame. */
export const POINTER_DRAG_AUTOSCROLL_MAX_PX = 14;
/** Ghost fly-back duration when a drag is released over nothing. */
export const POINTER_DRAG_SETTLE_MS = 180;
/**
 * Window after a drag ends during which a click on the source is swallowed.
 *
 * A touch release synthesises a click right after `pointerup`; long enough to
 * catch it, short enough that a deliberate follow-up tap still registers.
 */
export const POINTER_DRAG_CLICK_SUPPRESS_MS = 400;

export type PointerDragItemType = "file" | "dir" | "app";

export type PointerDragItem = {
	type: PointerDragItemType;
	path: string;
	name: string;
	mimeType?: string | null;
	size?: number;
	mtimeMs?: number;
	appId?: string;
	appRef?: string;
	appUrl?: string;
	icon?: string;
};

export type PointerDragOrigin =
	| "space-file-tree"
	| "apps-sidebar"
	| "side-panel";

export type PointerDragPayload = {
	origin: PointerDragOrigin;
	items: PointerDragItem[];
};

/** What a zone will do with the current payload, surfaced on the ghost. */
export type PointerDragIntent = {
	/** Short imperative label, e.g. `Add to board`. */
	label: string;
	/** `copy` places a reference; `move` relocates the source. */
	effect: "copy" | "move";
};

export type PointerDropZone = {
	/** Zone priority; higher wins when zones overlap at the same point. */
	priority?: number;
	/** Return null to decline this payload, so an outer zone can claim it. */
	resolve: (payload: PointerDragPayload) => PointerDragIntent | null;
	drop: (
		payload: PointerDragPayload,
		point: { clientX: number; clientY: number },
	) => void;
};

/** Only touch and pen need the gesture; mouse keeps native drag and drop. */
export function isPointerDragPointerType(pointerType: string): boolean {
	return pointerType === "touch" || pointerType === "pen";
}

/** True while the press is still within the slop that allows activation. */
export function isWithinActivateTolerance(dx: number, dy: number): boolean {
	return Math.hypot(dx, dy) <= POINTER_DRAG_ACTIVATE_TOLERANCE_PX;
}

/**
 * Autoscroll step for a pointer near a scroll container's vertical edges.
 * Ramps linearly from 0 at the zone boundary to the max at the edge itself.
 */
export function autoscrollStep(
	pointerY: number,
	rect: { top: number; bottom: number },
): number {
	const zone = POINTER_DRAG_AUTOSCROLL_ZONE_PX;
	const fromTop = pointerY - rect.top;
	const fromBottom = rect.bottom - pointerY;
	if (fromTop < zone) {
		const ratio = Math.min(Math.max(1 - fromTop / zone, 0), 1);
		return -Math.round(ratio * POINTER_DRAG_AUTOSCROLL_MAX_PX);
	}
	if (fromBottom < zone) {
		const ratio = Math.min(Math.max(1 - fromBottom / zone, 0), 1);
		return Math.round(ratio * POINTER_DRAG_AUTOSCROLL_MAX_PX);
	}
	return 0;
}

/**
 * Pick the zone that claims the payload.
 *
 * `candidates` is expected in topmost-first order (as `elementsFromPoint`
 * returns), so an inner folder row is offered the payload before the tree root
 * behind it. An explicit priority overrides that order for zones that are not
 * nested, and declining (`resolve` → null) falls through to the next candidate.
 */
export function pickDropZone<T extends { zone: PointerDropZone }>(
	candidates: T[],
	payload: PointerDragPayload,
): { candidate: T; intent: PointerDragIntent } | null {
	const ordered = candidates
		.map((candidate, index) => ({ candidate, index }))
		.sort(
			(a, b) =>
				(b.candidate.zone.priority ?? 0) - (a.candidate.zone.priority ?? 0) ||
				a.index - b.index,
		);
	for (const { candidate } of ordered) {
		const intent = candidate.zone.resolve(payload);
		if (intent) return { candidate, intent };
	}
	return null;
}

/**
 * Whether the pointer has left the source surface far enough to retract it.
 * Only horizontal travel counts: the surface is an edge drawer, so vertical
 * movement inside it is scrolling, not an exit.
 */
export function hasLeftRetractSurface(
	clientX: number,
	rect: { left: number; right: number },
): boolean {
	const threshold = POINTER_DRAG_RETRACT_THRESHOLD_PX;
	return clientX < rect.left - threshold || clientX > rect.right + threshold;
}

/** Ghost label for a payload: the single item's name, or a count. */
export function describePointerDragPayload(
	payload: PointerDragPayload,
): string {
	const [first] = payload.items;
	if (!first) return "";
	if (payload.items.length === 1) return first.name;
	return `${payload.items.length} items`;
}

export type BoardDropItem = {
	path: string;
	snapshot?: {
		title?: string;
		mimeType?: string;
		size?: number;
		mtimeMs?: number;
	};
};

/**
 * Map a payload to board drop items.
 *
 * Directories are skipped: a board card references a single file, so a folder
 * has nothing to place. Returning an empty array lets the zone decline rather
 * than create nothing on drop.
 */
export function toBoardDropItems(payload: PointerDragPayload): BoardDropItem[] {
	const items: BoardDropItem[] = [];
	for (const item of payload.items) {
		if (item.type !== "file") continue;
		const path = item.path?.replace(/\/$/, "");
		if (!path) continue;
		items.push({
			path,
			snapshot: {
				title: item.name,
				mimeType: item.mimeType ?? undefined,
				size: item.size,
				mtimeMs: item.mtimeMs,
			},
		});
	}
	return items;
}
