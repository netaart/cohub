import {
	type BoardAssetSource,
	boardModelViewKey,
	fileStem,
	parseBoardMediaSource,
} from "@neta-art/cohub/board";
import {
	boardModelSource,
	loadModelEngine,
} from "@neta-art/cohub/board/render";
import type { BoardModelPreviews } from "@neta-art/cohub/board/stage";
import "$lib/model3d/decoders";

const STILL_TIMEOUT_MS = 60_000;

export function createBoardModelPreviews(
	assetSource: () => BoardAssetSource,
	{ isMobile, published }: { isMobile: boolean; published: boolean },
): BoardModelPreviews {
	const maxBytes = (isMobile ? 16 : 64) * 1024 ** 2;
	return {
		maxBytes,
		async load(request) {
			const assets = assetSource();
			const source = boardModelSource(
				{ ...request, name: fileStem(request.src) },
				assets,
			);
			if (!source) throw new Error("Model source is invalid");
			const file = parseBoardMediaSource(request.src);
			// Published files keep their URL, so their stills outlive the session.
			const url =
				published && file?.kind === "file"
					? (await assets.resolveFile(file.value))?.url
					: null;
			const view = boardModelViewKey(request.view);
			const stillKey = url && (view ? `${url}#view=${view}` : url);
			const { readModelStill, saveModelStill } = await import(
				"$lib/model3d/still-cache"
			);
			const cached = stillKey && (await readModelStill(stillKey));
			if (cached) return cached;
			const { renderModelStill } = await loadModelEngine();
			const still = await renderModelStill(source, {
				signal: AbortSignal.timeout(STILL_TIMEOUT_MS),
				maxBytes,
				view: request.view,
			});
			if (stillKey) saveModelStill(stillKey, still);
			return still;
		},
	};
}
