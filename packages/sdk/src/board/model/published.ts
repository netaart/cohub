import { type AppBoardArtifactManifest, type BoardDocument, boardSnapshotPatch, parseBoardDocument } from "@cohub/protocol";
import type { BoardAssetSource } from "./media-playback.js";

export type PublishedBoard = {
	boardId: string;
	title: string;
	document: BoardDocument;
	assetSource: BoardAssetSource;
	externalUrls: string[];
};

export function parsePublishedBoard(manifest: unknown, manifestUrl: string): PublishedBoard {
	const value = manifest as Partial<AppBoardArtifactManifest> | null;
	if (value?.kind !== "cohub.work.board" || !value.snapshot || !Array.isArray(value.assets))
		throw new Error("Not a published Board artifact.");
	const parsed = parseBoardDocument(boardSnapshotPatch(value.snapshot), { keepUnknown: true });
	if (!parsed.ok) throw new Error("Published Board document is invalid.");
	const base = new URL(".", manifestUrl);
	const urls = new Map<string, string>();
	for (const asset of value.assets)
		if (asset.status === "captured" && asset.artifactPath)
			urls.set(asset.sourcePath, new URL(asset.artifactPath, base).href);
	return {
		boardId: value.snapshot.id,
		title: value.snapshot.title,
		document: parsed.document,
		assetSource: { resolveFile: async (path) => (urls.has(path) ? { url: urls.get(path) as string } : null) },
		externalUrls: value.externalUrls ?? [],
	};
}
