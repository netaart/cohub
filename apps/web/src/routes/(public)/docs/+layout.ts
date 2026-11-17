import {
	getDocsSections,
	listDocsSources,
	loadDocsSearchIndex,
	parseDocsPath,
} from "#lib/docs/index.ts";
import type { LayoutLoad } from "./$types";

export const prerender = true;
export const trailingSlash = "never";

export const load: LayoutLoad = async ({ url }) => {
	const { locale, slug } = parseDocsPath(url.pathname);

	const missing = listDocsSources(locale)
		.filter((item) => !item.present)
		.map((item) => item.file);

	if (missing.length > 0 && import.meta.env.DEV) {
		console.warn(
			`[docs] missing ${locale} markdown sources:`,
			missing.join(", "),
		);
	}

	return {
		locale,
		currentSlug: slug,
		sections: getDocsSections(locale),
		searchEntries: await loadDocsSearchIndex(locale),
	};
};
