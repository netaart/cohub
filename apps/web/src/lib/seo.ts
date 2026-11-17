/** Shared helpers for public marketing / content SEO. */

const DEFAULT_ORIGIN = "https://cohub.live";

export function siteOrigin(originFromPage?: string | null): string {
	const fromPage = (originFromPage ?? "").replace(/\/$/, "");
	if (
		fromPage.startsWith("http") &&
		!fromPage.includes("sveltekit-prerender")
	) {
		return fromPage;
	}

	return DEFAULT_ORIGIN;
}

export function canonicalUrl(
	originFromPage: string | null | undefined,
	path: string,
): string {
	const origin = siteOrigin(originFromPage);
	const normalized = path.startsWith("/") ? path : `/${path}`;
	return `${origin}${normalized === "/" ? "/" : normalized.replace(/\/$/, "")}`;
}

/** Default social preview image until docs have dedicated art. */
export function defaultOgImage(originFromPage?: string | null): string {
	return `${siteOrigin(originFromPage)}/pwa/icon-512x512.png`;
}

/** Strip simple inline markdown used in changelog copy. */
export function plainText(input: string): string {
	return input
		.replace(/\*\*(.+?)\*\*/g, "$1")
		.replace(/`([^`]+)`/g, "$1")
		.replace(/\s+/g, " ")
		.trim();
}

export function truncate(text: string, max = 160): string {
	if (text.length <= max) return text;
	const slice = text.slice(0, max - 1);
	const cut = slice.lastIndexOf(" ");
	return `${(cut > 80 ? slice.slice(0, cut) : slice).trimEnd()}…`;
}

export type SeoBreadcrumb = {
	name: string;
	path: string;
};

export function docsJsonLd(input: {
	origin: string | null | undefined;
	title: string;
	description: string;
	path: string;
	locale: "en" | "zh";
	sectionTitle: string;
	breadcrumbs: SeoBreadcrumb[];
}): string {
	const origin = siteOrigin(input.origin);
	const pageUrl = canonicalUrl(origin, input.path);
	const docsHome =
		input.locale === "zh"
			? canonicalUrl(origin, "/zh/docs")
			: canonicalUrl(origin, "/docs");
	const inLanguage = input.locale === "zh" ? "zh-CN" : "en";

	const graph = [
		{
			"@type": "TechArticle",
			headline: input.title,
			description: input.description,
			url: pageUrl,
			inLanguage,
			isPartOf: {
				"@type": "WebSite",
				name: input.locale === "zh" ? "Cohub 文档" : "Cohub Docs",
				url: docsHome,
			},
			articleSection: input.sectionTitle,
		},
		{
			"@type": "BreadcrumbList",
			itemListElement: input.breadcrumbs.map((crumb, index) => ({
				"@type": "ListItem",
				position: index + 1,
				name: crumb.name,
				item: canonicalUrl(origin, crumb.path),
			})),
		},
	];

	return JSON.stringify({
		"@context": "https://schema.org",
		"@graph": graph,
	});
}
