import { HttpError } from "@neta-art/cohub";
import { error, redirect } from "@sveltejs/kit";
import { readWindowFromSearch } from "$lib/features/space/modules/window-route";
import { publicSlugRedirectLocation } from "$lib/public-slug-redirect";
import { sdk } from "$lib/sdk";
import { cacheSpaceRecordSoon } from "$lib/stores/space-record-cache";
import type { PageLoad } from "./$types";

export const load: PageLoad = async ({ params, url, untrack }) => {
	const space = await sdk.spaces
		.getBySlug(params.username, params.spaceSlug)
		.catch((err) => {
			// SvelteKit only honors status codes on its own errors; rethrow SDK
			// HttpErrors so a missing space lands on the 404 boundary, not a 500.
			if (err instanceof HttpError) throw error(err.status, err.message);
			throw err;
		});
	// Only the path decides the redirect; untracked query keys must not rerun this load.
	const location = untrack(() =>
		publicSlugRedirectLocation(space.redirectTo, url),
	);
	if (location) redirect(308, location);
	cacheSpaceRecordSoon(space);
	const sessionId = url.searchParams.get("session");
	// Prefer ?preview=; legacy ?file= maps to file preview.
	const preview =
		readWindowFromSearch(url.searchParams) ??
		(url.searchParams.get("file")
			? {
					kind: "file" as const,
					key: url.searchParams.get("file") as string,
				}
			: null);

	return {
		spaceId: space.id,
		view: "session" as const,
		sessionId: sessionId ?? "new",
		filePath: null,
		windowKind: preview?.kind ?? null,
		windowKey: preview?.key ?? null,
	};
};
