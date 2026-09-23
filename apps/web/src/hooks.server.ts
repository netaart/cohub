import type { Handle } from "@sveltejs/kit";
import { resolvePublicLocale } from "$lib/i18n/public-locale";
import {
	isPublicSharePath,
	PUBLIC_NOT_FOUND_CACHE_CONTROL,
} from "$lib/server/public-cache";

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

/** Set <html lang> for SSR / prerendered HTML (client nav handled in pages). */
export const handle: Handle = async ({ event, resolve }) => {
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
