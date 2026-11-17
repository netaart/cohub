import assert from "node:assert/strict";
import { test } from "node:test";
import {
	isSpaceSessionDetailPath,
	isSpaceSessionLandingPath,
	matchMobileSessionNavTransition,
} from "#lib/navigation-transition.ts";

test("the Space root is a mobile session landing path", () => {
	assert.equal(isSpaceSessionLandingPath("/spaces/space-id"), true);
	assert.equal(isSpaceSessionLandingPath("/spaces/space-id/"), true);
	assert.equal(isSpaceSessionLandingPath("/spaces/new"), false);
	assert.equal(isSpaceSessionLandingPath("/spaces/space-id/settings"), false);
});

test("the Space root participates in list-to-chat transitions", () => {
	assert.equal(
		matchMobileSessionNavTransition("/sessions", "/spaces/space-id"),
		"session-forward",
	);
	assert.equal(
		matchMobileSessionNavTransition("/spaces/space-id", "/sessions"),
		"session-back",
	);
	assert.equal(
		matchMobileSessionNavTransition(
			"/sessions",
			"/spaces/space-id/sessions/123",
		),
		"session-forward",
	);
});

test("session detail matching still excludes the new landing", () => {
	assert.equal(isSpaceSessionDetailPath("/spaces/space-id/sessions/123"), true);
	assert.equal(
		isSpaceSessionDetailPath("/spaces/space-id/sessions/new"),
		false,
	);
	assert.equal(isSpaceSessionDetailPath("/spaces/space-id"), false);
});
