import type { RequestHandler } from "@sveltejs/kit";
import { buildAppPwaMeta, resolvePublicAppStartUrl } from "#lib/app-pwa.ts";
import { loadPublicAppDetail } from "#lib/server/public-api.ts";
import { PUBLIC_PAGE_CACHE_CONTROL } from "#lib/server/public-cache.ts";
import {
	DEFAULT_PWA_BACKGROUND_COLOR,
	DEFAULT_PWA_THEME_COLOR,
} from "#lib/system-chrome.ts";

function iconMimeType(url: string) {
	const path = url.split("?")[0]?.split("#")[0]?.toLowerCase() ?? "";
	if (path.endsWith(".svg")) return "image/svg+xml";
	if (path.endsWith(".webp")) return "image/webp";
	if (path.endsWith(".gif")) return "image/gif";
	if (path.endsWith(".ico")) return "image/x-icon";
	if (path.endsWith(".jpg") || path.endsWith(".jpeg")) return "image/jpeg";
	return "image/png";
}

function buildIcons() {
	return [
		{
			src: "/pwa/app-icon-192x192.png",
			sizes: "192x192",
			type: "image/png",
		},
		{
			src: "/pwa/app-icon-512x512.png",
			sizes: "512x512",
			type: "image/png",
		},
		{
			src: "/pwa/app-icon-maskable-192x192.png",
			sizes: "192x192",
			type: "image/png",
			purpose: "maskable",
		},
		{
			src: "/pwa/app-icon-maskable-512x512.png",
			sizes: "512x512",
			type: "image/png",
			purpose: "maskable",
		},
	];
}

export const GET: RequestHandler = async ({ fetch, url }) => {
	const { startUrl, path } = resolvePublicAppStartUrl(url);
	const result = await loadPublicAppDetail(path, fetch);
	// Same presentation path as link previews: resolve relative icons against content URL.
	const meta = buildAppPwaMeta(
		result.ok
			? {
					app: result.detail.app,
					space: result.detail.space,
					owner: result.detail.owner,
					publicUrl: result.detail.publicUrl,
					contentUrl: result.detail.content?.url ?? null,
				}
			: null,
	);
	const icons = meta.iconUrl
		? [
				{
					src: meta.iconUrl,
					sizes: "any",
					type: iconMimeType(meta.iconUrl),
					purpose: "any",
				},
				...buildIcons(),
			]
		: buildIcons();
	const manifest = {
		name: meta.name,
		short_name: meta.shortName,
		description: meta.description,
		id: startUrl,
		start_url: startUrl,
		scope: "/",
		theme_color: meta.themeColor || DEFAULT_PWA_THEME_COLOR,
		background_color: DEFAULT_PWA_BACKGROUND_COLOR,
		display: "standalone",
		icons,
	};

	return new Response(JSON.stringify(manifest), {
		headers: {
			"cache-control": PUBLIC_PAGE_CACHE_CONTROL,
			"content-type": "application/manifest+json; charset=utf-8",
		},
	});
};
