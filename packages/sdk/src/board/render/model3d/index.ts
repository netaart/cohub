import type { BoardItem } from "@cohub/protocol/board-model";
import { isBoardModelObject } from "../../model/depth.js";
import type { BoardAssetSource } from "../../model/media-playback.js";
import { fileStem } from "../../model/file-snapshot.js";
import { boardModelFormat } from "../../model/media.js";
import type { LoadedModel } from "./load.js";
import { boardModelSource, type ModelLoadOptions } from "./source.js";

export * from "./source.js";
export * from "./view.js";
export type { LoadedModel, ModelPlayback, ModelScene, ModelSceneOptions, ModelViewer, ModelViewerOptions } from "./engine.js";

export type ModelEngine = typeof import("./engine.js");

let engine: Promise<ModelEngine> | null = null;

export function loadModelEngine(): Promise<ModelEngine> {
	engine ??= import("./engine.js").catch((error) => {
		engine = null;
		throw error;
	});
	return engine;
}

export function loadBoardItemModel(item: BoardItem, assets: BoardAssetSource, options: ModelLoadOptions): Promise<LoadedModel> | null {
	if (item.type !== "file") return null;
	const { src, snapshot } = item.props;
	const format = boardModelFormat(src, snapshot?.mimeType);
	const source = format && boardModelSource({ key: `${src}:${snapshot?.mtimeMs ?? ""}`, src, format, size: snapshot?.size, name: fileStem(src) }, assets);
	return source ? loadModelEngine().then((engine) => engine.loadModel(source, options)) : null;
}

export async function loadBoardObjectModels(items: Iterable<BoardItem & { id: string }>, assets: BoardAssetSource, options: ModelLoadOptions): Promise<Map<string, LoadedModel>> {
	const loaded = new Map<string, LoadedModel>();
	await Promise.all(
		[...items].filter(isBoardModelObject).map(async (item) => {
			const model = await loadBoardItemModel(item, assets, options)?.catch(() => null);
			if (model) loaded.set(item.id, model);
		}),
	);
	return loaded;
}
