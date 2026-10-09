import assert from "node:assert/strict";
import { test } from "node:test";
import type { AppMeta } from "@neta-art/cohub";
import { appDisplayTitle, appIconUrl } from "$lib/app-page-meta";

test("appIconUrl keeps absolute and inline icons", () => {
	assert.equal(
		appIconUrl({ icon: "https://cdn.example/favicon.svg" } as AppMeta),
		"https://cdn.example/favicon.svg",
	);
	assert.equal(
		appIconUrl({
			icon: "data:image/svg+xml,%3Csvg%3E%3C/svg%3E",
		} as AppMeta),
		"data:image/svg+xml,%3Csvg%3E%3C/svg%3E",
	);
});

test("appIconUrl leaves weak refs unresolved without a content URL", () => {
	// A bare `/favicon.svg` from an older publish cannot be trusted without the
	// published package URL, so the row falls back to a generated tile.
	assert.equal(appIconUrl({ icon: "/favicon.svg" } as AppMeta), null);
	assert.equal(appIconUrl({ icon: "favicon.ico" } as AppMeta), null);
	assert.equal(appIconUrl({} as AppMeta), null);
	assert.equal(appIconUrl(null), null);
});

test("appIconUrl resolves relative refs against the content URL", () => {
	assert.equal(
		appIconUrl(
			{ icon: "/favicon.svg" } as AppMeta,
			"https://cdn.example/site/demo/index.html",
		),
		"https://cdn.example/site/demo/favicon.svg",
	);
});

test("appDisplayTitle prefers title, then legacy name, then fallback", () => {
	assert.equal(appDisplayTitle({ title: "Board" } as AppMeta, "slug"), "Board");
	assert.equal(
		appDisplayTitle({ name: "Legacy" } as AppMeta, "slug"),
		"Legacy",
	);
	assert.equal(appDisplayTitle({} as AppMeta, "slug"), "slug");
	assert.equal(appDisplayTitle(null, "slug"), "slug");
});
