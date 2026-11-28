import { redirect } from "@sveltejs/kit";
import type { PageLoad } from "./$types";

export const load: PageLoad = ({ url }) => {
	throw redirect(302, `/spaces/inbox${url.search}`);
};
