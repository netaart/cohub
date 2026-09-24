import type {
	BoardCameraFocus,
	BoardCameraFocusParams,
	BoardCameraState,
} from "@cohub/protocol";
import type { BoardFrame, BoardViewport } from "@cohub/protocol/board-document";

export type Point = { x: number; y: number };
export type Rect = { x: number; y: number; width: number; height: number };
export type Size = { width: number; height: number };

// Branded point types. The brand is phantom (no runtime cost) but makes
// screen and world coordinates incompatible at compile time, so a screen
// point can never be fed into world-space hit testing (or vice versa).
declare const coordBrand: unique symbol;
/** Surface-relative screen coordinate, in CSS pixels. */
export type ScreenPoint = {
	x: number;
	y: number;
	readonly [coordBrand]: "screen";
};
/** Board world coordinate, in board units. */
export type WorldPoint = {
	x: number;
	y: number;
	readonly [coordBrand]: "world";
};

export type BoardScreenPoint = ScreenPoint;
export type BoardWorldPoint = WorldPoint;

declare const coordinateKindBrand: unique symbol;
export type BoardWorldOffset = Point & {
	readonly [coordinateKindBrand]: "world-offset";
};
export type BoardScreenOffset = Point & {
	readonly [coordinateKindBrand]: "screen-offset";
};
export type BoardNormalizedPoint = Point & {
	readonly [coordinateKindBrand]: "normalized";
};
export type BoardWorldRect = Rect & {
	readonly [coordinateKindBrand]: "world-rect";
};

export function screenPoint(x: number, y: number): ScreenPoint {
	return { x, y } as ScreenPoint;
}

export function worldPoint(x: number, y: number): WorldPoint {
	return { x, y } as WorldPoint;
}

export function worldOffset(x: number, y: number): BoardWorldOffset {
	return { x, y } as BoardWorldOffset;
}

export function screenOffset(x: number, y: number): BoardScreenOffset {
	return { x, y } as BoardScreenOffset;
}

export function normalizedPoint(x: number, y: number): BoardNormalizedPoint {
	return { x: clamp(x, 0, 1), y: clamp(y, 0, 1) } as BoardNormalizedPoint;
}

export function worldRect(
	x: number,
	y: number,
	width: number,
	height: number,
): BoardWorldRect {
	return { x, y, width, height } as BoardWorldRect;
}

export const MIN_BOARD_ZOOM = 0.05;
export const MAX_BOARD_ZOOM = 8;
const DEFAULT_BOARD_VIEWPORT: BoardViewport = { x: 0, y: 0, zoom: 1 };
/** Smallest an item can be resized to, in world units. */
export const MIN_ITEM_SIZE = 24;
/** Extra world-space padding applied when fitting content into view. */
export const FIT_PADDING = 64;
/**
 * Fraction of the viewport's larger dimension used as an off-screen margin for
 * both card culling and texture preloading. Keeping them equal means a card's
 * texture is already requested before the card scrolls into view.
 */
export const VIEWPORT_MARGIN_RATIO = 0.5;

/** Viewport plus margin, snapped to a grid so small pans return the same rect. */
export function stableCullRect(view: Rect): Rect {
	const margin = Math.max(view.width, view.height, 1) * VIEWPORT_MARGIN_RATIO;
	const step = 2 ** Math.floor(Math.log2(margin / 2));
	const left = Math.floor((view.x - margin) / step) * step;
	const top = Math.floor((view.y - margin) / step) * step;
	const right = Math.ceil((view.x + view.width + margin) / step) * step;
	const bottom = Math.ceil((view.y + view.height + margin) / step) * step;
	return { x: left, y: top, width: right - left, height: bottom - top };
}

export function clampZoom(zoom: number) {
	const value = Number.isFinite(zoom) ? zoom : DEFAULT_BOARD_VIEWPORT.zoom;
	return Math.min(MAX_BOARD_ZOOM, Math.max(MIN_BOARD_ZOOM, value));
}

