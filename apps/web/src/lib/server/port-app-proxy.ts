/** Default cap for a proxied request body; uploads are streamed, never buffered. */
export const PORT_APP_MAX_BODY_BYTES = 30 * 1024 * 1024;

const HOP_BY_HOP_HEADERS = new Set([
	"connection",
	"keep-alive",
	"proxy-authenticate",
	"proxy-authorization",
	"proxy-connection",
	"te",
	"trailer",
	"transfer-encoding",
	"upgrade",
]);
const UNTRUSTED_REQUEST_HEADERS = new Set(["host", "x-real-ip", "forwarded"]);
const UNTRUSTED_REQUEST_PREFIXES = ["x-forwarded-", "x-cohub-", "cf-"];

function textResponse(status: number, body: string) {
	return new Response(body, {
		status,
		headers: {
			"Content-Type": "text/plain; charset=utf-8",
			"Cache-Control": "no-store",
		},
	});
}

function forwardedRequestHeaders(
	request: Request,
	url: URL,
	websocket: boolean,
) {
	const headers = new Headers();
	for (const [name, value] of request.headers) {
		if (HOP_BY_HOP_HEADERS.has(name) || UNTRUSTED_REQUEST_HEADERS.has(name))
			continue;
		if (UNTRUSTED_REQUEST_PREFIXES.some((prefix) => name.startsWith(prefix)))
			continue;
		headers.set(name, value);
	}
	if (websocket) {
		headers.set("upgrade", "websocket");
		headers.set("connection", "Upgrade");
	}
	// Same-zone subrequests surface X-Real-IP to the origin as CF-Connecting-IP.
	const clientIp = request.headers.get("cf-connecting-ip");
	if (clientIp) {
		headers.set("x-real-ip", clientIp);
		headers.set("x-forwarded-for", clientIp);
	}
	headers.set("x-forwarded-host", url.host);
	headers.set("x-forwarded-proto", "https");
	return headers;
}

/** Streams the body through, failing once more than `limit` bytes arrive. */
function limitBody(body: ReadableStream<Uint8Array>, limit: number) {
	let received = 0;
	const stream = body.pipeThrough(
		new TransformStream<Uint8Array, Uint8Array>({
			transform(chunk, controller) {
				received += chunk.byteLength;
				if (received > limit) controller.error(new Error("body too large"));
				else controller.enqueue(chunk);
			},
		}),
	);
	return { stream, exceeded: () => received > limit };
}

/** Drops `Domain=` so every server-set cookie stays on the custom host. */
export function hostOnlyCookie(value: string) {
	return value
		.split(";")
		.filter((part) => !/^\s*domain\s*=/i.test(part))
		.join(";");
}

/** Only absolute redirects back to the sandbox host need the public origin. */
function rewriteLocation(
	location: string,
	upstream: URL,
	publicOrigin: string,
) {
	if (!/^(?:[a-z][a-z0-9+.-]*:)?\/\//i.test(location)) return location;
	try {
		const target = new URL(location, upstream);
		if (target.origin !== upstream.origin) return location;
		return `${publicOrigin}${target.pathname}${target.search}${target.hash}`;
	} catch {
		return location;
	}
}

function offlineResponse() {
	return textResponse(502, "App is offline");
}

/**
 * Reverse-proxies a request on a custom domain to the port App's sandbox host.
 * Nothing is cached at the edge: the App owns authorization for every request.
 */
export async function proxyPortApp(input: {
	request: Request;
	url: URL;
	upstream: string;
	fetcher: typeof fetch;
	maxBodyBytes?: number;
}): Promise<Response> {
	const { request, url } = input;
	const upstreamBase = new URL(input.upstream);
	// Assign components rather than resolving the path: `//evil.example/x`
	// would otherwise resolve to another host.
	const target = new URL(upstreamBase.origin);
	target.pathname = url.pathname;
	target.search = url.search;
	if (target.origin !== upstreamBase.origin)
		return textResponse(400, "Bad request");
	const websocket =
		request.headers.get("upgrade")?.toLowerCase() === "websocket";
	const limit = input.maxBodyBytes ?? PORT_APP_MAX_BODY_BYTES;

	let body: ReadableStream<Uint8Array> | null = null;
	let exceeded = () => false;
	if (request.body && request.method !== "GET" && request.method !== "HEAD") {
		const declared = request.headers.get("content-length");
		if (declared !== null && Number(declared) > limit) {
			return textResponse(413, "Request body too large");
		}
		if (declared !== null) body = request.body;
		else ({ stream: body, exceeded } = limitBody(request.body, limit));
	}

	let upstream: Response;
	try {
		upstream = await input.fetcher(target, {
			method: request.method,
			headers: forwardedRequestHeaders(request, url, websocket),
			body,
			redirect: "manual",
			// Never read or fill the zone cache: a private response must not
			// be replayed to another visitor.
			cache: "no-store",
			// Required by Node's fetch for streamed bodies; ignored by Workers.
			...({ duplex: "half" } as RequestInit),
		});
	} catch {
		if (exceeded()) return textResponse(413, "Request body too large");
		return offlineResponse();
	}

	if (upstream.status === 101) return upstream;
	// 52x are Cloudflare's own "origin unreachable" answers, not the App's.
	if (upstream.status >= 520 && upstream.status <= 526)
		return offlineResponse();

	const headers = new Headers();
	for (const [name, value] of upstream.headers) {
		if (name === "set-cookie" || HOP_BY_HOP_HEADERS.has(name)) continue;
		headers.set(
			name,
			name === "location"
				? rewriteLocation(value, upstreamBase, url.origin)
				: value,
		);
	}
	for (const cookie of upstream.headers.getSetCookie())
		headers.append("set-cookie", hostOnlyCookie(cookie));

	return new Response(request.method === "HEAD" ? null : upstream.body, {
		status: upstream.status,
		statusText: upstream.statusText,
		headers,
	});
}
