import { readWindowFromSearch } from "#lib/features/space/modules/window-route.ts";
import type { PageLoad } from "./$types";

export const load: PageLoad = ({ params, url }) => {
	const preview = readWindowFromSearch(url.searchParams);
	return {
		spaceId: params.id,
		view: "session" as const,
		sessionId: "new",
		filePath: null,
		windowKind: preview?.kind ?? null,
		windowKey: preview?.key ?? null,
		turnSequence: null,
	};
};
