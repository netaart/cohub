
import {
	type BoardAnchorSide as BoardConnectionSide,
	type BoardFrame,
	degToRad,
	frameRect,
	rectCenter,
	rotatePointAround,
	type WorldPoint,
	worldPoint,
} from "@neta-art/cohub/board";

export const CONNECTION_SIDES: readonly BoardConnectionSide[] = [
	"top",
	"right",
	"bottom",
	"left",
] as const;

export const CONNECTION_PORT_OFFSET = 14;
export const CONNECTION_PORT_RADIUS = 4;
export const CONNECTION_PORT_HIT_RADIUS = 11;
export const CONNECTION_PORT_TOUCH_HIT_RADIUS = 22;

export type ConnectionPort = {
	side: BoardConnectionSide;
	point: WorldPoint;
};

export function portHitRadius(pointerType: string): number {
	return pointerType === "touch" || pointerType === "pen"
		? CONNECTION_PORT_TOUCH_HIT_RADIUS
		: CONNECTION_PORT_HIT_RADIUS;
}

const SIDE_NORMAL: Record<BoardConnectionSide, { x: number; y: number }> = {
	top: { x: 0, y: -1 },
	right: { x: 1, y: 0 },
	bottom: { x: 0, y: 1 },
	left: { x: -1, y: 0 },
};

const SIDE_ANCHOR: Record<BoardConnectionSide, { nx: number; ny: number }> = {
	top: { nx: 0.5, ny: 0 },
	right: { nx: 1, ny: 0.5 },
	bottom: { nx: 0.5, ny: 1 },
	left: { nx: 0, ny: 0.5 },
};

export function connectionPorts(
	frame: BoardFrame,
	zoom: number,
): ConnectionPort[] {
	const offset = CONNECTION_PORT_OFFSET / Math.max(zoom, 0.0001);
	const center = rectCenter(frameRect(frame));
	const rotation = frame.rotation ? degToRad(frame.rotation) : 0;
	return CONNECTION_SIDES.map((side) => {
		const anchor = SIDE_ANCHOR[side];
		const base = worldPoint(
			frame.x + anchor.nx * frame.width,
			frame.y + anchor.ny * frame.height,
		);
		const rotated = rotation ? rotatePointAround(base, center, rotation) : base;
		const normal = SIDE_NORMAL[side];
		const direction = rotation
			? {
					x: normal.x * Math.cos(rotation) - normal.y * Math.sin(rotation),
					y: normal.x * Math.sin(rotation) + normal.y * Math.cos(rotation),
				}
			: normal;
		return {
			side,
			point: worldPoint(
				rotated.x + direction.x * offset,
				rotated.y + direction.y * offset,
			),
		};
	});
}

export function connectionPortAt(
	frame: BoardFrame,
	point: WorldPoint,
	zoom: number,
	pointerType: string,
): ConnectionPort | null {
	const radius = portHitRadius(pointerType) / Math.max(zoom, 0.0001);
	let closest: ConnectionPort | null = null;
	let closestDistance = Number.POSITIVE_INFINITY;
	for (const port of connectionPorts(frame, zoom)) {
		const distance = Math.hypot(port.point.x - point.x, port.point.y - point.y);
		if (distance <= radius && distance < closestDistance) {
			closest = port;
			closestDistance = distance;
		}
	}
	return closest;
}
