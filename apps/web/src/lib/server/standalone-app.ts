import { SANDBOX_PUBLIC_PORTS } from "@cohub/protocol";
import type { AppDetailResponse } from "@neta-art/cohub";

const APP_CACHE_CONTROL = "public, max-age=60, stale-while-revalidate=300";
const FORWARDED_REQUEST_HEADERS = [
	"if-modified-since",
	"if-none-match",
	"range",
];
const FORWARDED_RESPONSE_HEADERS = [
	"accept-ranges",
	"content-language",
	"content-range",
	"content-type",
	"etag",
	"last-modified",
];

const STANDALONE_DETAIL_CACHE_TTL_MS = 30_000;
const STANDALONE_DETAIL_CACHE_MAX_ENTRIES = 128;
const standaloneDetailCache = new Map<
	string,
	{ expiresAt: number; detail: AppDetailResponse | null }
>();
const SANDBOX_HOST_RE =
	/^([a-z])-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}-(\d{2,5})\.(.+)$/;

/**
 * Port Apps are proxied only to this deployment's sandbox hosts, so a
 * resolved upstream can never turn the edge into an open proxy.
 */
export type PortUpstreamPolicy = {
	/** `s` in production, `d` elsewhere, as the API names sandbox hosts. */
	prefix: string;
	/** Zones sandbox hosts live in; same-zone fetches keep the visitor IP. */
	zones: readonly string[];
};

export function isSandboxUpstream(value: string, policy: PortUpstreamPolicy) {
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		return false;
	}
	if (url.protocol !== "https:" || url.port || url.pathname !== "/")
		return false;
	const match = SANDBOX_HOST_RE.exec(url.hostname);
	return Boolean(
		match &&
			match[1] === policy.prefix &&
			(SANDBOX_PUBLIC_PORTS as readonly number[]).includes(Number(match[2])) &&
			policy.zones.includes(match[3] ?? ""),
	);
}

type StandaloneDetailResult =
	| { status: "ok"; detail: AppDetailResponse }
	| { status: "not_found" }
	| { status: "unavailable" };

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asAppDetail(
	value: unknown,
	portPolicy: PortUpstreamPolicy | null,
): AppDetailResponse | null {
	if (!isRecord(value) || !isRecord(value.app) || !isRecord(value.space))
		return null;
	if (typeof value.app.id !== "string" || value.app.visibility !== "public")
		return null;
	if (typeof value.space.id !== "string" || !isRecord(value.content))
		return null;
	if (value.content.kind === "port") {
		return portPolicy &&
			typeof value.content.url === "string" &&
			isSandboxUpstream(value.content.url, portPolicy)
			? (value as AppDetailResponse)
			: null;
	}
	if (value.content.kind !== "web") return null;
	if (
		value.content.targetType !== "file" &&
		value.content.targetType !== "directory"
	)
		return null;
	if (typeof value.content.url !== "string") return null;
	return value as AppDetailResponse;
}

/** Schedules work that must finish after the response, e.g. `ctx.waitUntil`. */
export type WaitUntil = (promise: Promise<unknown>) => void;

/** `undefined` on a miss; `null` for a cached "no App here". */
function readCachedDetail(
	origin: string,
): AppDetailResponse | null | undefined {
	const cached = standaloneDetailCache.get(origin);
	if (!cached) return undefined;
	standaloneDetailCache.delete(origin);
	if (cached.expiresAt <= Date.now()) return undefined;
	// Re-insert to keep Map order least-recently-used first.
	standaloneDetailCache.set(origin, cached);
	return cached.detail;
}

function writeCachedDetail(origin: string, detail: AppDetailResponse | null) {
	standaloneDetailCache.delete(origin);
	standaloneDetailCache.set(origin, {
		expiresAt: Date.now() + STANDALONE_DETAIL_CACHE_TTL_MS,
		detail,
	});
	while (standaloneDetailCache.size > STANDALONE_DETAIL_CACHE_MAX_ENTRIES) {
		const oldest = standaloneDetailCache.keys().next().value;
		if (typeof oldest !== "string") break;
		standaloneDetailCache.delete(oldest);
	}
}

