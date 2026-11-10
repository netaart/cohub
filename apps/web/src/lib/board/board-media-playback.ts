import {
	BOARD_CAMERA_TARGET,
	type BoardAssetSource,
	type BoardDocument,
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

export function boardAnimationReach(
	document: BoardDocument,
	animationId: string | null,
): { sound: boolean; camera: boolean } {
	const reach = { sound: false, camera: false };
	const seen = new Set<string>();
	const visit = (id: string) => {
		if (seen.has(id)) return;
		seen.add(id);
		for (const track of Object.values(document.animations[id]?.tracks ?? {})) {
			const type = document.items[track.target]?.type;
			if (track.target === BOARD_CAMERA_TARGET) reach.camera = true;
			else if (document.animations[track.target]) visit(track.target);
			else if (
				track.property === "props.time" &&
				(type === "audio" || type === "video")
			)
				reach.sound = true;
		}
	};
	if (animationId) visit(animationId);
	return reach;
}
