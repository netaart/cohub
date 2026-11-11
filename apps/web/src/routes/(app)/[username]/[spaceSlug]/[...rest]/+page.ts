import { HttpError } from "@neta-art/cohub";
import { error, redirect } from "@sveltejs/kit";
import { sdk } from "$lib/sdk";
import type { PageLoad } from "./$types";

/**
 * Shell for friendly Space paths. The browser reroutes resolvable addresses to
 * `/spaces/:id/...`, so this load only runs when that resolution failed.
 */
export const load: PageLoad = async ({ params, url }) => {
	const space = await sdk.spaces
		.getBySlug(params.username, params.spaceSlug)
		.catch((err) => {
			if (err instanceof HttpError) error(err.status, err.message);
			throw err;
		});
	const rest = params.rest ? `/${params.rest}` : "";
	redirect(307, `/spaces/${space.id}${rest}${url.search}${url.hash}`);
};
