/**
 * Path prefixes served on the same origin by the separate cohub-seo Worker,
 * not by apps/web. Links to them need a full page load: the SvelteKit router
 * and prerender crawler would otherwise treat them as app routes.
 */
export const SEO_WORKER_PATH_PREFIXES = [
	"/use-cases",
	"/compare",
	"/features",
	"/guides",
	"/legal",
	"/updates",
] as const;

export function isSeoWorkerPath(href: string): boolean {
	const path = href.replace(/^\/zh(?=\/|$)/, "") || "/";
	return SEO_WORKER_PATH_PREFIXES.some(
		(prefix) =>
			path === prefix ||
			path.startsWith(`${prefix}/`) ||
			path.startsWith(`${prefix}#`) ||
			path.startsWith(`${prefix}?`),
	);
}
