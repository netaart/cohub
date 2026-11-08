import type { Handle, RequestEvent } from "@sveltejs/kit";
import { resolvePublicLocale } from "$lib/i18n/public-locale";
import { publicSlugRedirectLocation } from "$lib/public-slug-redirect";
import { loadPublicSpaceRedirect } from "$lib/server/public-api";
import {
	isPublicSharePath,
	PUBLIC_NOT_FOUND_CACHE_CONTROL,
	PUBLIC_SLUG_REDIRECT_CACHE_CONTROL,
} from "$lib/server/public-cache";

const PUBLIC_SPACE_ROUTE_ID = "/(app)/[username]/[spaceSlug]";

function resolveHtmlLang(pathname: string, html: string): string {
	const urlLocale = resolvePublicLocale(pathname);
	if (urlLocale !== "en") return urlLocale;

	const segments = pathname.split("/").filter(Boolean);
	if (segments.length === 4 && segments[2] === "w") {
		const match =
			html.match(
				/<meta\b[^>]*\bname=["']cohub-app-lang["'][^>]*\bcontent=["']([^"']+)["'][^>]*>/i,
			) ??
			html.match(
				/<meta\b[^>]*\bcontent=["']([^"']+)["'][^>]*\bname=["']cohub-app-lang["'][^>]*>/i,
			);
		const workLang = match?.[1]?.trim();
		if (workLang && /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/.test(workLang)) {
			return workLang;
		}
	}
	return "en";
}

/**
 * The Space page is a CSR shell (`ssr = false`), so its loads never run for the document.
 * Resolve old usernames / Space slugs here to answer the document itself with a 308;
 * client navigations follow `redirectTo` in the page's own load.
 */
async function publicSpaceRedirect(
	event: RequestEvent,
): Promise<Response | null> {
	if (event.route.id !== PUBLIC_SPACE_ROUTE_ID || event.isDataRequest)
		return null;
	if (event.request.method !== "GET") return null;
	const dest = event.request.headers.get("sec-fetch-dest");
	if (dest && dest !== "document") return null;
	const { username = "", spaceSlug = "" } = event.params;
	const location = publicSlugRedirectLocation(
		await loadPublicSpaceRedirect(username, spaceSlug, event.fetch),
		event.url,
	);
	if (!location) return null;
	return new Response(null, {
		status: 308,
		headers: { location, "cache-control": PUBLIC_SLUG_REDIRECT_CACHE_CONTROL },
	});
}

/** Set <html lang> for SSR / prerendered HTML (client nav handled in pages). */
export const handle: Handle = async ({ event, resolve }) => {
	const spaceRedirect = await publicSpaceRedirect(event);
	if (spaceRedirect) return spaceRedirect;

	const response = await resolve(event, {
		transformPageChunk: ({ html }) =>
			html.replace(
				/<html lang="[^"]*">/,
				`<html lang="${resolveHtmlLang(event.url.pathname, html)}">`,
			),
	});

	// error() paths drop load setHeaders(); apply a short public 404 cache here.
	if (
		response.status === 404 &&
		isPublicSharePath(event.url.pathname) &&
		!response.headers.has("cache-control")
	) {
		response.headers.set("cache-control", PUBLIC_NOT_FOUND_CACHE_CONTROL);
	}

	return response;
};
