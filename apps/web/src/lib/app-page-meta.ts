import type { AppDetailResponse, AppMeta } from "@neta-art/cohub";
import { getAppFramePreconnectOrigin } from "$lib/app-url";
import {
	canonicalUrl,
	defaultOgImage,
	plainText,
	siteOrigin,
	truncate,
} from "$lib/seo";

const MAX_NAME_LENGTH = 72;
const MAX_SHORT_NAME_LENGTH = 24;
const HOST_LABEL = "Cohub";

function normalizeWorkLang(value: unknown): string | null {
	if (typeof value !== "string") return null;
	const tag = value.trim().replace(/_/g, "-").replace(/\s+/g, "");
	if (!tag || !/^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/.test(tag)) return null;
	const parts = tag.split("-");
	return parts
		.map((part, index) => {
			if (index === 0) return part.toLowerCase();
			if (part.length === 4)
				return `${part[0]?.toUpperCase() ?? ""}${part.slice(1).toLowerCase()}`;
			if (part.length === 2 || part.length === 3) return part.toUpperCase();
			return part;
		})
		.join("-");
}

function appLangToOgLocale(lang: string | null): string | null {
	return lang ? lang.replace(/-/g, "_") : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function cleanText(value: unknown, max = 500) {
	if (typeof value !== "string") return null;
	// Keep data:image URLs intact for icons.
	if (/^data:image\//i.test(value.trim())) {
		const data = value.trim();
		return data.length > 8192 ? null : data;
	}
	// Strip lightweight markdown used in some meta sources, then normalize spaces.
	const text = plainText(value).replace(/\s+/g, " ").trim();
	if (!text) return null;
	return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}

/** Shared display title for app chrome (bar, iframe title, dialogs). */
export function appDisplayTitle(
	meta: AppMeta | null | undefined,
	fallback: string,
) {
	if (isRecord(meta)) {
		const titled = cleanText(meta.title) ?? cleanText(meta.name);
		if (titled) return titled;
	}
	return fallback;
}

/**
 * Effective app icon URL for lists and chrome.
 *
 * The stored ref is already materialized to an absolute URL at publish time,
 * so a list response can render it with no extra fetch. Relative refs from
 * older publishes stay unresolved unless a `contentUrl` is supplied, in which
 * case they resolve against the published package like the public shell does.
 * Returns null when no usable source exists, so callers can fall back to a
 * generated tile.
 */
export function appIconUrl(
	meta: AppMeta | null | undefined,
	contentUrl?: string | null,
) {
	return resolveMediaRef(
		isRecord(meta) && typeof meta.icon === "string" ? meta.icon : null,
		contentUrl ?? null,
	);
}

/**
 * Aligns with `presentation.hideCohubBar` (Pro+):
 * minimal host branding on public share meta as well as the on-page bar.
 */
export function isMinimalAppBranding(meta: AppMeta | null | undefined) {
	return (
		isRecord(meta) &&
		isRecord(meta.presentation) &&
		meta.presentation.hideCohubBar === true
	);
}

function truncateText(value: string, maxLength: number) {
	if (value.length <= maxLength) return value;
	return `${value.slice(0, Math.max(1, maxLength - 1)).trimEnd()}…`;
}

function humanizeSlug(value: string) {
	return value
		.split(/[-_]+/)
		.filter(Boolean)
		.map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`)
		.join(" ")
		.trim();
}

function appName(input: {
	meta?: AppMeta | null;
	slug?: string | null;
	spaceName?: string | null;
}) {
	if (isRecord(input.meta)) {
		const titled = cleanText(input.meta.title) ?? cleanText(input.meta.name);
		if (titled) return titled;
	}
	const spaceName = cleanText(input.spaceName);
	if (spaceName) return spaceName;
	if (input.slug) {
		const humanized = humanizeSlug(input.slug);
		if (humanized) return humanized;
	}
	return "App";
}

/**
 * Resolve icon/image for the public shell.
 * Root-relative paths like `/favicon.svg` must join the app content URL,
 * not the Cohub host origin.
 */
function resolveMediaRef(
	ref: string | null | undefined,
	contentUrl: string | null | undefined,
): string | null {
	const value = cleanText(ref, 8192);
	if (!value) return null;
	if (/^data:image\//i.test(value)) return value;
	if (/^https:\/\//i.test(value)) return value;
	if (value.startsWith("//")) {
		try {
			return new URL(`https:${value}`).toString();
		} catch {
			return null;
		}
	}
	if (/^https?:/i.test(value) || /^data:/i.test(value)) return null;
	if (!contentUrl) return null;
	try {
		// Root-relative `/favicon.svg` is the app package root, not cohub.live/.
		const base = new URL(contentUrl);
		const relative = value.replace(/^\.\//, "").replace(/^\/+/, "");
		if (!relative || relative.includes("\0")) return null;
		const parts = relative.split("/");
		if (parts.some((part) => !part || part === "." || part === ".."))
			return null;
		const dir = base.pathname.replace(/\/[^/]*$/, "/");
		return new URL(parts.join("/"), `${base.origin}${dir}`).toString();
	} catch {
		return null;
	}
}

/**
 * Link-preview crawlers often ignore SVG / svg+xml for og:image.
 * Keep those for tab/PWA icons; only treat raster (and non-svg data images) as share images.
 */
function isSharePreviewImage(url: string | null | undefined): url is string {
	if (!url) return false;
	if (/^data:image\/svg\+xml/i.test(url)) return false;
	if (/^data:image\//i.test(url)) return true;
	try {
		const path = new URL(url).pathname.toLowerCase();
		return /\.(png|jpe?g|gif|webp|avif)$/i.test(path);
	} catch {
		return /\.(png|jpe?g|gif|webp|avif)(?:$|[?#])/i.test(url);
	}
}

export type AppPageDetail = {
	app: Pick<AppDetailResponse["app"], "meta" | "slug"> &
		Partial<
			Pick<AppDetailResponse["app"], "visibility" | "publishedAt" | "updatedAt">
		>;
	space?: Pick<AppDetailResponse["space"], "name"> | null;
	owner?: Pick<AppDetailResponse["owner"], "displayName" | "username"> | null;
	publicUrl?: string | null;
	/** Published content URL (…/index.html) used to resolve relative media. */
	contentUrl?: string | null;
	/** Embedded content kind, used for SSR resource hints. */
	contentKind?: "web" | "port" | null;
};

export type AppPageMeta = {
	/** Primary app name (no host suffix). */
	name: string;
	/** Document / tab / OG title. */
	documentTitle: string;
	/** Light host label for og:site_name — Work name when branding is minimal. */
	siteName: string;
	shortName: string;
	description: string;
	iconUrl: string | null;
	imageUrl: string | null;
	canonical: string;
	robots: string;
	indexable: boolean;
	/** True when hideCohubBar (minimal host branding). */
	minimalBranding: boolean;
	twitterCard: "summary" | "summary_large_image";
	/** BCP 47 language for <html lang> / inLanguage when known. */
	lang: string | null;
	ogLocale: string | null;
	themeColor: string | null;
	framePreconnectOrigin: string | null;
	jsonLd: string;
};

export function buildAppPageMeta(
	detail: AppPageDetail | null,
	options?: {
		origin?: string | null;
		path?: string | null;
		/** Force robots when detail is unavailable (e.g. auth-gated shell). */
		indexable?: boolean;
	},
): AppPageMeta {
	const app = detail?.app ?? null;
	const space = detail?.space ?? null;
	const owner = detail?.owner ?? null;
	const meta = app?.meta ?? null;
	const minimalBranding = isMinimalAppBranding(meta);
	const primaryName = appName({
		meta,
		slug: app?.slug ?? null,
		spaceName: space?.name ?? null,
	});
	const shortName = truncateText(primaryName, MAX_SHORT_NAME_LENGTH);
	const hasExplicitTitle = Boolean(
		isRecord(meta) && (cleanText(meta.title) || cleanText(meta.name)),
	);

	// Default: app title as-is; only brand generic fallbacks with a light host mark.
	// Minimal (hideCohubBar): never append host branding.
	const documentTitle = truncateText(
		hasExplicitTitle || minimalBranding
			? primaryName
			: `${primaryName} · ${HOST_LABEL}`,
		MAX_NAME_LENGTH,
	);
	// Default keeps a soft host signal; minimal uses the app name as site.
	const siteName = minimalBranding ? primaryName : HOST_LABEL;

	const explicitDescription = isRecord(meta)
		? cleanText(meta.description, 300)
		: null;
	const description = truncate(
		explicitDescription ??
			(space?.name
				? `Open ${primaryName} from ${space.name}`
				: `Open ${primaryName}`),
		160,
	);
	const contentUrl = detail?.contentUrl ?? null;
	const framePreconnectOrigin = detail?.contentKind
		? getAppFramePreconnectOrigin({
				contentUrl,
				baseHref: options?.origin ?? "https://cohub.live/",
				targetType: detail.contentKind === "port" ? "port" : "file",
			})
		: null;
	// Tab / PWA icon may be SVG; share cards need a raster-friendly image.
	const iconUrl = resolveMediaRef(
		isRecord(meta) ? meta.icon : null,
		contentUrl,
	);
	const resolvedImage = resolveMediaRef(
		isRecord(meta) ? meta.image : null,
		contentUrl,
	);
	const imageUrl =
		(isSharePreviewImage(resolvedImage) ? resolvedImage : null) ??
		(isSharePreviewImage(iconUrl) ? iconUrl : null) ??
		defaultOgImage(options?.origin);
	const path =
		options?.path ??
		(detail?.publicUrl
			? (() => {
					try {
						return new URL(detail.publicUrl).pathname;
					} catch {
						return null;
					}
				})()
			: null) ??
		"/";
	const canonical = canonicalUrl(options?.origin, path);
	const indexable =
		typeof options?.indexable === "boolean"
			? options.indexable
			: (app?.visibility ?? "public") === "public";
	const robots = indexable ? "index,follow" : "noindex,nofollow";
	const origin = siteOrigin(options?.origin);
	const authorName =
		cleanText(owner?.displayName) ?? cleanText(owner?.username) ?? HOST_LABEL;
	const lang =
		(isRecord(meta) ? normalizeWorkLang(meta.lang) : null) ??
		(isRecord(meta?.extracted) ? normalizeWorkLang(meta.extracted.lang) : null);
	const ogLocale = appLangToOgLocale(lang);
	const themeColor =
		(isRecord(meta) ? cleanText(meta.themeColor, 64) : null) ??
		(isRecord(meta?.extracted)
			? cleanText(meta.extracted.themeColor, 64)
			: null);
	const graph = [
		{
			"@type": "WebApplication",
			name: primaryName,
			description,
			url: canonical,
			applicationCategory: "WebApplication",
			operatingSystem: "Any",
			inLanguage: lang ?? undefined,
			image: imageUrl,
			author: {
				"@type": "Person",
				name: authorName,
				url: owner?.username ? `${origin}/${owner.username}` : undefined,
			},
			isPartOf: {
				"@type": "WebSite",
				name: siteName,
				url: origin,
			},
			datePublished: app?.publishedAt ?? undefined,
			dateModified: app?.updatedAt ?? app?.publishedAt ?? undefined,
		},
	];
	const jsonLd = JSON.stringify({
		"@context": "https://schema.org",
		"@graph": graph,
	});

	return {
		name: primaryName,
		documentTitle,
		siteName,
		shortName,
		description,
		iconUrl,
		imageUrl,
		canonical,
		robots,
		indexable,
		minimalBranding,
		twitterCard:
			imageUrl && imageUrl !== defaultOgImage(options?.origin)
				? "summary_large_image"
				: "summary",
		lang,
		ogLocale,
		themeColor,
		framePreconnectOrigin,
		jsonLd,
	};
}

/** Backward-compatible PWA helpers built on the same resolver. */
export function buildAppPwaMeta(detail: AppPageDetail | null) {
	const page = buildAppPageMeta(detail);
	return {
		name: page.documentTitle,
		shortName: page.shortName,
		description: page.description,
		iconUrl: page.iconUrl,
		imageUrl: page.imageUrl,
		themeColor: page.themeColor,
	};
}
