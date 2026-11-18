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
import type {
	BoardModelCoverUpload,
	BoardModelPreviews,
} from "@neta-art/cohub/board/stage";
import "#lib/model3d/decoders.ts";
import { sdk } from "#lib/sdk.ts";

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
			// Covers are recorded only in Spaces, which never read this cache.
			const url =
				published && file?.kind === "file"
					? (await assets.resolveFile(file.value))?.url
					: null;
			const view = boardModelViewKey(request.view);
			const look = [
				view && `view=${view}`,
				request.animation && `clip=${encodeURIComponent(request.animation)}`,
			]
				.filter(Boolean)
				.join("&");
			const stillKey = url && (look ? `${url}#${look}` : url);
			const { readModelStill, saveModelStill } = await import(
				"#lib/model3d/still-cache.ts"
			);
			const cached = stillKey && (await readModelStill(stillKey));
			if (cached) return { image: cached, sha256: null };
			const { renderModelStill } = await loadModelEngine();
			const still = await renderModelStill(source, {
				signal: AbortSignal.timeout(STILL_TIMEOUT_MS),
				maxBytes,
				view: request.view,
				clip: request.animation,
			});
			if (stillKey) saveModelStill(stillKey, still.image);
			return still;
		},
	};
}

export const uploadBoardModelCover: BoardModelCoverUpload = async ({
	key,
	image,
	signal,
}) =>
	(await sdk.publicAssets.uploadBoardPreview({ key, file: image, signal }))
		.publicUrl;
