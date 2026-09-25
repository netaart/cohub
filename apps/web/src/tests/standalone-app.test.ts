import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AppDetailResponse } from "@neta-art/cohub";
import {
	resolveStandaloneAssetUrl,
	serveStandaloneApp,
} from "$lib/server/standalone-app";

const content = {
	kind: "web",
	url: "https://assets.cohub.live/apps/one/content/index.html",
	targetType: "directory",
	path: "dist",
} as const;

const detail = {
	app: {
		id: "550e8400-e29b-41d4-a716-446655440000",
		visibility: "public",
	},
	space: { id: "space-1" },
	content,
} as unknown as AppDetailResponse;

const API_ORIGIN = "https://api.cohub.live";

/** Serves `url`, collecting the work the server schedules after responding. */
function serve(
	url: URL,
	fetcher: typeof fetch,
	init?: RequestInit,
	deferred: Promise<unknown>[] = [],
) {
	return serveStandaloneApp({
		request: new Request(url, init),
		url,
		apiOrigin: API_ORIGIN,
		fetcher,
		waitUntil: (promise) => deferred.push(promise),
	});
}

const htmlNavigation = { headers: { Accept: "text/html" } };

describe("standalone App serving", () => {
	it("maps directory paths into the immutable published asset root", () => {
		assert.equal(
			resolveStandaloneAssetUrl(content, "/assets/app.js")?.href,
			"https://assets.cohub.live/apps/one/content/assets/app.js",
		);
		assert.equal(resolveStandaloneAssetUrl(content, "/../secret"), null);
		assert.equal(resolveStandaloneAssetUrl(content, "/%2fsecret"), null);
	});

	it("limits file Apps to their entry document", () => {
		const file = { ...content, targetType: "file" as const };
		assert.equal(resolveStandaloneAssetUrl(file, "/")?.href, file.url);
		assert.equal(resolveStandaloneAssetUrl(file, "/assets/app.js"), null);
	});

	it("resolves by origin and streams directory assets", async () => {
		const calls: string[] = [];
		const fetcher: typeof fetch = async (input) => {
			const url = String(input);
			calls.push(url);
			if (url.startsWith("https://api.cohub.live/api/apps/by-origin")) {
				return Response.json(detail);
			}
			return new Response("console.log('ok')", {
				headers: { "Content-Type": "text/javascript", ETag: "asset-1" },
			});
		};
		const url = new URL(
			"https://550e8400-e29b-41d4-a716-446655440000.apps.cohub.live/assets/app.js",
		);
		const response = await serve(url, fetcher);

		assert.equal(response.status, 200);
		assert.equal(await response.text(), "console.log('ok')");
		assert.equal(response.headers.get("etag"), "asset-1");
		assert.match(calls[0] ?? "", /by-origin\?origin=https%3A%2F%2F/);
		assert.equal(
			calls[1],
			"https://assets.cohub.live/apps/one/content/assets/app.js",
		);
		const secondResponse = await serve(url, fetcher);
		assert.equal(secondResponse.status, 200);
		assert.equal(
			calls.filter((call) => call.includes("/api/apps/by-origin")).length,
			1,
		);
	});

	it("returns an uncached 502 when the App resolver is unavailable", async () => {
		const fetcher: typeof fetch = async () =>
			new Response("upstream failed", { status: 503 });
		const url = new URL(
			"https://850e8400-e29b-41d4-a716-446655440000.apps.cohub.live/",
		);
		const response = await serve(url, fetcher);
		assert.equal(response.status, 502);
		assert.equal(response.headers.get("cache-control"), "no-store");
		assert.match(await response.text(), /App metadata unavailable/);
	});

	it("does not cache upstream errors", async () => {
		const fetcher: typeof fetch = async (input) =>
			String(input).includes("/api/apps/by-origin")
				? Response.json(detail)
				: new Response("missing", { status: 404 });
		const url = new URL(
			"https://650e8400-e29b-41d4-a716-446655440000.apps.cohub.live/missing.js",
		);
		const response = await serve(url, fetcher);
		assert.equal(response.status, 404);
		assert.equal(response.headers.get("cache-control"), "no-store");
	});

	it("rejects cross-origin asset redirects", async () => {
		const fetcher: typeof fetch = async (input) => {
			if (String(input).includes("/api/apps/by-origin"))
				return Response.json(detail);
			return new Response(null, {
				status: 302,
				headers: { Location: "https://evil.example/app.js" },
			});
		};
		const url = new URL(
			"https://950e8400-e29b-41d4-a716-446655440000.apps.cohub.live/assets/app.js",
		);
		const response = await serve(url, fetcher);
		assert.equal(response.status, 502);
		assert.equal(response.headers.get("cache-control"), "no-store");
	});

	it("returns an uncached 502 when the asset origin is unavailable", async () => {
		const fetcher: typeof fetch = async (input) => {
			if (String(input).includes("/api/apps/by-origin"))
				return Response.json(detail);
			throw new Error("offline");
		};
		const url = new URL(
			"https://750e8400-e29b-41d4-a716-446655440000.apps.cohub.live/assets/app.js",
		);
		const response = await serve(url, fetcher);
		assert.equal(response.status, 502);
		assert.equal(response.headers.get("cache-control"), "no-store");
		assert.match(await response.text(), /App asset unavailable/);
	});

	it("records one view for an HTML navigation and falls back to the entry document", async () => {
		let assetRequests = 0;
		let originRequest = "";
		const fetcher: typeof fetch = async (input) => {
			const url = String(input);
			if (url.includes("/api/apps/by-origin")) {
				originRequest = url;
				return Response.json(detail);
			}
			assetRequests++;
			return assetRequests === 1
				? new Response("missing", { status: 404 })
				: new Response("<main>App</main>", {
						headers: { "Content-Type": "text/html" },
					});
		};
		const url = new URL(
			"https://550e8400-e29b-41d4-a716-446655440000.apps.cohub.live/project/42",
		);
		const response = await serve(url, fetcher, htmlNavigation);

		assert.equal(response.status, 200);
		assert.equal(await response.text(), "<main>App</main>");
		assert.equal(assetRequests, 2);
		assert.match(originRequest, /[?&]view=1(?:&|$)/);
	});

	it("serves cached navigations without waiting for the view to be recorded", async () => {
		const originRequests: string[] = [];
		let releaseView = () => {};
		const fetcher: typeof fetch = async (input) => {
			const url = String(input);
			if (!url.includes("/api/apps/by-origin"))
				return new Response("<main>App</main>", {
					headers: { "Content-Type": "text/html" },
				});
			originRequests.push(url);
			if (url.includes("view=1") && originRequests.length > 1)
				await new Promise<void>((resolve) => {
					releaseView = resolve;
				});
			return Response.json(detail);
		};
		const url = new URL(
			"https://a50e8400-e29b-41d4-a716-446655440000.apps.cohub.live/",
		);

		// A cold navigation resolves and records the view in the same call.
		const cold: Promise<unknown>[] = [];
		await serve(url, fetcher, htmlNavigation, cold);
		assert.equal(cold.length, 0);
		assert.equal(originRequests.length, 1);

		// A warm one responds from cache while the view request is still pending.
		const warm: Promise<unknown>[] = [];
		const response = await serve(url, fetcher, htmlNavigation, warm);
		assert.equal(response.status, 200);
		assert.equal(await response.text(), "<main>App</main>");
		assert.equal(warm.length, 1);
		assert.equal(originRequests.length, 2);
		assert.match(originRequests[1] ?? "", /[?&]view=1(?:&|$)/);
		releaseView();
		await Promise.all(warm);

		// Sub-resources never record views.
		const asset: Promise<unknown>[] = [];
		await serve(new URL("/app.js", url), fetcher, undefined, asset);
		assert.equal(asset.length, 0);
		assert.equal(originRequests.length, 2);
	});

	it("stops serving an App once a background refresh finds it gone", async () => {
		let published = true;
		const fetcher: typeof fetch = async (input) => {
			if (!String(input).includes("/api/apps/by-origin"))
				return new Response("<main>App</main>");
			return published
				? Response.json(detail)
				: new Response("app origin not found", { status: 404 });
		};
		const url = new URL(
			"https://b50e8400-e29b-41d4-a716-446655440000.apps.cohub.live/",
		);
		await serve(url, fetcher, htmlNavigation);

		published = false;
		const deferred: Promise<unknown>[] = [];
		const stale = await serve(url, fetcher, htmlNavigation, deferred);
		assert.equal(stale.status, 200);
		await Promise.all(deferred);

		const gone = await serve(url, fetcher, htmlNavigation);
		assert.equal(gone.status, 404);
		assert.match(await gone.text(), /App not found/);
	});
});
