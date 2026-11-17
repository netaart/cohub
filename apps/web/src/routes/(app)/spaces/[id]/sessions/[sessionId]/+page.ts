import { readWindowFromSearch } from "#lib/features/space/modules/window-route.ts";
import type { PageLoad } from "./$types";

export const load: PageLoad = async ({ params, url }) => {
	const preview = readWindowFromSearch(url.searchParams);
	return {
		spaceId: params.id,
		view: "session" as const,
		sessionId: params.sessionId,
		filePath: null,
		windowKind: preview?.kind ?? null,
		windowKey: preview?.key ?? null,
		turnSequence: url.searchParams.get("turn"),
	};
};
