import {
	type BoardToolStyleMap,
	type BoardToolStylePatch,
	createBoardToolStyles,
} from "@neta-art/cohub/board";

const STORAGE_KEY = "cohub:board:tool-styles:v3";

export function readBoardToolStyles(): BoardToolStyleMap {
	if (typeof localStorage === "undefined") return createBoardToolStyles();
	try {
		const raw = localStorage.getItem(STORAGE_KEY);
		return createBoardToolStyles(
			raw ? (JSON.parse(raw) as BoardToolStylePatch) : undefined,
		);
	} catch {
		return createBoardToolStyles();
	}
}

export function writeBoardToolStyles(styles: BoardToolStyleMap) {
	if (typeof localStorage === "undefined") return;
	try {
		localStorage.setItem(STORAGE_KEY, JSON.stringify(styles));
	} catch {
	}
}
