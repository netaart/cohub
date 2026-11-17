import { docsHref } from "#lib/docs/manifest.ts";
import {
	canonicalUrl,
	defaultOgImage,
	docsJsonLd,
	type SeoBreadcrumb,
} from "#lib/seo.ts";
import { page } from "$app/state";
import type { DocsPage } from "./types.ts";
import { getDocsUi } from "./ui.ts";

export type DocsSeo = {
	title: string;
	description: string;
	canonical: string;
	enHref: string;
	zhHref: string;
	ogImage: string;
	ogLocale: string;
	altLocale: string;
	jsonLd: string;
};

/**
 * Compute SEO values for a docs page. The page's own `<svelte:head>` renders
 * these as explicit tags (SvelteKit prerender captures explicit head markup in
 * the page root; `{@html}` strings and deep child `<svelte:head>` are dropped).
 */
export function docsSeo(doc: DocsPage): DocsSeo {
	const origin = page.url.origin;
	const ui = getDocsUi(doc.locale);
	const canonical = canonicalUrl(origin, doc.href);
	const enHref = canonicalUrl(origin, docsHref(doc.slug, "en"));
	const zhHref = canonicalUrl(origin, docsHref(doc.slug, "zh"));
	const title =
		doc.locale === "zh"
			? `${doc.title} — Cohub 文档`
			: `${doc.title} — Cohub Docs`;
	const breadcrumbs: SeoBreadcrumb[] = [
		{ name: ui.docsLabel, path: docsHref("", doc.locale) },
	];
	if (doc.slug) breadcrumbs.push({ name: doc.title, path: doc.href });
	const jsonLd = docsJsonLd({
		origin,
		title: doc.title,
		description: doc.description,
		path: doc.href,
		locale: doc.locale,
		sectionTitle: doc.sectionTitle,
		breadcrumbs,
	});
	return {
		title,
		description: doc.description,
		canonical,
		enHref,
		zhHref,
		ogImage: defaultOgImage(origin),
		ogLocale: doc.locale === "zh" ? "zh_CN" : "en_US",
		altLocale: doc.locale === "zh" ? "en_US" : "zh_CN",
		jsonLd,
	};
}