type DetailRequest = {
	apiOrigin: string;
	origin: string;
	fetcher: typeof fetch;
	recordView: boolean;
	/** Set for custom domains, which may serve port Apps. */
	portPolicy?: PortUpstreamPolicy | null;
	/** Remember misses too, so scans of unbound hosts stay off the API. */
	cacheMisses?: boolean;
};

async function fetchStandaloneAppDetail(
	input: DetailRequest,
): Promise<StandaloneDetailResult> {
	const query = `?origin=${encodeURIComponent(input.origin)}${input.recordView ? "&view=1" : ""}`;
	const response = await input
		.fetcher(`${input.apiOrigin}/api/apps/by-origin${query}`, {
			headers: { Accept: "application/json" },
		})
		.catch(() => null);
	if (!response) return { status: "unavailable" };
	if (response.status === 404) {
		if (input.cacheMisses) writeCachedDetail(input.origin, null);
		else standaloneDetailCache.delete(input.origin);
		return { status: "not_found" };
	}
	if (!response.ok) return { status: "unavailable" };
	const parsed = await response.json().catch(() => undefined);
	const detail = asAppDetail(parsed, input.portPolicy ?? null);
	if (!detail) return { status: "unavailable" };
	writeCachedDetail(input.origin, detail);
	return { status: "ok", detail };
}

/**
 * Resolves the App behind a standalone origin, serving from the short-lived
 * cache when possible.
 *
 * A document navigation records a view through the same API call. On a cache
 * hit that call runs after the response via `waitUntil`, so recording views
 * never delays the page; it also refreshes the cached detail.
 */
export async function loadStandaloneAppDetail(
	input: DetailRequest & { waitUntil: WaitUntil },
): Promise<StandaloneDetailResult> {
	const request = { ...input, apiOrigin: input.apiOrigin.replace(/\/+$/, "") };
	if (!request.apiOrigin) return { status: "unavailable" };
	const cached = readCachedDetail(input.origin);
	if (cached === null) return { status: "not_found" };
	if (!cached) return fetchStandaloneAppDetail(request);
	if (input.recordView) input.waitUntil(fetchStandaloneAppDetail(request));
	return { status: "ok", detail: cached };
}

export function resolveStandaloneAssetUrl(
	content: Extract<AppDetailResponse["content"], { kind: "web" }>,
	pathname: string,
): URL | null {
	if (/%2f|%5c|\0/i.test(pathname)) return null;
	let entry: URL;
	try {
		entry = new URL(content.url);
	} catch {
		return null;
	}
	if (entry.protocol !== "https:") return null;
	if (pathname === "/" || pathname === "/index.html") return entry;
	if (content.targetType === "file") return null;

	const base = new URL(".", entry);
	const target = new URL(`./${pathname.replace(/^\/+/, "")}`, base);
	if (
		target.origin !== base.origin ||
		!target.pathname.startsWith(base.pathname)
	) {
		return null;
	}
	return target;
}

function shouldFallbackToEntry(request: Request, response: Response) {
	if (response.status !== 404) return false;
	if (!request.headers.get("accept")?.includes("text/html")) return false;
	const lastSegment = new URL(request.url).pathname.split("/").at(-1) ?? "";
	return !lastSegment.includes(".");
}

