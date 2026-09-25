import type { AppWindowState } from "@cohub/protocol/app-runtime";
import { isBoardFile } from "$lib/board/board-file";
import { parseAppWindowKey } from "./app-window-key";
import type { WindowSyncStatus } from "./window-sync-status";

export type Window = {
	kind: "file" | "board" | "port" | "app";
	key: string;
	label: string;
	title: string;
	syncStatus?: WindowSyncStatus;
	active: boolean;
};

export function activeWindowFilePath(
	kind: Window["kind"] | null,
	filePath: string | null,
	boardPath: string | null,
	appKey: string | null = null,
): string {
	if (kind === "file") return filePath ?? "";
	if (kind === "board") return boardPath ?? "";
	if (kind === "app" && appKey) return parseAppWindowKey(appKey)?.path ?? "";
	return "";
}

export function workspaceFilePreviewKind(
	path: string,
	readOnly: boolean,
): "file" | "board" {
	return isBoardFile(path) && !readOnly ? "board" : "file";
}

/** What an App tab shows for the state its App reported. */
export function appWindowSyncStatus(state: AppWindowState): WindowSyncStatus {
	if (state.status === "error") return "error";
	if (state.status === "saving") return "saving";
	return state.dirty ? "dirty" : "idle";
}
