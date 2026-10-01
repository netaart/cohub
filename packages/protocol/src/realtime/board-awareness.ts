import { z } from "zod";
import { BOARD_ARROW_STROKE_SIZE } from "../board-constants.js";

const idSchema = z.string().min(1).max(160);
const finiteSchema = z.number().finite();
export const BOARD_AWARENESS_WORLD_COORDINATE_LIMIT = 1_000_000_000;
export const BOARD_AWARENESS_WORLD_EXTENT_LIMIT = 100_000_000;
export const BOARD_AWARENESS_MIN_VIEWPORT_ZOOM = 0.05;
export const BOARD_AWARENESS_MAX_VIEWPORT_ZOOM = 8;

const worldCoordinateSchema = finiteSchema
	.min(-BOARD_AWARENESS_WORLD_COORDINATE_LIMIT)
	.max(BOARD_AWARENESS_WORLD_COORDINATE_LIMIT);
const worldExtentSchema = finiteSchema
	.positive()
	.max(BOARD_AWARENESS_WORLD_EXTENT_LIMIT);
const viewportZoomSchema = finiteSchema
	.min(BOARD_AWARENESS_MIN_VIEWPORT_ZOOM)
	.max(BOARD_AWARENESS_MAX_VIEWPORT_ZOOM);

export const BoardAwarenessPointSchema = z.object({
	x: worldCoordinateSchema,
	y: worldCoordinateSchema,
});

export const BoardAwarenessDrawPointSchema = BoardAwarenessPointSchema.extend({
	p: finiteSchema.min(0).max(1),
});

export const BoardAwarenessFrameSchema = z.object({
	x: worldCoordinateSchema,
	y: worldCoordinateSchema,
	width: worldExtentSchema,
	height: worldExtentSchema,
	rotation: finiteSchema,
});

export const BoardAwarenessViewportSchema = z.object({
	x: worldCoordinateSchema,
	y: worldCoordinateSchema,
	width: worldExtentSchema,
	height: worldExtentSchema,
	zoom: viewportZoomSchema,
});

export const BoardAwarenessItemPreviewSchema = z.object({
	itemId: idSchema,
	frame: BoardAwarenessFrameSchema,
});

export const BoardAwarenessStateUpdateSchema = z.object({
	type: z.literal("state"),
	client: z
		.object({
			formFactor: z.enum(["desktop", "mobile"]),
		})
		.optional(),
	cursor: BoardAwarenessPointSchema.extend({
		pointerType: z.enum(["mouse", "pen", "touch"]),
	})
		.nullable(),
	viewport: BoardAwarenessViewportSchema.nullable().optional(),
	tool: z.string().min(1).max(40),
	selection: z.object({
		ids: z.array(idSchema).max(64),
		count: z.number().int().nonnegative().max(50_000),
		bounds: BoardAwarenessFrameSchema.nullable(),
	}),
	editingId: idSchema.nullable(),
});

export const BoardAwarenessGestureSchema = z.discriminatedUnion("kind", [
	z.object({
		kind: z.literal("draw"),
		id: idSchema,
		itemId: idSchema,
		color: z.string().min(1).max(64),
		size: finiteSchema.positive().max(256),
		from: z.number().int().nonnegative().max(100_000),
		points: z.array(BoardAwarenessDrawPointSchema).min(1).max(64),
	}),
	z.object({
		kind: z.literal("arrow"),
		id: idSchema,
		itemId: idSchema,
		start: BoardAwarenessPointSchema,
		current: BoardAwarenessPointSchema,
		startItemId: idSchema.nullable().default(null),
		endItemId: idSchema.nullable().default(null),
		color: z.string().min(1).max(64),
		size: finiteSchema
			.positive()
			.max(256)
			.default(BOARD_ARROW_STROKE_SIZE),
	}),
	z.object({
		kind: z.literal("box"),
		id: idSchema,
		itemId: idSchema,
		shape: z.enum(["shape", "frame"]),
		start: BoardAwarenessPointSchema,
		current: BoardAwarenessPointSchema,
		color: z.string().min(1).max(64),
		geometry: z.string().min(1).max(40).default("rectangle"),
	}),
	z.object({
		kind: z.literal("transform"),
		id: idSchema,
		mode: z.enum(["translate", "resize", "rotate", "arrow"]),
		items: z.array(BoardAwarenessItemPreviewSchema).max(64),
		bounds: BoardAwarenessFrameSchema.nullable(),
	}),
]);

export const BoardAwarenessUpdateSchema = z.discriminatedUnion("type", [
	BoardAwarenessStateUpdateSchema,
	z.object({
		type: z.literal("gesture"),
		gesture: BoardAwarenessGestureSchema,
	}),
	z.object({
		type: z.literal("gesture.end"),
		gestureId: idSchema,
		resultingItemIds: z.array(idSchema).max(64),
	}),
	z.object({
		type: z.literal("gesture.cancel"),
		gestureId: idSchema,
	}),
]);

export const BoardAwarenessClientPayloadSchema = z.object({
	spaceId: z.string().uuid(),
	boardId: z.string().uuid(),
	seq: z.number().int().nonnegative(),
	update: BoardAwarenessUpdateSchema,
});

export type BoardAwarenessPoint = z.infer<typeof BoardAwarenessPointSchema>;
export type BoardAwarenessDrawPoint = z.infer<
	typeof BoardAwarenessDrawPointSchema
>;
export type BoardAwarenessFrame = z.infer<typeof BoardAwarenessFrameSchema>;
export type BoardAwarenessViewport = z.infer<
	typeof BoardAwarenessViewportSchema
>;
export type BoardAwarenessItemPreview = z.infer<
	typeof BoardAwarenessItemPreviewSchema
>;
export type BoardAwarenessStateUpdate = z.infer<
	typeof BoardAwarenessStateUpdateSchema
>;
export type BoardAwarenessGesture = z.infer<
	typeof BoardAwarenessGestureSchema
>;
export type BoardAwarenessUpdate = z.infer<typeof BoardAwarenessUpdateSchema>;
export type BoardAwarenessClientPayload = z.infer<
	typeof BoardAwarenessClientPayloadSchema
>;
