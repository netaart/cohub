import {
	type BoardAssetSource,
	type BoardSceneItem,
	isBoardModelItem,
	playableBoardMedia,
} from "@neta-art/cohub/board";

export {
	type BoardPlayableMedia,
	playableBoardMedia,
	playableBoardMediaList,
	resetBoardPlaybackUrlCache,
} from "@neta-art/cohub/board";

export function opensInPlace(
	item: BoardSceneItem | null | undefined,
	assetSource: BoardAssetSource,
): boolean {
	return (
		isBoardModelItem(item) ||
		playableBoardMedia(item ?? null, assetSource) !== null
	);
}
