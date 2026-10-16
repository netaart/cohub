import {
	type BoardAssetSource,
	type BoardSceneItem,
	boardModelTarget,
	playableBoardMedia,
} from "@neta-art/cohub/board";

export {
	type BoardPlayableMedia,
	playableBoardMedia,
	playableBoardMediaList,
	resetBoardPlaybackUrlCache,
} from "@neta-art/cohub/board";
export {
	type BoardMediaAction,
	boardMediaActionAt,
	mediaPlayBadgeHit,
	mediaPlayBadgeVisible,
} from "@neta-art/cohub/board/render";

export function opensInPlace(
	item: BoardSceneItem | null | undefined,
	assetSource: BoardAssetSource,
): boolean {
	return (
		boardModelTarget(item) !== null ||
		playableBoardMedia(item ?? null, assetSource) !== null
	);
}
