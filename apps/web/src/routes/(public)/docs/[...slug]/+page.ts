import { error } from "@sveltejs/kit";
import { getDocsNavItems, loadDocsPage } from "#lib/docs/index.ts";
import type { EntryGenerator, PageLoad } from "./$types";

export const prerender = true;
export const trailingSlash = "never";

export const entries: EntryGenerator = () =>
	getDocsNavItems()
		.filter((item) => item.slug)
		.map((item) => ({ slug: item.slug }));

export const load: PageLoad = async ({ params }) => {
	const doc = await loadDocsPage(params.slug ?? "", "en");
	if (!doc) error(404, "Docs page not found");
	return { doc };
};
