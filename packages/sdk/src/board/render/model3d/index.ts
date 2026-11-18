import type { BoardItem } from "@cohub/protocol/board-model";
import { isBoardModelObject } from "../../model/depth.js";
import type { BoardAssetSource } from "../../model/media-playback.js";
import { fileStem } from "../../model/file-snapshot.js";
import { boardModelFormat } from "../../model/media.js";
import type { LoadedModel, ModelAsset } from "./load.js";
import { boardModelSource, type ModelLoadOptions } from "./source.js";

export * from "./source.js";
export * from "./view.js";
export type { LoadedModel, ModelAsset, ModelPlayback, ModelScene, ModelSceneOptions, ModelStill, ModelStillOptions, ModelViewer, ModelViewerOptions } from "./engine.js";
export type { ModelLighting } from "./lighting.js";

export type ModelEngine = typeof import("./engine.js");

let engine: Promise<ModelEngine> | null = null;

export function loadModelEngine(): Promise<ModelEngine> {
	engine ??= import("./engine.js").catch((error) => {
		engine = null;
		throw error;
	});
	return engine;
}

export function boardModelKey(item: BoardItem): string | null {
	return item.type === "file" ? `${item.props.src}:${item.props.snapshot?.mtimeMs ?? ""}` : null;
}

function boardItemModelSource(item: BoardItem, assets: BoardAssetSource) {
	if (item.type !== "file") return null;
	const { src, snapshot } = item.props;
	const format = boardModelFormat(src, snapshot?.mimeType);
	return format && boardModelSource({ key: boardModelKey(item) as string, src, format, size: snapshot?.size, name: fileStem(src) }, assets);
}

export function loadBoardItemModel(item: BoardItem, assets: BoardAssetSource, options: ModelLoadOptions): Promise<LoadedModel> | null {
	const source = boardItemModelSource(item, assets);
	return source ? loadModelEngine().then((engine) => engine.loadModel(source, options)) : null;
}

export function loadBoardItemModelAsset(item: BoardItem, assets: BoardAssetSource, options: ModelLoadOptions): Promise<ModelAsset> | null {
	const source = boardItemModelSource(item, assets);
	return source ? loadModelEngine().then((engine) => engine.loadModelAsset(source, options)) : null;
}

export async function loadBoardObjectModels(items: Iterable<BoardItem & { id: string }>, assets: BoardAssetSource, options: ModelLoadOptions): Promise<Map<string, LoadedModel>> {
	const groups = new Map<string, Array<BoardItem & { id: string }>>();
	for (const item of items) {
		const key = isBoardModelObject(item) && boardModelKey(item);
		if (key) groups.set(key, [...(groups.get(key) ?? []), item]);
	}
	const loaded = new Map<string, LoadedModel>();
	await Promise.all(
		[...groups.values()].map(async (group) => {
			const asset = await loadBoardItemModelAsset(group[0] as BoardItem, assets, options)?.catch(() => null);
			if (!asset) return;
			let left = group.length;
			for (const item of group) {
				const model = asset.create();
				let alive = true;
				loaded.set(item.id, {
					...model,
					destroy() {
						if (!alive) return;
						alive = false;
						model.destroy();
						if (--left === 0) asset.destroy();
					},
				});
			}
		}),
	);
	return loaded;
}
