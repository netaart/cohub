import assert from "node:assert/strict";
import { test } from "node:test";
import {
	appWindowKey,
	parseAppWindowKey,
} from "../lib/features/space/modules/app-window-key.ts";
import {
	isValidAppKey,
	parseWindowParam,
} from "../lib/features/space/modules/window-route.ts";

const APP = "11111111-1111-4111-8111-111111111111";

test("an App window is keyed by the App, or by the App and one file", () => {
	assert.equal(appWindowKey(APP), APP);
	assert.equal(appWindowKey(APP, "plans/a:b.board"), `${APP}:plans/a:b.board`);
	assert.deepEqual(parseAppWindowKey(APP), { appId: APP, path: null });
	assert.deepEqual(parseAppWindowKey(`${APP}:plans/a:b.board`), {
		appId: APP,
		path: "plans/a:b.board",
	});
	for (const key of [
		"not-an-id",
		`${APP}:`,
		`${APP}:/etc/passwd`,
		`${APP}:../a.board`,
		`${APP}:a/../../b`,
		`x${APP}`,
	]) {
		assert.equal(parseAppWindowKey(key), null, key);
		assert.equal(isValidAppKey(key), false, key);
	}
});

test("file windows deep-link like any other window", () => {
	assert.deepEqual(parseWindowParam(`app:${APP}:plans/a.board`), {
		kind: "app",
		key: `${APP}:plans/a.board`,
	});
	assert.equal(parseWindowParam("app:plans/a.board"), null);
});
