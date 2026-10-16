import type { ModelFormat } from "@cohub/protocol/fs";
import {
	type BoardAssetSource,
	type BoardSceneItem,
	boardModelTarget,
	parseBoardMediaSource,
} from "@neta-art/cohub/board";
import type { BoardModelPreviews } from "@neta-art/cohub/board/stage";
import {
	createModelSource,
	fetchModelBytes,
	type ModelSource,
	remoteReferences,
	workspaceReferences,
} from "$lib/model3d/source";

function cardModelSource(
	card: {
		key: string;
		name: string;
		src: string;
		format: ModelFormat;
		size?: number;
	},
	assetSource: BoardAssetSource,
): ModelSource | null {
	const source = parseBoardMediaSource(card.src);
	if (!source) return null;
	const resolveUrl =
		source.kind === "url"
			? async () => source.value
			: () => assetSource.resolveFileUrl(source.value);
	return createModelSource({
		key: card.key,
		name: card.name,
		format: card.format,
		size: card.size ?? null,
		async read(options) {
			const url = await resolveUrl();
			if (!url) throw new Error("Model is unavailable");
			return fetchModelBytes(url, { ...options, expectedSize: card.size });
		},
		references: () =>
			source.kind === "url"
				? remoteReferences(source.value)
				: workspaceReferences(source.value, (path) =>
						assetSource.resolveFileUrl(path),
					),
	});
}

export function boardModelSource(
	item: BoardSceneItem | null | undefined,
	assetSource: BoardAssetSource,
): ModelSource | null {
	const target = boardModelTarget(item);
	if (!target) return null;
	return cardModelSource(
		{
			key: target.key,
			name: target.title,
			src: target.src,
			format: target.format,
			size: target.size,
		},
		assetSource,
	);
}

export function createBoardModelPreviews(
	assetSource: () => BoardAssetSource,
	{ isMobile }: { isMobile: boolean },
): BoardModelPreviews {
	const maxBytes = (isMobile ? 16 : 64) * 1024 ** 2;
	return {
		maxBytes,
		async load({ key, src, format, size }) {
			const source = cardModelSource(
				{ key, name: src, src, format, size },
				assetSource(),
			);
			if (!source) throw new Error("Model source is invalid");
			const { renderModelStill } = await import("$lib/model3d/poster");
			return renderModelStill(source, { maxBytes });
		},
	};
}
