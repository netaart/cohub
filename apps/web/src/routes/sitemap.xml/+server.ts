import { entries } from "#lib/changelog/index.ts";
import {
	DOCS_LOCALES,
	type DocsLocale,
	docsHref,
	getDocsNavItems,
} from "#lib/docs/index.ts";
import { siteOrigin } from "#lib/seo.ts";

export const prerender = true;

const STATIC_PATHS = [
	"/",
	"/docs",
	"/zh/docs",
	"/pricing",
	"/zh/pricing",
	"/zh",
	"/changelog",
] as const;

function escapeXml(value: string): string {
	return value
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&apos;");
}

type SitemapUrl = {
	path: string;
	priority: string;
	changefreq: string;
	lastmod?: string;
	alternates?: Array<{ hreflang: string; path: string }>;
};

function docsSitemapUrls(): SitemapUrl[] {
	const urls: SitemapUrl[] = [];
	for (const item of getDocsNavItems()) {
		const enPath = docsHref(item.slug, "en");
		const zhPath = docsHref(item.slug, "zh");
		const alternates = [
			{ hreflang: "en", path: enPath },
			{ hreflang: "zh-CN", path: zhPath },
			{ hreflang: "x-default", path: enPath },
		];
		for (const locale of DOCS_LOCALES as DocsLocale[]) {
			const path = docsHref(item.slug, locale);
			// Home paths are also in STATIC_PATHS for priority; skip duplicates here.
			if (!item.slug) continue;
			urls.push({
				path,
				priority: "0.7",
				changefreq: "weekly",
				alternates,
			});
		}
	}
	return urls;
}

function renderUrl(origin: string, entry: SitemapUrl): string {
	const loc = entry.path === "/" ? `${origin}/` : `${origin}${entry.path}`;
	const lines = [`  <url>`, `    <loc>${escapeXml(loc)}</loc>`];
	if (entry.lastmod) {
		lines.push(`    <lastmod>${escapeXml(entry.lastmod)}</lastmod>`);
	}
	lines.push(
		`    <changefreq>${entry.changefreq}</changefreq>`,
		`    <priority>${entry.priority}</priority>`,
	);
	for (const alt of entry.alternates ?? []) {
		const href = alt.path === "/" ? `${origin}/` : `${origin}${alt.path}`;
		lines.push(
			`    <xhtml:link rel="alternate" hreflang="${escapeXml(alt.hreflang)}" href="${escapeXml(href)}" />`,
		);
	}
	lines.push(`  </url>`);
	return lines.join("\n");
}

export function GET() {
	const origin = siteOrigin();
	const latest = entries[0]?.date ?? null;

	const staticEntries: SitemapUrl[] = STATIC_PATHS.map((path) => {
		const isDocsHome = path === "/docs" || path === "/zh/docs";
		const isLocalizedPair =
			path === "/zh" ||
			path === "/zh/pricing" ||
			path === "/docs" ||
			path === "/zh/docs" ||
			path === "/pricing";
		const alternates = isDocsHome
			? [
					{ hreflang: "en", path: "/docs" },
					{ hreflang: "zh-CN", path: "/zh/docs" },
					{ hreflang: "x-default", path: "/docs" },
				]
			: isLocalizedPair && (path === "/pricing" || path === "/zh/pricing")
				? [
						{ hreflang: "en", path: "/pricing" },
						{ hreflang: "zh-CN", path: "/zh/pricing" },
						{ hreflang: "x-default", path: "/pricing" },
					]
				: isLocalizedPair && path === "/zh"
					? [
							{ hreflang: "en", path: "/" },
							{ hreflang: "zh-CN", path: "/zh" },
							{ hreflang: "x-default", path: "/" },
						]
					: undefined;
		return {
			path,
			priority:
				path === "/"
					? "1.0"
					: isDocsHome || path === "/changelog"
						? "0.8"
						: "0.7",
			changefreq: path === "/changelog" || isDocsHome ? "weekly" : "monthly",
			lastmod: path === "/changelog" && latest ? latest : undefined,
			alternates,
		};
	});

	const body = [
		`<?xml version="1.0" encoding="UTF-8"?>`,
		`<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">`,
		...staticEntries.map((entry) => renderUrl(origin, entry)),
		...docsSitemapUrls().map((entry) => renderUrl(origin, entry)),
		`</urlset>`,
		``,
	].join("\n");

	return new Response(body, {
		headers: {
			"Content-Type": "application/xml; charset=utf-8",
			"Cache-Control": "public, max-age=3600",
		},
	});
}
