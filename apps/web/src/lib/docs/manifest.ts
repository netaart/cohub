import type {
	DocsLocale,
	DocsNavItem,
	DocsSection,
	DocsSectionId,
} from "./types.ts";

/**
 * Product docs navigation.
 * Content slugs are shared across locales; titles are localized via maps below.
 */
const NAV_ITEMS: DocsNavItem[] = [
	{
		slug: "",
		title: "Overview",
		section: "learn",
		file: "index.md",
	},
	{
		slug: "learn/core-concepts",
		title: "Core concepts",
		section: "learn",
		file: "learn/core-concepts.md",
	},
	{
		slug: "learn/product-map",
		title: "Product map",
		section: "learn",
		file: "learn/product-map.md",
	},
	{
		slug: "learn/quick-start",
		title: "Quick start",
		section: "learn",
		file: "learn/quick-start.md",
	},
	{
		slug: "workspace/spaces",
		title: "Spaces",
		section: "workspace",
		file: "workspace/spaces.md",
	},
	{
		slug: "workspace/chats",
		title: "Chats",
		section: "workspace",
		file: "workspace/chats.md",
	},
	{
		slug: "workspace/files-and-sandbox",
		title: "Files & Sandbox",
		section: "workspace",
		file: "workspace/files-and-sandbox.md",
	},
	{
		slug: "workspace/saves",
		title: "Saves",
		section: "workspace",
		file: "workspace/saves.md",
	},
	{
		slug: "create/apps",
		title: "Apps",
		section: "create",
		file: "create/apps.md",
	},
	{
		slug: "developers/apps",
		title: "App development",
		section: "developers",
		file: "developers/apps.md",
	},
	{
		slug: "developers/cli",
		title: "CLI",
		section: "developers",
		file: "developers/cli.md",
	},
	{
		slug: "developers/sdk",
		title: "SDK",
		section: "developers",
		file: "developers/sdk.md",
	},
];

const SECTION_TITLES: Record<DocsLocale, Record<DocsSectionId, string>> = {
	en: {
		learn: "Learn",
		workspace: "Workspace",
		create: "Create & Share",
		collaborate: "Collaborate",
		extend: "Extend",
		account: "Account",
		developers: "Developers",
	},
	zh: {
		learn: "入门",
		workspace: "工作区",
		create: "创作与分享",
		collaborate: "协作",
		extend: "扩展",
		account: "账户",
		developers: "开发者",
	},
};

const NAV_TITLES: Record<DocsLocale, Record<string, string>> = {
	en: Object.fromEntries(NAV_ITEMS.map((item) => [item.slug, item.title])),
	zh: {
		"": "概览",
		"learn/core-concepts": "核心概念",
		"learn/product-map": "产品地图",
		"learn/quick-start": "快速开始",
		"workspace/spaces": "Spaces",
		"workspace/chats": "Chats",
		"workspace/files-and-sandbox": "Files 与 Sandbox",
		"workspace/saves": "Saves",
		"create/apps": "Apps",
		"developers/apps": "App 开发",
		"developers/cli": "CLI",
		"developers/sdk": "SDK",
	},
};

const SECTION_ORDER: DocsSectionId[] = [
	"learn",
	"workspace",
	"create",
	"collaborate",
	"extend",
	"account",
	"developers",
];

export const DOCS_LOCALES: DocsLocale[] = ["en", "zh"];
export const DEFAULT_DOCS_LOCALE: DocsLocale = "en";

export function isDocsLocale(
	value: string | null | undefined,
): value is DocsLocale {
	return value === "en" || value === "zh";
}

export function docsHref(slug: string, locale: DocsLocale = "en"): string {
	const normalized = slug.replace(/^\/+|\/+$/g, "");
	if (locale === "en") {
		return normalized ? `/docs/${normalized}` : "/docs";
	}
	return normalized ? `/zh/docs/${normalized}` : "/zh/docs";
}

export function alternateDocsHref(slug: string, locale: DocsLocale): string {
	return docsHref(slug, locale === "en" ? "zh" : "en");
}

export function getDocsNavItems(): DocsNavItem[] {
	return NAV_ITEMS;
}

export function getDocsNavTitle(
	slug: string,
	locale: DocsLocale = "en",
): string {
	return NAV_TITLES[locale][slug] ?? NAV_TITLES.en[slug] ?? (slug || "Docs");
}

export function getDocsSections(locale: DocsLocale = "en"): DocsSection[] {
	return SECTION_ORDER.map((id) => ({
		id,
		title: SECTION_TITLES[locale][id],
		items: NAV_ITEMS.filter((item) => item.section === id).map((item) => ({
			...item,
			title: getDocsNavTitle(item.slug, locale),
			href: docsHref(item.slug, locale),
		})),
	})).filter((section) => section.items.length > 0);
}

export function getDocsSectionTitle(
	id: DocsSectionId,
	locale: DocsLocale = "en",
): string {
	return SECTION_TITLES[locale][id];
}

export function findDocsNavItem(slug: string): DocsNavItem | null {
	const normalized = slug.replace(/^\/+|\/+$/g, "");
	return NAV_ITEMS.find((item) => item.slug === normalized) ?? null;
}

/** Parse locale + content slug from a docs pathname. */
export function parseDocsPath(pathname: string): {
	locale: DocsLocale;
	slug: string;
} {
	const path = pathname.replace(/\/+$/, "") || "/";
	if (path === "/docs" || path === "/docs/") {
		return { locale: "en", slug: "" };
	}
	if (path.startsWith("/docs/")) {
		return { locale: "en", slug: path.slice("/docs/".length) };
	}
	if (path === "/zh/docs" || path === "/zh/docs/") {
		return { locale: "zh", slug: "" };
	}
	if (path.startsWith("/zh/docs/")) {
		return { locale: "zh", slug: path.slice("/zh/docs/".length) };
	}
	return { locale: "en", slug: "" };
}
