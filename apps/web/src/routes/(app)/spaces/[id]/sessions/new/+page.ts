import { redirect } from "@sveltejs/kit";
import { buildSpaceLandingRoute } from "#lib/space-routes.ts";
import type { PageLoad } from "./$types";

export const load: PageLoad = ({ params, url }) => {
	throw redirect(307, `${buildSpaceLandingRoute(params.id)}${url.search}`);
};