/** Keep transient camera state finite without discarding its last valid axes. */
export function normalizeViewport(
	viewport: BoardViewport,
	fallback: BoardViewport = DEFAULT_BOARD_VIEWPORT,
): BoardViewport {
	const fallbackX = Number.isFinite(fallback.x)
		? fallback.x
		: DEFAULT_BOARD_VIEWPORT.x;
	const fallbackY = Number.isFinite(fallback.y)
		? fallback.y
		: DEFAULT_BOARD_VIEWPORT.y;
	const fallbackZoom = Number.isFinite(fallback.zoom)
		? clampZoom(fallback.zoom)
		: DEFAULT_BOARD_VIEWPORT.zoom;
	return {
		x: Number.isFinite(viewport.x) ? viewport.x : fallbackX,
		y: Number.isFinite(viewport.y) ? viewport.y : fallbackY,
		zoom: Number.isFinite(viewport.zoom)
			? clampZoom(viewport.zoom)
			: fallbackZoom,
	};
}

export function clamp(value: number, min: number, max: number) {
	return Math.min(max, Math.max(min, value));
}

export function degToRad(degrees: number) {
	return (degrees * Math.PI) / 180;
}

export function radToDeg(radians: number) {
	return (radians * 180) / Math.PI;
}

// ─── Basic rect / point helpers ─────────────────────────────────────

export function frameRect(frame: BoardFrame): Rect {
	return {
		x: frame.x,
		y: frame.y,
		width: frame.width,
		height: frame.height,
	};
}

export function rectCenter(rect: Rect): WorldPoint {
	return worldPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
}

export function rectsIntersect(a: Rect, b: Rect): boolean {
	return (
		a.x < b.x + b.width &&
		a.x + a.width > b.x &&
		a.y < b.y + b.height &&
		a.y + a.height > b.y
	);
}

export function rectContainsPoint(
	rect: Rect,
	point: Point,
	tolerance = 0,
): boolean {
	return (
		point.x >= rect.x - tolerance &&
		point.x <= rect.x + rect.width + tolerance &&
		point.y >= rect.y - tolerance &&
		point.y <= rect.y + rect.height + tolerance
	);
}

export function expandRect(rect: Rect, amount: number): Rect {
	return {
		x: rect.x - amount,
		y: rect.y - amount,
		width: rect.width + amount * 2,
		height: rect.height + amount * 2,
	};
}

export function pointsBounds(points: readonly Point[], minSize = 0): Rect | null {
	if (points.length === 0) return null;
	let minX = Number.POSITIVE_INFINITY;
	let minY = Number.POSITIVE_INFINITY;
	let maxX = Number.NEGATIVE_INFINITY;
	let maxY = Number.NEGATIVE_INFINITY;
	for (const point of points) {
		minX = Math.min(minX, point.x);
		minY = Math.min(minY, point.y);
		maxX = Math.max(maxX, point.x);
		maxY = Math.max(maxY, point.y);
	}
	return {
		x: minX,
		y: minY,
		width: Math.max(minSize, maxX - minX),
		height: Math.max(minSize, maxY - minY),
	};
}

