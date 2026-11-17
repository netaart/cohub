import assert from "node:assert/strict";
import { test } from "node:test";
import {
	buildAppIframeUrl,
	getAppFramePreconnectOrigin,
	resolveAppFrame,
} from "#lib/app-url.ts";

const BASE = "https://cohub.live/alice/demo/w/example";

test("buildAppIframeUrl preserves app params and replaces forwarded duplicates", () => {
	const result = buildAppIframeUrl(
		"https://works.cohub.live/apps/example/index.html?theme=old&keep=yes",
		{ search: "?theme=new&mode=compact&cohub_campaign=test", hash: "#view" },
	);

	assert.equal(
		result,
		"https://works.cohub.live/apps/example/index.html?keep=yes&theme=new&mode=compact#view",
	);
});

test("resolveAppFrame returns the canonical URL and validated origin", () => {
	assert.deepEqual(
		resolveAppFrame({
			contentUrl: "https://works.cohub.live/apps/example/index.html",
			launchState: { search: "?mode=compact", hash: "" },
			baseHref: BASE,
			targetType: "file",
		}),
		{
			url: "https://works.cohub.live/apps/example/index.html?mode=compact",
			origin: "https://works.cohub.live",
		},
	);
});

test("resolveAppFrame rejects invalid port origins", () => {
	assert.equal(
		resolveAppFrame({
			contentUrl: "https://example.com/app/",
			baseHref: BASE,
			targetType: "port",
		}),
		null,
	);
});

test("preconnect is only emitted for a cross-origin embedded frame", () => {
	assert.equal(
		getAppFramePreconnectOrigin({
			contentUrl: "https://works.cohub.live/apps/example/index.html",
			baseHref: BASE,
			targetType: "file",
		}),
		"https://works.cohub.live",
	);
	assert.equal(
		getAppFramePreconnectOrigin({
			contentUrl: BASE,
			baseHref: BASE,
			targetType: "file",
		}),
		null,
	);
});
