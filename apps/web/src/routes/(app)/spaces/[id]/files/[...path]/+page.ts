import { redirect } from "@sveltejs/kit";
import { buildFileIngressMainRoute } from "#lib/features/space/modules/window-route.ts";
import type { PageLoad } from "./$types";

/** Legacy deep-link ingress: always land on new chat + file preview. */
export const load: PageLoad = async ({ params }) => {
	throw redirect(302, buildFileIngressMainRoute(params.id, params.path));
};