export function unionRects(rects: Rect[]): Rect | null {
	if (rects.length === 0) return null;
	let minX = Number.POSITIVE_INFINITY;
	let minY = Number.POSITIVE_INFINITY;
	let maxX = Number.NEGATIVE_INFINITY;
	let maxY = Number.NEGATIVE_INFINITY;
	for (const rect of rects) {
		minX = Math.min(minX, rect.x);
		minY = Math.min(minY, rect.y);
		maxX = Math.max(maxX, rect.x + rect.width);
		maxY = Math.max(maxY, rect.y + rect.height);
	}
	return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

export function rotatePointAround<P extends Point>(
	point: P,
	center: Point,
	angleRad: number,
): P {
	const cos = Math.cos(angleRad);
	const sin = Math.sin(angleRad);
	const dx = point.x - center.x;
	const dy = point.y - center.y;
	return {
		x: center.x + dx * cos - dy * sin,
		y: center.y + dx * sin + dy * cos,
	} as P;
}

// ─── Item bounds (rotation aware) ───────────────────────────────────

/** Axis-aligned bounding box of a (possibly rotated) frame. */
export function itemBounds(frame: BoardFrame): Rect {
	const rotation = frame.rotation || 0;
	if (rotation === 0) return frameRect(frame);
	const center = rectCenter(frameRect(frame));
	const halfW = frame.width / 2;
	const halfH = frame.height / 2;
	const rad = degToRad(rotation);
	const cos = Math.abs(Math.cos(rad));
	const sin = Math.abs(Math.sin(rad));
	const boundW = halfW * cos + halfH * sin;
	const boundH = halfW * sin + halfH * cos;
	return {
		x: center.x - boundW,
		y: center.y - boundH,
		width: boundW * 2,
		height: boundH * 2,
	};
}

export function selectionBounds(frames: BoardFrame[]): Rect | null {
	return unionRects(frames.map(itemBounds));
}

/** Exact point-in-frame test, accounting for rotation. */
export function frameContainsPoint(
	frame: BoardFrame,
	point: WorldPoint,
): boolean {
	const rect = frameRect(frame);
	const rotation = frame.rotation || 0;
	let local = point;
	if (rotation !== 0) {
		local = rotatePointAround(point, rectCenter(rect), -degToRad(rotation));
	}
	return rectContainsPoint(rect, local);
}

/** World position of a resize handle on a single (possibly rotated) frame. */
export function frameHandlePosition(
	frame: BoardFrame,
	handle: ResizeHandle,
): WorldPoint {
	const rect = frameRect(frame);
	const position = handlePosition(rect, handle);
	const rotation = frame.rotation || 0;
	if (rotation === 0) return position;
	return rotatePointAround(position, rectCenter(rect), degToRad(rotation));
}

/** Corners in clockwise order, following the frame's rotation. */
export function frameCorners(frame: BoardFrame): readonly WorldPoint[] {
	return ["nw", "ne", "se", "sw"].map((handle) =>
		frameHandlePosition(frame, handle as ResizeHandle),
	);
}

// ─── Selection handles ──────────────────────────────────────────────

/** Screen-space radius (px) within which a pointer grabs a handle. */
export const HANDLE_HIT_RADIUS = 8;
/** Screen-space offset (px) from the selection's lower-facing edge. */
export const ROTATION_HANDLE_OFFSET = 28;

export function frameRayIntersection(
	frame: Rect & { rotation?: number },
	pointer: WorldPoint,
): WorldPoint {
	const center = rectCenter(frame);
	let dx = pointer.x - center.x;
	let dy = pointer.y - center.y;
	if (Math.hypot(dx, dy) < 0.0001) {
		dx = 0;
		dy = 1;
	}

	const rad = degToRad(frame.rotation || 0);
	const cos = Math.cos(rad);
	const sin = Math.sin(rad);
	const localDx = dx * cos + dy * sin;
	const localDy = -dx * sin + dy * cos;
	const scaleX =
		Math.abs(localDx) > 0.0001
			? frame.width / 2 / Math.abs(localDx)
			: Number.POSITIVE_INFINITY;
	const scaleY =
		Math.abs(localDy) > 0.0001
			? frame.height / 2 / Math.abs(localDy)
			: Number.POSITIVE_INFINITY;
	const scale = Math.min(scaleX, scaleY);
	return worldPoint(center.x + dx * scale, center.y + dy * scale);
}

export function rotationHandleAnchor(
	frame: Rect & { rotation?: number },
): WorldPoint {
	const center = rectCenter(frame);
	return frameRayIntersection(frame, worldPoint(center.x, center.y + 1));
}

export function rotationHandlePosition(
	frame: Rect & { rotation?: number },
	zoom: number,
): WorldPoint {
	const center = rectCenter(frame);
	const anchor = rotationHandleAnchor(frame);
	const offset = ROTATION_HANDLE_OFFSET / Math.max(zoom, 0.0001);
	return worldPoint(center.x, anchor.y + offset);
}

// ─── Resize ─────────────────────────────────────────────────────────

export type ResizeHandle = "nw" | "n" | "ne" | "e" | "se" | "s" | "sw" | "w";

export const CORNER_RESIZE_HANDLES = ["nw", "ne", "se", "sw"] as const;
export const EDGE_RESIZE_HANDLES = ["n", "e", "s", "w"] as const;
export type CornerResizeHandle = (typeof CORNER_RESIZE_HANDLES)[number];

/** Screen-space depth of the rotation zone outside each resize corner. */
export const CORNER_ROTATION_ZONE_WIDTH = 16;

export const RESIZE_HANDLES: ResizeHandle[] = [
	"nw",
	"n",
	"ne",
	"e",
	"se",
	"s",
	"sw",
	"w",
];

/**
 * Hit-test the outward quadrant around each corner, outside its resize target.
 * This gives fine pointers Figma-style corner rotation without adding chrome.
 */
export function frameCornerRotationHandleAt(
	frame: BoardFrame,
	point: WorldPoint,
	zoom: number,
	screenRadius = HANDLE_HIT_RADIUS,
): CornerResizeHandle | null {
	const rect = frameRect(frame);
	const center = rectCenter(rect);
	const local = frame.rotation
		? rotatePointAround(point, center, -degToRad(frame.rotation))
		: point;
	const safeZoom = Math.max(zoom, 0.0001);
	const innerRadius = screenRadius / safeZoom;
	const outerRadius =
		(screenRadius + CORNER_ROTATION_ZONE_WIDTH) / safeZoom;

	for (const handle of CORNER_RESIZE_HANDLES) {
		const corner = handlePosition(rect, handle);
		const direction = HANDLE_DIRECTION[handle];
		const outwardX = (local.x - corner.x) * direction.x;
		const outwardY = (local.y - corner.y) * direction.y;
		if (outwardX < -0.0001 || outwardY < -0.0001) continue;
		const distance = Math.hypot(outwardX, outwardY);
		if (distance > innerRadius && distance <= outerRadius) return handle;
	}

	return null;
}

/**
 * Hit-test the continuous edge zones of a rotated frame. Corners are inset so
 * their resize handles retain priority even on small nodes.
 */
export function frameEdgeHandleAt(
	frame: BoardFrame,
	point: WorldPoint,
	zoom: number,
	screenRadius = HANDLE_HIT_RADIUS,
): Extract<ResizeHandle, "n" | "e" | "s" | "w"> | null {
	const rect = frameRect(frame);
	const center = rectCenter(rect);
	const local = frame.rotation
		? rotatePointAround(point, center, -degToRad(frame.rotation))
		: point;
	const radius = screenRadius / Math.max(zoom, 0.0001);
	const insetX = Math.min(rect.width / 3, radius * 1.5);
	const insetY = Math.min(rect.height / 3, radius * 1.5);
	let closest: Extract<ResizeHandle, "n" | "e" | "s" | "w"> | null =
		null;
	let closestDistance = Number.POSITIVE_INFINITY;

	if (
		local.x >= rect.x + insetX &&
		local.x <= rect.x + rect.width - insetX
	) {
		const north = Math.abs(local.y - rect.y);
		const south = Math.abs(local.y - (rect.y + rect.height));
		if (north <= radius && north < closestDistance) {
			closest = "n";
			closestDistance = north;
		}
		if (south <= radius && south < closestDistance) {
			closest = "s";
			closestDistance = south;
		}
	}
	if (
		local.y >= rect.y + insetY &&
		local.y <= rect.y + rect.height - insetY
	) {
		const west = Math.abs(local.x - rect.x);
		const east = Math.abs(local.x - (rect.x + rect.width));
		if (west <= radius && west < closestDistance) {
			closest = "w";
			closestDistance = west;
		}
		if (east <= radius && east < closestDistance) closest = "e";
	}

	return closest;
}

/** Direction of a handle from the rect center: -1, 0, or 1 per axis. */
export const HANDLE_DIRECTION: Record<ResizeHandle, Point> = {
	nw: { x: -1, y: -1 },
	n: { x: 0, y: -1 },
	ne: { x: 1, y: -1 },
	e: { x: 1, y: 0 },
	se: { x: 1, y: 1 },
	s: { x: 0, y: 1 },
	sw: { x: -1, y: 1 },
	w: { x: -1, y: 0 },
};

/** Position of a handle on an unrotated rect. */
export function handlePosition(rect: Rect, handle: ResizeHandle): WorldPoint {
	const direction = HANDLE_DIRECTION[handle];
	return worldPoint(
		rect.x + rect.width / 2 + (direction.x * rect.width) / 2,
		rect.y + rect.height / 2 + (direction.y * rect.height) / 2,
	);
}

/** Resize a frame to exact dimensions while keeping the opposite handle fixed. */
export function resizeFrameToSize(
	frame: BoardFrame,
	handle: ResizeHandle,
	width: number,
	height: number,
): BoardFrame {
	const direction = HANDLE_DIRECTION[handle];
	const rect = frameRect(frame);
	const center = rectCenter(rect);
	const rad = degToRad(frame.rotation || 0);
	const anchorLocal = {
		x: (-direction.x * rect.width) / 2,
		y: (-direction.y * rect.height) / 2,
	};
	const anchor = rotatePointAround(
		{ x: center.x + anchorLocal.x, y: center.y + anchorLocal.y },
		center,
		rad,
	);
	const centerLocal = {
		x: (direction.x * width) / 2,
		y: (direction.y * height) / 2,
	};
	const nextCenter = rotatePointAround(
		{ x: anchor.x + centerLocal.x, y: anchor.y + centerLocal.y },
		anchor,
		rad,
	);
	return {
		x: nextCenter.x - width / 2,
		y: nextCenter.y - height / 2,
		width,
		height,
		rotation: frame.rotation || 0,
	};
}

/**
 * Resize a frame by dragging a handle to a world-space pointer position.
 * The edge/corner opposite the handle stays anchored. Works correctly for
 * rotated frames by performing the resize in the frame's local space.
 */
export function resizeFrame(
	frame: BoardFrame,
	handle: ResizeHandle,
	pointer: WorldPoint,
	minSize = MIN_ITEM_SIZE,
	/** Keep the original aspect ratio (Shift). */
	keepAspect = false,
): BoardFrame {
	const direction = HANDLE_DIRECTION[handle];
	const rect = frameRect(frame);
	const center = rectCenter(rect);
	const rad = degToRad(frame.rotation || 0);
	const aspect = rect.width / Math.max(rect.height, 0.0001);

	// Anchor = opposite edge/corner, held fixed during the resize.
	const anchorLocal = {
		x: (-direction.x * rect.width) / 2,
		y: (-direction.y * rect.height) / 2,
	};
	const anchor = rotatePointAround(
		{ x: center.x + anchorLocal.x, y: center.y + anchorLocal.y },
		center,
		rad,
	);

	// Express the pointer in the frame's unrotated local space, origin at anchor.
	const toLocal = rotatePointAround(pointer, anchor, -rad);
	const local = { x: toLocal.x - anchor.x, y: toLocal.y - anchor.y };

	let width =
		direction.x !== 0
			? clamp(direction.x * local.x, minSize, Number.POSITIVE_INFINITY)
			: rect.width;
	let height =
		direction.y !== 0
			? clamp(direction.y * local.y, minSize, Number.POSITIVE_INFINITY)
			: rect.height;

	if (keepAspect) {
		if (direction.x !== 0 && direction.y !== 0) {
			// Corner: pick the dominant axis and derive the other.
			if (Math.abs(width / aspect) > height) height = width / aspect;
			else width = height * aspect;
		} else if (direction.x !== 0) {
			height = width / aspect;
		} else if (direction.y !== 0) {
			width = height * aspect;
		}
		width = Math.max(minSize, width);
		height = Math.max(minSize, height);
	}

	return resizeFrameToSize(frame, handle, width, height);
}

/**
 * Proportionally scale a group of frames by dragging a corner handle of their
 * combined bounds. Individual rotations are preserved.
 */
export function scaleFrames(
	frames: BoardFrame[],
	bounds: Rect,
	handle: ResizeHandle,
	pointer: WorldPoint,
	minSize = MIN_ITEM_SIZE,
	scaleRange?: { min?: number; max?: number },
): BoardFrame[] {
	const direction = HANDLE_DIRECTION[handle];
	if (direction.x === 0 || direction.y === 0) return frames;
	const anchor = {
		x: bounds.x + bounds.width / 2 - (direction.x * bounds.width) / 2,
		y: bounds.y + bounds.height / 2 - (direction.y * bounds.height) / 2,
	};
	const original = handlePosition(bounds, handle);
	const originalDist = Math.hypot(original.x - anchor.x, original.y - anchor.y);
	const nextDist = Math.hypot(pointer.x - anchor.x, pointer.y - anchor.y);
	if (originalDist === 0) return frames;
	const frameMinScale = frames.reduce(
		(minimum, frame) =>
			Math.max(
				minimum,
				minSize / Math.max(0.0001, Math.min(frame.width, frame.height)),
			),
		0,
	);
	const minScale = Math.max(frameMinScale, scaleRange?.min ?? 0);
	const maxScale = Math.max(
		minScale,
		scaleRange?.max ?? Number.POSITIVE_INFINITY,
	);
	const scale = clamp(nextDist / originalDist, minScale, maxScale);
	return frames.map((frame) => {
		const center = rectCenter(frameRect(frame));
		const nextCenter = {
			x: anchor.x + (center.x - anchor.x) * scale,
			y: anchor.y + (center.y - anchor.y) * scale,
		};
		const width = frame.width * scale;
		const height = frame.height * scale;
		return {
			x: nextCenter.x - width / 2,
			y: nextCenter.y - height / 2,
			width,
			height,
			rotation: frame.rotation || 0,
		};
	});
}

// ─── Rotation ───────────────────────────────────────────────────────

/** Angle (degrees) from a center to a world-space pointer. */
export function angleFromCenter(
	center: WorldPoint,
	pointer: WorldPoint,
): number {
	return radToDeg(Math.atan2(pointer.y - center.y, pointer.x - center.x));
}

/**
 * Rotate a set of frames around a pivot by a delta (degrees). Each frame's
 * center orbits the pivot and its own rotation increases by the delta.
 */
export function rotateFrames(
	frames: BoardFrame[],
	pivot: WorldPoint,
	deltaDeg: number,
): BoardFrame[] {
	const rad = degToRad(deltaDeg);
	return frames.map((frame) => {
		const center = rectCenter(frameRect(frame));
		const nextCenter = rotatePointAround(center, pivot, rad);
		return {
			x: nextCenter.x - frame.width / 2,
			y: nextCenter.y - frame.height / 2,
			width: frame.width,
			height: frame.height,
			rotation: (frame.rotation || 0) + deltaDeg,
		};
	});
}

/** Normalize a rotation into the [-180, 180] range for tidy persistence. */
export function normalizeRotation(degrees: number): number {
	let value = degrees % 360;
	if (value > 180) value -= 360;
	if (value < -180) value += 360;
	return Math.abs(value) < 0.01 ? 0 : value;
}

// ─── Camera ─────────────────────────────────────────────────────────

/** Convert a surface-relative screen point into world space. */
export function pointToWorld(
	point: ScreenPoint,
	viewport: BoardViewport,
): WorldPoint {
	return worldPoint(
		(point.x - viewport.x) / viewport.zoom,
		(point.y - viewport.y) / viewport.zoom,
	);
}

export function worldToScreen(
	point: WorldPoint,
	viewport: BoardViewport,
): ScreenPoint {
	return screenPoint(
		point.x * viewport.zoom + viewport.x,
		point.y * viewport.zoom + viewport.y,
	);
}

export function screenToWorld(
	clientX: number,
	clientY: number,
	rect: DOMRect,
	viewport: BoardViewport,
): WorldPoint {
	return pointToWorld(
		screenPoint(clientX - rect.left, clientY - rect.top),
		viewport,
	);
}

/** Zoom while keeping a surface-relative screen point fixed under the cursor. */
export function zoomAround(
	viewport: BoardViewport,
	anchor: ScreenPoint,
	nextZoom: number,
): BoardViewport {
	const current = normalizeViewport(viewport);
	const zoom = Number.isFinite(nextZoom) ? clampZoom(nextZoom) : current.zoom;
	const world = pointToWorld(anchor, current);
	return {
		x: anchor.x - world.x * zoom,
		y: anchor.y - world.y * zoom,
		zoom,
	};
}

export function panBy(
	viewport: BoardViewport,
	dx: number,
	dy: number,
): BoardViewport {
	return { ...viewport, x: viewport.x + dx, y: viewport.y + dy };
}

export function cameraForState(
	state: BoardCameraState,
	surface: Size,
): BoardViewport {
	const zoom = clampZoom(state.zoom);
	return normalizeViewport({
		x: surface.width / 2 - state.centerX * zoom,
		y: surface.height / 2 - state.centerY * zoom,
		zoom,
	});
}

export function cameraForRect(
	content: Rect,
	surface: Size,
	options: Pick<BoardCameraFocusParams, "fit" | "padding" | "minZoom" | "maxZoom"> = {
		fit: "contain",
		padding: 32,
	},
): BoardViewport {
	const padding = Math.max(0, Number.isFinite(options.padding) ? options.padding : 32);
	const availableW = Math.max(1, surface.width - padding * 2);
	const availableH = Math.max(1, surface.height - padding * 2);
	const fitZoom = options.fit === "cover"
		? Math.max(availableW / content.width, availableH / content.height)
		: Math.min(availableW / content.width, availableH / content.height);
	const minZoom = clampZoom(options.minZoom ?? MIN_BOARD_ZOOM);
	const maxZoom = clampZoom(options.maxZoom ?? MAX_BOARD_ZOOM);
	const zoom = Math.min(Math.max(fitZoom, Math.min(minZoom, maxZoom)), Math.max(minZoom, maxZoom));
	const center = rectCenter(content);
	return cameraForState({ centerX: center.x, centerY: center.y, zoom }, surface);
}

export function rectForCameraFocus(
	focus: BoardCameraFocus,
	getFrame: (id: string) => BoardFrame | null | undefined,
): Rect | null {
	if (focus.type === "rect") return focus.rect;
	if (focus.type === "item") {
		const frame = getFrame(focus.itemId);
		return frame ? itemBounds(frame) : null;
	}
	if (focus.type === "frame") {
		const frame = getFrame(focus.frameId);
		return frame ? itemBounds(frame) : null;
	}
	const frames = focus.itemIds.flatMap((id) => {
		const frame = getFrame(id);
		return frame ? [frame] : [];
	});
	return frames.length === focus.itemIds.length ? selectionBounds(frames) : null;
}

export function cameraForFocus(
	params: BoardCameraFocusParams,
	getFrame: (id: string) => BoardFrame | null | undefined,
	surface: Size,
): BoardViewport | null {
	const rect = rectForCameraFocus(params.focus, getFrame);
	return rect ? cameraForRect(rect, surface, params) : null;
}

/** Compute a viewport that frames the given world rect within the surface. */
export function fitToContent(
	content: Rect,
	surface: Size,
	padding = FIT_PADDING,
): BoardViewport {
	const availableW = Math.max(1, surface.width - padding * 2);
	const availableH = Math.max(1, surface.height - padding * 2);
	const zoom = clampZoom(
		Math.min(availableW / content.width, availableH / content.height),
	);
	return {
		x: surface.width / 2 - (content.x + content.width / 2) * zoom,
		y: surface.height / 2 - (content.y + content.height / 2) * zoom,
		zoom,
	};
}

/** World-space rectangle currently visible in the board stage. */
export function visibleWorldRect(
	viewport: BoardViewport,
	surfaceWidth: number,
	surfaceHeight: number,
): Rect {
	const width = Math.max(0, surfaceWidth);
	const height = Math.max(0, surfaceHeight);
	const zoom = viewport.zoom || 1;
	return {
		x: -viewport.x / zoom,
		y: -viewport.y / zoom,
		width: width / zoom,
		height: height / zoom,
	};
}
