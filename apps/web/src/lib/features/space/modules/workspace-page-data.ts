import { readWindowFromSearch, type WindowKind } from "./window-route";

export type WorkspacePageView =
	| "space"
	| "session"
	| "checkpoint"
	| "checkpoint-new"
	| "cronjob"
	| "cronjob-new"
	| "task";

type PreviewFields = {
	windowKind: WindowKind | null;
	windowKey: string | null;
};

export function withWorkspacePreview(
	searchParams: URLSearchParams,
): PreviewFields {
	const ref = readWindowFromSearch(searchParams);
	return {
		windowKind: ref?.kind ?? null,
		windowKey: ref?.key ?? null,
	};
}
