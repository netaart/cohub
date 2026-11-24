import assert from "node:assert/strict";
import { test } from "node:test";
import { withEdgeCache } from "../lib/server/edge-cache.ts";

test("Android App Links reads the current deployment even with a cached response", async (t) => {
	const original = Object.getOwnPropertyDescriptor(globalThis, "caches");
	Object.defineProperty(globalThis, "caches", {
		configurable: true,
		value: { open: async () => ({ match: async () => new Response("stale") }) },
	});
	t.after(() => {
		if (original) Object.defineProperty(globalThis, "caches", original);
		else Reflect.deleteProperty(globalThis, "caches");
	});

	const current = new Response("current", {
		headers: { "cache-control": "public, max-age=3600" },
	});
	const result = await withEdgeCache(
		new Request("https://cohub.live/.well-known/assetlinks.json"),
		() => assert.fail("The association response must not be cached"),
		async () => current,
	);
	assert.equal(result, current);
});
