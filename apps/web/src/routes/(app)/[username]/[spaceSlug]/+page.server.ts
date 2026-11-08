import { redirect } from "@sveltejs/kit";
import {
	loadPublicSpaceRedirect,
	publicSlugRedirectLocation,
} from "$lib/server/public-api";
import type { PageServerLoad } from "./$types";

/**
 * Retired usernames / Space slugs redirect to the current address; the client load owns the data.
 * With `ssr = false` this runs on the `__data.json` request, so the redirect is client-side.
 */
export const load: PageServerLoad = async ({ params, fetch, url, untrack }) => {
	const redirectTo = await loadPublicSpaceRedirect(
		params.username,
		params.spaceSlug,
		fetch,
	);
	// Only the path decides the redirect; query changes must not rerun this load.
	const location = untrack(() => publicSlugRedirectLocation(redirectTo, url));
	if (location) redirect(308, location);
};
