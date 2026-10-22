import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { serveStandaloneHostRequest } from "$lib/server/standalone-host-request";

const API_ORIGIN = "https://api.cohub.live";
const UPSTREAM =
	"https://s-550e8400-e29b-41d4-a716-446655440000-3000.cohub.live";
let hostCounter = 0;

function portDetail(url = UPSTREAM) {
	return {
		app: { id: "app-1", visibility: "public" },
		space: { id: "space-1" },
		content: { kind: "port", url, targetType: "port", port: "3000" },
	};
}

function serve(
	host: string,
	path: string,
	fetcher: typeof fetch,
	init?: RequestInit,
) {
	const url = new URL(`https://${host}${path}`);
	return serveStandaloneHostRequest({
		request: new Request(url, init),
		url,
		template: null,
		siteHostSuffixes: "cohub.live, cohub.run",
		cohubEnv: "prod",
		apiOrigin: API_ORIGIN,
		fetcher,
		waitUntil: () => {},
	});
}

/** A fresh hostname per test keeps the isolate-level detail cache out of the way. */
const nextHost = () => `app${++hostCounter}.example.com`;

describe("custom domain hosts", () => {
	it("answers unbound hosts with 404 and remembers the miss", async () => {
		const host = nextHost();
		let lookups = 0;
		const fetcher: typeof fetch = async () => {
			lookups += 1;
			return new Response("{}", { status: 404 });
		};
		assert.equal((await serve(host, "/pricing", fetcher))?.status, 404);
		assert.equal((await serve(host, "/", fetcher))?.status, 404);
		assert.equal(lookups, 1);
	});

	it("refuses to proxy to anything but this deployment's sandbox hosts", async () => {
		for (const upstream of [
			"https://api.cohub.live",
			"https://d-550e8400-e29b-41d4-a716-446655440000-3000.cohub.live",
			"https://s-550e8400-e29b-41d4-a716-446655440000-3000.evil.com",
			"https://s-550e8400-e29b-41d4-a716-446655440000-22.cohub.live",
		]) {
			const fetcher: typeof fetch = async () =>
				Response.json(portDetail(upstream));
			const response = await serve(nextHost(), "/", fetcher);
			assert.equal(response?.status, 502, upstream);
		}
	});

	it("proxies port Apps with trusted forwarding headers and host-only cookies", async () => {
		const host = nextHost();
		let forwarded: Request | null = null;
		const fetcher: typeof fetch = async (input, init) => {
			if (String(input).startsWith(API_ORIGIN))
				return Response.json(portDetail());
			forwarded = new Request(input, init);
			const headers = new Headers({ Location: `${UPSTREAM}/done?x=1` });
			headers.append(
				"Set-Cookie",
				"sid=1; Domain=example.com; Path=/; HttpOnly",
			);
			return new Response(null, { status: 302, headers });
		};
		const response = await serve(host, "/login?next=%2F", fetcher, {
			method: "POST",
			body: "a=1",
			headers: {
				"CF-Connecting-IP": "203.0.113.7",
				"X-Forwarded-For": "1.1.1.1",
				"X-Cohub-Client-IP": "1.1.1.1",
				Cookie: "sid=old",
			},
		});
		assert.ok(forwarded);
		const sent = forwarded as Request;
		assert.equal(sent.url, `${UPSTREAM}/login?next=%2F`);
		assert.equal(sent.method, "POST");
		assert.equal(await sent.text(), "a=1");
		assert.equal(sent.headers.get("x-real-ip"), "203.0.113.7");
		assert.equal(sent.headers.get("x-forwarded-for"), "203.0.113.7");
		assert.equal(sent.headers.get("x-forwarded-host"), host);
		assert.equal(sent.headers.get("x-cohub-client-ip"), null);
		assert.equal(sent.headers.get("cookie"), "sid=old");
		assert.equal(response?.status, 302);
		assert.equal(response?.headers.get("location"), `https://${host}/done?x=1`);
		assert.equal(
			response?.headers.get("set-cookie"),
			"sid=1; Path=/; HttpOnly",
		);
	});

	it("rejects oversized bodies before reaching the App", async () => {
		let proxied = false;
		const fetcher: typeof fetch = async (input) => {
			if (String(input).startsWith(API_ORIGIN))
				return Response.json(portDetail());
			proxied = true;
			return new Response("ok");
		};
		const response = await serve(nextHost(), "/upload", fetcher, {
			method: "POST",
			body: "x",
			headers: { "Content-Length": String(31 * 1024 * 1024) },
		});
		assert.equal(response?.status, 413);
		assert.equal(proxied, false);
	});
});
