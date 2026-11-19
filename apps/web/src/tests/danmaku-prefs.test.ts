import assert from "node:assert/strict";
import { test } from "node:test";
import {
	isSpaceDanmakuEnabled,
	setDanmakuDefault,
	setSpaceDanmakuEnabled,
} from "../lib/danmaku-prefs.ts";

test("Space switches override the default until toggled back to it", (t) => {
	const values = new Map([
		["cohub:space-danmaku:v1", '{"enabled":false,"version":1}'],
	]);
	const original = Object.getOwnPropertyDescriptor(globalThis, "window");
	Object.defineProperty(globalThis, "window", {
		configurable: true,
		value: {
			localStorage: {
				getItem: (key: string) => values.get(key) ?? null,
				setItem: (key: string, value: string) => values.set(key, value),
				removeItem: (key: string) => values.delete(key),
			},
		},
	});
	t.after(() => {
		if (original) Object.defineProperty(globalThis, "window", original);
		else Reflect.deleteProperty(globalThis, "window");
	});

	assert.equal(isSpaceDanmakuEnabled("alice", "team"), false);
	setSpaceDanmakuEnabled("alice", "team", true);
	assert.equal(isSpaceDanmakuEnabled("alice", "team"), true);
	assert.equal(isSpaceDanmakuEnabled("alice", "other"), false);
	assert.equal(isSpaceDanmakuEnabled("bob", "team"), false);

	setSpaceDanmakuEnabled("alice", "team", false);
	setDanmakuDefault("alice", true);
	assert.equal(isSpaceDanmakuEnabled("alice", "team"), true);
});
