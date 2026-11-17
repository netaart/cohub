import { redirectResourcePage } from "#lib/features/space/modules/resource-app-ingress.ts";
import { readWindowFromSearch } from "#lib/features/space/modules/window-route.ts";
import type { PageLoad } from "./$types";

export const load: PageLoad = async ({ params, url }) => {
	redirectResourcePage(url);
	const preview = readWindowFromSearch(url.searchParams);
	return {
		spaceId: params.id,
		view: "cronjob-new" as const,
		sessionId: null,
		filePath: null,
		checkpointId: null,
		cronjobId: null,
		taskId: null,
		windowKind: preview?.kind ?? null,
		windowKey: preview?.key ?? null,
	};
};
