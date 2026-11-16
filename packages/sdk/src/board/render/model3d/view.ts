import type { BoardModelView } from "@cohub/protocol/board-model";

export type ModelView = BoardModelView;

const HOME_DIRECTION = [0.55, 0.38, 1] as const;

export const MODEL_VIEW_PRESETS = {
	home: {
		yaw: (Math.atan2(HOME_DIRECTION[0], HOME_DIRECTION[2]) * 180) / Math.PI,
		pitch: (Math.asin(HOME_DIRECTION[1] / Math.hypot(...HOME_DIRECTION)) * 180) / Math.PI,
		zoom: 1,
	},
	front: { yaw: 0, pitch: 0, zoom: 1 },
	side: { yaw: 90, pitch: 0, zoom: 1 },
	top: { yaw: 0, pitch: 90, zoom: 1 },
} as const satisfies Record<string, ModelView>;

export type ModelViewPreset = keyof typeof MODEL_VIEW_PRESETS;

export const MODEL_SHADINGS = ["standard", "clay", "color", "normals"] as const;
export type ModelShading = (typeof MODEL_SHADINGS)[number];

export type ModelStats = {
	triangles: number;
	vertices: number;
	materials: number;
	textures: number;
	clips: number;
	size: [number, number, number];
	unit: "m" | null;
};
