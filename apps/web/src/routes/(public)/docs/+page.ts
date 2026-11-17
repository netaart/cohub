import { error } from "@sveltejs/kit";
import { loadDocsPage } from "#lib/docs/index.ts";
import type { PageLoad } from "./$types";

export const prerender = true;

export const load: PageLoad = async () => {
	const doc = await loadDocsPage("", "en");
	if (!doc) error(404, "Docs page not found");
	return { doc };
};
