import { COHUB_PATH_MIME } from "./cohub-resource-drag.ts";

export type ChatDraftDropKind = "files" | "path";

/** Prefer external files over internal path payloads when both are present. */
export function classifyChatDraftDrop(
	dataTransfer: DataTransfer | null,
): ChatDraftDropKind | null {
	if (!dataTransfer) return null;
	if (hasExternalFileDrag(dataTransfer)) return "files";
	if (dataTransfer.types.includes(COHUB_PATH_MIME)) return "path";
	return null;
}

export function hasExternalFileDrag(dataTransfer: DataTransfer | null) {
	if (!dataTransfer) return false;
	return Array.from(dataTransfer.items ?? []).some(
		(item) => item.kind === "file",
	);
}

export function readCohubPathFromDataTransfer(
	dataTransfer: DataTransfer | null,
) {
	const path = dataTransfer?.getData(COHUB_PATH_MIME)?.trim();
	return path || null;
}
