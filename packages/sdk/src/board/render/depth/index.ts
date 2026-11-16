export type { BoardDepthLayer, BoardDepthStage } from "./engine.js";
export type { BoardDepthObject } from "./objects.js";
export * from "./bend.js";
export * from "./capture.js";
export * from "./shadows.js";
export * from "./shared.js";

export type BoardDepthEngine = typeof import("./engine.js");

let engine: Promise<BoardDepthEngine> | null = null;

export function loadBoardDepthEngine(): Promise<BoardDepthEngine> {
	engine ??= import("./engine.js").catch((error) => {
		engine = null;
		throw error;
	});
	return engine;
}
