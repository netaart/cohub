import assert from "node:assert/strict";
import { test } from "node:test";
import { buildFileIngressMainRoute } from "#lib/features/space/modules/window-route.ts";
import {
	buildSpaceLandingRoute,
	buildSpaceNewSessionRoute,
	buildSpaceRootRoute,
} from "#lib/space-routes.ts";
import { load as loadSpaceRoot } from "../routes/(app)/spaces/[id]/+page.ts";
import { load as loadLegacyNewSession } from "../routes/(app)/spaces/[id]/sessions/new/+page.ts";

test("the Space root is the canonical new-session route", () => {
	const expected = "/spaces/space-id";
	assert.equal(buildSpaceRootRoute("space-id"), expected);
	assert.equal(buildSpaceLandingRoute("space-id"), expected);
	assert.equal(buildSpaceNewSessionRoute("space-id"), expected);
});

test("the Space root loads a new session and legacy route redirects", async () => {
	const input = {
		params: { id: "space-id" },
		url: new URL(
			"https://cohub.test/spaces/space-id?window=file%3Adocs%2Fa.md",
		),
	};
	// The route implementations only read params and url; avoid a broad framework mock.
	const data = (await Promise.resolve(loadSpaceRoot(input as never))) as {
		view: string;
		sessionId: string;
		windowKind: string | null;
		windowKey: string | null;
	};

	assert.equal(data.view, "session");
	assert.equal(data.sessionId, "new");
	assert.equal(data.windowKind, "file");
	assert.equal(data.windowKey, "docs/a.md");

	assert.throws(
		() => loadLegacyNewSession(input as never),
		(error: unknown) => {
			if (!error || typeof error !== "object") return false;
			const redirect = error as {
				status?: number;
				location?: string;
			};
			assert.equal(redirect.status, 307);
			assert.equal(
				redirect.location,
				"/spaces/space-id?window=file%3Adocs%2Fa.md",
			);
			return true;
		},
	);
});

test("file ingress opens a window on the Space root", () => {
	const route = buildFileIngressMainRoute("space-id", "docs/read me.md");
	const url = new URL(route, "https://cohub.test");

	assert.equal(url.pathname, "/spaces/space-id");
	assert.equal(url.searchParams.get("window"), "file:docs/read me.md");
});
