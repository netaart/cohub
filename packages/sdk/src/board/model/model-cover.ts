import type { BoardItem } from "@cohub/protocol/board-model";
import { isBoardModelObject } from "./depth.js";
import { boardModelViewKey, isBoardModelItem } from "./media.js";

export const BOARD_MODEL_COVER_VERSION = 1;

export type BoardModelCoverDisplay = "card" | "object";

export function boardModelCoverDisplay(item: BoardItem): BoardModelCoverDisplay {
	return isBoardModelObject(item) ? "object" : "card";
}

export function boardModelCoverVariant(item: BoardItem): string | null {
	if (item.type !== "file" || !isBoardModelItem(item)) return null;
	const parts = [item.props.src, boardModelCoverDisplay(item), boardModelViewKey(item.props.model?.view), item.props.model?.animation ?? "", BOARD_MODEL_COVER_VERSION];
	return fnv1a(JSON.stringify(parts));
}

export function boardModelCover(item: BoardItem): string | null {
	if (item.type !== "file") return null;
	const url = item.props.snapshot?.coverUrl;
	const variant = boardModelCoverVariant(item);
	return url && variant && url.endsWith(`-${variant}.webp`) ? url : null;
}

function fnv1a(text: string): string {
	let hash = 0x811c9dc5;
	for (let i = 0; i < text.length; i++) {
		hash ^= text.charCodeAt(i);
		hash = Math.imul(hash, 0x01000193);
	}
	return (hash >>> 0).toString(16).padStart(8, "0");
}
