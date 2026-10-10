import {
	type BoardFrame,
	type BoardSceneItem as BoardItem,
	type BoardItemResizeMode,
	type BoardRegistry,
	CORNER_RESIZE_HANDLES,
	frameCornerRotationHandleAt,
	frameEdgeHandleAt,
	frameHandlePosition,
	HANDLE_HIT_RADIUS,
	type Rect,
	type ResizeHandle,
	rotationHandlePosition,
	type WorldPoint,
} from "../model/index.js";

export type BoardTransformControl =
	| { kind: "resize"; handle: ResizeHandle }
	| { kind: "rotate" };

const HANDLE_ANGLE: Record<ResizeHandle, number> = {
	e: 0,
	w: 0,
	se: 45,
	nw: 45,
	n: 90,
	s: 90,
	ne: 135,
	sw: 135,
};
const RESIZE_CURSORS = [
	"ew-resize",
	"nwse-resize",
	"ns-resize",
	"nesw-resize",
] as const;

export function resizeCursorForHandle(
	handle: ResizeHandle,
	rotation: number,
): (typeof RESIZE_CURSORS)[number] {
	const angle = HANDLE_ANGLE[handle] + rotation;
	const bucket = ((Math.round(angle / 45) % 4) + 4) % 4;
	return RESIZE_CURSORS[bucket] ?? "ew-resize";
}

export type BoardSelectionTransform = {
	frame: BoardFrame;
	resizeMode: BoardItemResizeMode;
	canRotate: boolean;
};

export function resolveSelectionTransform(
	registry: BoardRegistry,
	items: BoardItem[],
	bounds: Rect | null,
): BoardSelectionTransform | null {
	if (!bounds || items.length === 0) return null;
	const frame =
		items.length === 1
			? items[0]?.frame
			: ({ ...bounds, rotation: 0 } satisfies BoardFrame);
	if (!frame) return null;

	let canResize = true;
	let canRotate = true;
	let singleResizeMode: BoardItemResizeMode = "none";
	for (let index = 0; index < items.length; index += 1) {
		const item = items[index];
		if (!item) continue;
		const capabilities = registry.capabilities(item);
		const resizeMode = registry.resizeMode(item);
		if (index === 0) singleResizeMode = resizeMode;
		if (item.locked || resizeMode === "none") canResize = false;
		if (item.locked || !capabilities.canRotate) canRotate = false;
	}

	return {
		frame,
		resizeMode: canResize
			? items.length === 1
				? singleResizeMode
				: "uniform"
			: "none",
		canRotate,
	};
}

function controlHitRadius(pointerType: string): number {
	if (pointerType === "touch") return 20;
	if (pointerType === "pen") return 12;
	return HANDLE_HIT_RADIUS;
}

export function selectionTransformControlAt(
	transform: BoardSelectionTransform | null,
	point: WorldPoint,
	zoom: number,
	pointerType: string,
): BoardTransformControl | null {
	if (!transform) return null;
	const screenRadius = controlHitRadius(pointerType);
	const radius = screenRadius / Math.max(zoom, 0.0001);

	if (transform.resizeMode !== "none") {
		for (const handle of CORNER_RESIZE_HANDLES) {
			const position = frameHandlePosition(transform.frame, handle);
			if (Math.hypot(position.x - point.x, position.y - point.y) <= radius)
				return { kind: "resize", handle };
		}
	}

	if (transform.canRotate) {
		const usesSeparateHandle =
			pointerType === "touch" || transform.resizeMode === "none";
		if (usesSeparateHandle) {
			const position = rotationHandlePosition(transform.frame, zoom);
			if (Math.hypot(position.x - point.x, position.y - point.y) <= radius)
				return { kind: "rotate" };
		} else if (
			frameCornerRotationHandleAt(transform.frame, point, zoom, screenRadius)
		) {
			return { kind: "rotate" };
		}
	}

	if (transform.resizeMode === "free") {
		const handle = frameEdgeHandleAt(
			transform.frame,
			point,
			zoom,
			screenRadius,
		);
		if (handle) return { kind: "resize", handle };
	}

	return null;
}
