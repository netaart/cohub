/** Shared cache policy for public SSR pages and API-backed loaders. */

export const PUBLIC_PAGE_CACHE_CONTROL =
	"public, max-age=60, stale-while-revalidate=300";

/** Revalidate so a publish shows on the next load. */
export const PUBLIC_APP_PAGE_CACHE_CONTROL = "public, no-cache";

export const PRIVATE_NO_STORE_CACHE_CONTROL = "private, no-store";

export const PUBLIC_NOT_FOUND_CACHE_CONTROL =
	"public, max-age=30, stale-while-revalidate=60";

type SetHeaders = (headers: Record<string, string>) => void;

export function setPublicAppPageCache(
	setHeaders: SetHeaders,
	options?: { private?: boolean },
) {
	setHeaders({
		"cache-control": options?.private
			? PRIVATE_NO_STORE_CACHE_CONTROL
			: PUBLIC_APP_PAGE_CACHE_CONTROL,
	});
}

/** Map upstream/public API failures to a stable page status. */
export function publicPageErrorStatus(status: number): number {
	if (status === 404) return 404;
	if (status === 401 || status === 403) return status;
	if (status >= 500 || status <= 0) return 502;
	if (status >= 400) return status;
	return 502;
}

/** Public profile / work URL shapes that may safely short-cache 404 HTML. */
export function isPublicSharePath(pathname: string): boolean {
	const segments = pathname.split("/").filter(Boolean);
	if (segments.length === 1) return true;
	return segments.length === 4 && segments[2] === "w";
}
