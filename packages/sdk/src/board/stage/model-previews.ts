import { type BoardAssetSource, boardModelViewKey, fileStem, parseBoardMediaSource } from "../model/index.js";
import { boardModelSource, loadModelEngine } from "../render/model3d/index.js";
import type { BoardModelPreviews } from "./assets.js";
import { defaultBoardDeviceBudget } from "./device.js";

export type BoardModelPreviewCache = {
	read(key: string): Promise<ImageBitmap | null>;
	write(key: string, image: ImageBitmap): void | Promise<void>;
};

export function createBoardModelPreviews(
	assets: Pick<BoardAssetSource, "resolveFile">,
	{ maxBytes = defaultBoardDeviceBudget().modelBytes / 2, cache }: { maxBytes?: number; cache?: BoardModelPreviewCache } = {},
): BoardModelPreviews {
	return {
		maxBytes,
		async load(request) {
			const source = boardModelSource({ ...request, name: fileStem(request.src) }, assets);
			if (!source) throw new Error("Model source is invalid");
			const file = cache ? parseBoardMediaSource(request.src) : null;
			const url = file?.kind === "file" ? (await assets.resolveFile(file.value))?.url : null;
			let key: string | undefined;
			if (url && cache) {
				const view = boardModelViewKey(request.view);
				const look = [view && `view=${view}`, request.animation && `clip=${encodeURIComponent(request.animation)}`].filter(Boolean).join("&");
				key = `${url}#${encodeURIComponent(request.key)}${look ? `&${look}` : ""}`;
				try {
					const cached = await cache.read(key);
					if (cached) return { image: cached, sha256: null };
				} catch {}
			}
			const { renderModelStill } = await loadModelEngine();
			const still = await renderModelStill(source, {
				signal: AbortSignal.timeout(60_000),
				maxBytes,
				view: request.view,
				clip: request.animation,
			});
			if (key && cache) {
				try {
					await cache.write(key, still.image);
				} catch {}
			}
			return still;
		},
	};
}
