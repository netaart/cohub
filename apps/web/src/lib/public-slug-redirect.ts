/**
 * Page URL for an API `redirectTo` (old username / Space slug): the canonical
 * pathname with the page's own query string. Null when there is nothing to follow.
 */
export function publicSlugRedirectLocation(
	redirectTo: unknown,
	url: URL,
): string | null {
	if (typeof redirectTo !== "string") return null;
	const pathname = new URL(redirectTo, url.origin).pathname;
	return pathname === url.pathname ? null : `${pathname}${url.search}`;
}
