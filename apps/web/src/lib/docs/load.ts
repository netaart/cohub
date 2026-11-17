import { renderMarkdown } from "#lib/markdown.ts";
import {
	alternateDocsHref,
	docsHref,
	findDocsNavItem,
	getDocsNavItems,
	getDocsNavTitle,
	getDocsSections,
	getDocsSectionTitle,
} from "./manifest.ts";
import { injectHeadingAnchors, parseDocsFrontmatter } from "./parse.ts";
import type {
	DocsLocale,
	DocsPage,
	DocsSearchEntry,
	DocsSibling,
} from "./types.ts";

/** Cap search body text so layout payloads stay small. */
const SEARCH_BODY_CHARS = 800;

// Alias resolves to repo docs/product via vite.config.
const rawPages = import.meta.glob("$docs-product/*/**/*.md", {
	query: "?raw",
	import: "default",
	eager: true,
}) as Record<string, string>;

const sourceByKey = new Map<string, string>();
for (const [key, source] of Object.entries(rawPages)) {
	const normalized = key.replace(/\\/g, "/");
	const match = normalized.match(/\/(en|zh)\/(.+\.md)$/);
	if (match) sourceByKey.set(`${match[1]}/${match[2]}`, source);
}

function fileToSource(locale: DocsLocale, file: string): string | null {
	return sourceByKey.get(`${locale}/${file}`) ?? null;
}

/** Lightweight plain text for search — no full markdown render. */
function bodyToSearchText(body: string): string {
	return body
		.replace(/```[\s\S]*?```/g, " ")
		.replace(/`[^`]+`/g, " ")
		.replace(/!\[[^\]]*]\([^)]*\)/g, " ")
		.replace(/\[([^\]]+)]\([^)]*\)/g, "$1")
		.replace(/^#{1,6}\s+/gm, "")
		.replace(/^>\s?/gm, "")
		.replace(/^[-*+]\s+/gm, "")
		.replace(/\|/g, " ")
		.replace(/[*_~]+/g, "")
		.replace(/\s+/g, " ")
		.trim()
		.slice(0, SEARCH_BODY_CHARS)
		.toLowerCase();
}

function siblingFrom(
	slug: string,
	locale: DocsLocale,
	title: string,
): DocsSibling {
	return { slug, title, href: docsHref(slug, locale) };
}

export function listDocsSources(locale: DocsLocale = "en"): {
	file: string;
	present: boolean;
}[] {
	return getDocsNavItems().map((item) => ({
		file: item.file,
		present: fileToSource(locale, item.file) !== null,
	}));
}

export async function loadDocsPage(
	slug: string,
	locale: DocsLocale = "en",
): Promise<DocsPage | null> {
	const nav = findDocsNavItem(slug);
	if (!nav) return null;

	const source = fileToSource(locale, nav.file);
	if (source == null) return null;

	const { frontmatter, body } = parseDocsFrontmatter(source);
	const rendered = await renderMarkdown(body);
	const { html, toc } = injectHeadingAnchors(rendered);

	const items = getDocsNavItems();
	const index = items.findIndex((item) => item.slug === nav.slug);
	const prevItem = index > 0 ? items[index - 1] : null;
	const nextItem =
		index >= 0 && index < items.length - 1 ? items[index + 1] : null;

	const title = frontmatter.title || getDocsNavTitle(nav.slug, locale);

	return {
		locale,
		slug: nav.slug,
		title,
		description: frontmatter.description,
		section: nav.section,
		sectionTitle: getDocsSectionTitle(nav.section, locale),
		body,
		html,
		toc,
		prev: prevItem
			? siblingFrom(
					prevItem.slug,
					locale,
					getDocsNavTitle(prevItem.slug, locale),
				)
			: null,
		next: nextItem
			? siblingFrom(
					nextItem.slug,
					locale,
					getDocsNavTitle(nextItem.slug, locale),
				)
			: null,
		href: docsHref(nav.slug, locale),
		alternateHref: alternateDocsHref(nav.slug, locale),
	};
}

export async function loadDocsSearchIndex(
	locale: DocsLocale = "en",
): Promise<DocsSearchEntry[]> {
	const entries: DocsSearchEntry[] = [];

	for (const item of getDocsNavItems()) {
		const source = fileToSource(locale, item.file);
		if (source == null) continue;
		const { frontmatter, body } = parseDocsFrontmatter(source);
		const title = frontmatter.title || getDocsNavTitle(item.slug, locale);
		const description = frontmatter.description;
		const bodyText = bodyToSearchText(body);

		entries.push({
			slug: item.slug,
			title,
			description,
			sectionTitle: getDocsSectionTitle(item.section, locale),
			href: docsHref(item.slug, locale),
			text: `${title} ${description} ${bodyText}`.toLowerCase(),
		});
	}

	return entries;
}

export { docsHref, getDocsNavItems, getDocsSections };