async function fetchAsset(
	request: Request,
	url: URL,
	fetcher: typeof fetch,
	options: { redirectsLeft?: number; allowedOrigins?: Set<string> } = {},
): Promise<Response> {
	const headers = new Headers();
	for (const name of FORWARDED_REQUEST_HEADERS) {
		const value = request.headers.get(name);
		if (value) headers.set(name, value);
	}
	const response = await fetcher(url, {
		method: request.method,
		headers,
		redirect: "manual",
	});
	if (response.status < 300 || response.status > 399) return response;
	const location = response.headers.get("location");
	const redirectsLeft = options.redirectsLeft ?? 3;
	if (!location || redirectsLeft <= 0)
		throw new Error("asset redirect limit exceeded");
	const next = new URL(location, url);
	const allowedOrigins = options.allowedOrigins ?? new Set([url.origin]);
	if (!allowedOrigins.has(next.origin))
		throw new Error("asset redirect origin denied");
	return fetchAsset(request, next, fetcher, {
		redirectsLeft: redirectsLeft - 1,
		allowedOrigins,
	});
}

function proxyResponse(upstream: Response, method: string) {
	const cacheable =
		(upstream.status >= 200 && upstream.status < 300) ||
		upstream.status === 304;
	const headers = new Headers({
		"Cache-Control": cacheable ? APP_CACHE_CONTROL : "no-store",
	});
	for (const name of FORWARDED_RESPONSE_HEADERS) {
		const value = upstream.headers.get(name);
		if (value) headers.set(name, value);
	}
	return new Response(method === "HEAD" ? null : upstream.body, {
		status: upstream.status,
		statusText: upstream.statusText,
		headers,
	});
}

export function isDocumentRequest(request: Request, url: URL) {
	if (request.method !== "GET") return false;
	if (!request.headers.get("accept")?.includes("text/html")) return false;
	if (url.pathname === "/" || url.pathname === "/index.html") return true;
	const lastSegment = url.pathname.split("/").at(-1) ?? "";
	return !lastSegment.includes(".");
}

const notFound = (body: string) =>
	new Response(body, {
		status: 404,
		headers: { "Cache-Control": "no-store" },
	});

export function methodNotAllowed() {
	return new Response("Method not allowed", {
		status: 405,
		headers: { Allow: "GET, HEAD", "Cache-Control": "no-store" },
	});
}

export function detailFailureResponse(
	result: Exclude<StandaloneDetailResult, { status: "ok" }>,
) {
	if (result.status === "not_found") return notFound("App not found");
	return new Response("App metadata unavailable", {
		status: 502,
		headers: { "Cache-Control": "no-store" },
	});
}

export async function serveStandaloneApp(input: {
	request: Request;
	url: URL;
	apiOrigin: string;
	fetcher: typeof fetch;
	waitUntil: WaitUntil;
}): Promise<Response> {
	if (input.request.method !== "GET" && input.request.method !== "HEAD") {
		return methodNotAllowed();
	}
	const detailResult = await loadStandaloneAppDetail({
		apiOrigin: input.apiOrigin,
		origin: input.url.origin,
		fetcher: input.fetcher,
		waitUntil: input.waitUntil,
		recordView: isDocumentRequest(input.request, input.url),
	});
	if (detailResult.status !== "ok") return detailFailureResponse(detailResult);
	const content = detailResult.detail.content;
	if (content?.kind !== "web") return notFound("App not found");
	return serveWebContent({ ...input, content });
}

export async function serveWebContent(input: {
	request: Request;
	url: URL;
	content: Extract<AppDetailResponse["content"], { kind: "web" }>;
	fetcher: typeof fetch;
}): Promise<Response> {
	const { content } = input;
	const assetUrl = resolveStandaloneAssetUrl(content, input.url.pathname);
	if (!assetUrl) return notFound("File not found");

	try {
		let upstream = await fetchAsset(input.request, assetUrl, input.fetcher);
		if (
			content.targetType === "directory" &&
			assetUrl.href !== content.url &&
			shouldFallbackToEntry(input.request, upstream)
		) {
			upstream = await fetchAsset(
				input.request,
				new URL(content.url),
				input.fetcher,
			);
		}
		return proxyResponse(upstream, input.request.method);
	} catch {
		return new Response("App asset unavailable", {
			status: 502,
			headers: { "Cache-Control": "no-store" },
		});
	}
}
