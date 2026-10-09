export type GallerySwipeOffset = { x: number; y: number };
export type GallerySwipeOutcome = "prev" | "next" | "dismiss" | null;

export type GallerySwipeOptions = {
	/** Return false to leave the pointer to the content (controls, zoomed image). */
	canStart: (event: PointerEvent) => boolean;
	canPrev: () => boolean;
	canNext: () => boolean;
	onMove: (offset: GallerySwipeOffset) => void;
	/** Fires once per gesture that moved; `null` means snap back. */
	onEnd: (outcome: GallerySwipeOutcome) => void;
};

const AXIS_LOCK_PX = 8;
const EDGE_RESISTANCE = 0.3;
const PAGE_RATIO = 0.2;
const DISMISS_PX = 120;
const FLICK_PX_PER_MS = 0.4;
const FLICK_MIN_PX = 24;

type Track = {
	pointerId: number;
	width: number;
	startX: number;
	startY: number;
	lastX: number;
	lastY: number;
	lastTime: number;
	velocityX: number;
	velocityY: number;
	axis: "x" | "y" | null;
};

/**
 * Touch gallery gesture: horizontal drag pages, downward drag dismisses.
 * Mouse drags are ignored (desktop pages with arrows and keys), and a second
 * finger hands the gesture to pinch zoom.
 */
export function createGallerySwipe(options: GallerySwipeOptions) {
	const pointers = new Set<number>();
	let track: Track | null = null;

	function abort() {
		const moved = track?.axis != null;
		track = null;
		if (moved) options.onEnd(null);
	}

	function onPointerDown(event: PointerEvent) {
		pointers.add(event.pointerId);
		if (pointers.size > 1) return abort();
		if (event.pointerType === "mouse" || !options.canStart(event)) return;
		track = {
			pointerId: event.pointerId,
			width: (event.currentTarget as HTMLElement | null)?.clientWidth ?? 0,
			startX: event.clientX,
			startY: event.clientY,
			lastX: event.clientX,
			lastY: event.clientY,
			lastTime: event.timeStamp,
			velocityX: 0,
			velocityY: 0,
			axis: null,
		};
	}

	function onPointerMove(event: PointerEvent) {
		if (!track || track.pointerId !== event.pointerId) return;
		const elapsed = Math.max(1, event.timeStamp - track.lastTime);
		track.velocityX = (event.clientX - track.lastX) / elapsed;
		track.velocityY = (event.clientY - track.lastY) / elapsed;
		track.lastX = event.clientX;
		track.lastY = event.clientY;
		track.lastTime = event.timeStamp;

		const dx = event.clientX - track.startX;
		const dy = event.clientY - track.startY;
		if (!track.axis) {
			if (Math.max(Math.abs(dx), Math.abs(dy)) < AXIS_LOCK_PX) return;
			track.axis = Math.abs(dx) >= Math.abs(dy) ? "x" : "y";
			// Upward drags have no meaning here; let the gesture go.
			if (track.axis === "y" && dy < 0) {
				track = null;
				return;
			}
		}

		if (track.axis === "x") {
			const open = dx > 0 ? options.canPrev() : options.canNext();
			options.onMove({ x: open ? dx : dx * EDGE_RESISTANCE, y: 0 });
		} else {
			options.onMove({ x: 0, y: Math.max(0, dy) });
		}
	}

	function outcome(current: Track, event: PointerEvent): GallerySwipeOutcome {
		if (current.axis === "y") {
			const dy = event.clientY - current.startY;
			const flick = current.velocityY > FLICK_PX_PER_MS && dy > FLICK_MIN_PX;
			return dy > DISMISS_PX || flick ? "dismiss" : null;
		}
		const dx = event.clientX - current.startX;
		const flick =
			Math.abs(current.velocityX) > FLICK_PX_PER_MS &&
			Math.abs(dx) > FLICK_MIN_PX &&
			Math.sign(current.velocityX) === Math.sign(dx);
		if (Math.abs(dx) < current.width * PAGE_RATIO && !flick) return null;
		if (dx > 0) return options.canPrev() ? "prev" : null;
		return options.canNext() ? "next" : null;
	}

	function onPointerUp(event: PointerEvent) {
		pointers.delete(event.pointerId);
		if (!track || track.pointerId !== event.pointerId) return;
		const current = track;
		track = null;
		if (current.axis) options.onEnd(outcome(current, event));
	}

	function onPointerCancel(event: PointerEvent) {
		pointers.delete(event.pointerId);
		if (track?.pointerId === event.pointerId) abort();
	}

	function reset() {
		pointers.clear();
		track = null;
	}

	return { onPointerDown, onPointerMove, onPointerUp, onPointerCancel, reset };
}
