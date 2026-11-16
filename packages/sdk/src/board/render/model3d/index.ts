export * from "./source.js";
export * from "./view.js";
export type { LoadedModel, ModelScene, ModelSceneOptions, ModelViewer, ModelViewerOptions } from "./engine.js";

export type ModelEngine = typeof import("./engine.js");

let engine: Promise<ModelEngine> | null = null;

export function loadModelEngine(): Promise<ModelEngine> {
	engine ??= import("./engine.js").catch((error) => {
		engine = null;
		throw error;
	});
	return engine;
}
