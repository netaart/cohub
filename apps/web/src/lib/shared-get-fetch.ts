const SHAREABLE_INIT_KEYS = new Set([
	"method",
	"headers",
	"credentials",
	"mode",
	"cache",
]);

function shareKey(input: RequestInfo | URL, init?: RequestInit) {
	if (typeof input !== "string" && !(input instanceof URL)) return null;
	const options: RequestInit = init ?? {};
	for (const [name, value] of Object.entries(options)) {
		if (value !== undefined && !SHAREABLE_INIT_KEYS.has(name)) return null;
	}
	if ((options.method ?? "GET").toUpperCase() !== "GET") return null;
	const headers = new Headers(options.headers);
	if (headers.get("accept")?.includes("text/event-stream")) return null;
	const headerLines = Array.from(
		headers,
		([name, value]) => `${name}:${value}`,
	);
	return [
		String(input),
		options.credentials ?? "",
		options.mode ?? "",
		options.cache ?? "",
		...headerLines,
	].join("\n");
}

type SharedRequest = {
	response: Promise<Response>;
	followers: Array<(response: Response) => void>;
};

/**
 * Identical GETs issued in the same task share one request. Sharing ends at the
 * next task so a later request never joins one that may predate a change.
 */
export function createSharedGetFetch(fetcher: typeof fetch): typeof fetch {
	const inFlight = new Map<string, SharedRequest>();
	return (input, init) => {
		const key = shareKey(input, init);
		if (key === null) return fetcher(input, init);
		const shared = inFlight.get(key);
		if (shared) {
			return new Promise((resolve, reject) => {
				shared.followers.push(resolve);
				shared.response.catch(reject);
			});
		}
		const followers: SharedRequest["followers"] = [];
		const response = fetcher(input, init).then((original) => {
			if (inFlight.get(key)?.response === response) inFlight.delete(key);
			for (const follow of followers) follow(original.clone());
			return original;
		});
		inFlight.set(key, { response, followers });
		setTimeout(() => {
			if (inFlight.get(key)?.response === response) inFlight.delete(key);
		}, 0);
		return response;
	};
}
