const CACHEABLE_STATUS = new Set([
	200, 203, 204, 300, 301, 404, 405, 410, 414, 501,
]);

export function isEdgeCacheable(response: Response): boolean {
	if (!CACHEABLE_STATUS.has(response.status)) return false;
	if (response.headers.has("set-cookie")) return false;
	if (response.headers.get("vary")?.includes("*")) return false;
	const policy = response.headers.get("cache-control")?.toLowerCase() ?? "";
	if (!/(^|,)\s*public\s*(,|$)/.test(policy)) return false;
	if (/(^|,)\s*(private|no-store|no-cache)\b/.test(policy)) return false;
	const ttl =
		/(?:^|,)\s*s-maxage=(\d+)/.exec(policy) ??
		/(?:^|,)\s*max-age=(\d+)/.exec(policy);
	return Number(ttl?.[1]) > 0;
}

let pages: Promise<Cache | null> | undefined;

export async function withEdgeCache(
	request: Request,
	waitUntil: (promise: Promise<unknown>) => void,
	respond: () => Promise<Response>,
): Promise<Response> {
	if (
		request.method !== "GET" ||
		new URL(request.url).pathname.startsWith("/_app/")
	)
		return respond();
	pages ??= caches.open("pages").catch(() => {
		pages = undefined;
		return null;
	});
	const cache = await pages;
	if (!cache) return respond();
	if (!request.headers.get("cache-control")?.includes("no-cache")) {
		const hit = await cache.match(request).catch(() => undefined);
		if (hit) return hit;
	}
	const response = await respond();
	if (isEdgeCacheable(response))
		waitUntil(cache.put(request, response.clone()).catch(() => {}));
	return response;
}
