import assert from "node:assert/strict";
import { test } from "node:test";
import type { AppMeta } from "@neta-art/cohub";
import {
	appDisplayTitle,
	appIconUrl,
	publicBoardPoster,
} from "#lib/app-page-meta.ts";

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

test("publicBoardPoster uses only the author cover of a public Board", () => {
	const content = {
		kind: "board" as const,
		url: "https://cdn.example/a/v2/board.json",
	};
	const app = (meta: AppMeta, visibility: "public" | "space" = "public") => ({
		id: "app_1",
		meta,
		visibility,
	});
	assert.deepEqual(
		publicBoardPoster({ app: app({ image: "cover.png" } as AppMeta), content }),
		{
			key: "app_1:https://cdn.example/a/v2/board.json",
			imageUrl: "https://cdn.example/a/v2/cover.png",
		},
	);
	assert.equal(
		publicBoardPoster({
			app: app({ icon: "https://cdn.example/icon.png" } as AppMeta),
			content,
		})?.imageUrl,
		null,
	);
	assert.equal(
		publicBoardPoster({
			app: app({ image: "https://cdn.example/c.png" } as AppMeta, "space"),
			content,
		}),
		null,
	);
	assert.equal(
		publicBoardPoster({
			app: app({} as AppMeta),
			content: { kind: "web", url: "https://cdn.example/index.html" },
		}),
		null,
	);
});
