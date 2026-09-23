import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { serveStandaloneHostRequest } from "$lib/server/standalone-host-request";

const TEMPLATE = "{id}-dev.netaverses.cc";
const APP_ID = "3f6f0f1e-1111-4222-8333-444455556666";
const API_ORIGIN = "https://api-dev.cohub.live";
const APP_HOST = `${APP_ID}-dev.netaverses.cc`;

function call(
	hostname: string,
	path: string,
	template: string | null = TEMPLATE,
	fetcher?: typeof fetch,
) {
	const url = new URL(`https://${hostname}${path}`);
	return serveStandaloneHostRequest({
		request: new Request(url),
		url,
		template,
		apiOrigin: API_ORIGIN,
		fetcher:
			fetcher ?? (async () => new Response("App not found", { status: 404 })),
	});
}

describe("standalone host requests", () => {
	it("stays disabled when no template is configured", () => {
		assert.equal(call(APP_HOST, "/", null), null);
		assert.equal(call(APP_HOST, "/", ""), null);
	});

	it("ignores hosts outside the configured template", () => {
		for (const hostname of [
			"dev.cohub.live",
			"foo.netaverses.cc",
			`${APP_ID}.netaverses.cc`,
		]) {
			assert.equal(call(hostname, "/"), null, hostname);
		}
	});

	it("normalizes deployment configuration before matching", () => {
		for (const template of [
			"  {id}-Dev.Netaverses.CC  ",
			"{id}-dev.netaverses.cc",
		]) {
			assert.ok(call(APP_HOST, "/", template), template);
		}
	});

	it("rejects malformed templates instead of matching loosely", () => {
		for (const template of ["{id}{id}.netaverses.cc", "{id}.", "-dev.cc"]) {
			assert.equal(call(APP_HOST, "/", template), null, template);
		}
	});

	it("resolves every path on a managed host, including prerendered ones", async () => {
		for (const path of [
			"/",
			"/index.html",
			"/docs",
			"/pricing",
			"/assets/app.js",
		]) {
			const requested: string[] = [];
			const fetcher: typeof fetch = async (input) => {
				requested.push(String(input));
				return new Response("App not found", { status: 404 });
			};
			const response = await call(APP_HOST, path, TEMPLATE, fetcher);
			assert.ok(response, path);
			assert.equal(response.status, 404, path);
			assert.deepEqual(
				requested,
				[
					`${API_ORIGIN}/api/apps/by-origin?origin=${encodeURIComponent(`https://${APP_HOST}`)}`,
				],
				path,
			);
		}
	});
});
