import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveMobileNavTab, shouldHideMobileTabBar } from "$lib/mobile-nav";

test("mobile navigation follows global routes and yields immersive surfaces", () => {
	assert.equal(resolveMobileNavTab("/sessions/abc"), "chats");
	assert.equal(resolveMobileNavTab("/spaces"), "spaces");
	assert.equal(
		resolveMobileNavTab("/spaces/space-id/sessions/session-id"),
		"spaces",
	);
	assert.equal(resolveMobileNavTab("/settings/billing"), "account");

	assert.equal(shouldHideMobileTabBar("/spaces/new"), true);
	assert.equal(
		shouldHideMobileTabBar("/spaces/space-id/sessions/session-id"),
		true,
	);
	assert.equal(shouldHideMobileTabBar("/spaces/space-id/files/a.md"), true);
	assert.equal(shouldHideMobileTabBar("/spaces"), false);
	assert.equal(shouldHideMobileTabBar("/spaces/space-id/settings"), false);
	assert.equal(shouldHideMobileTabBar("/settings/billing"), false);
});
