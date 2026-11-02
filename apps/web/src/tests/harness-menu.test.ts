import assert from "node:assert/strict";
import { test } from "node:test";
import {
	approvalMenuOptions,
	harnessMenuKey,
	movedIndex,
} from "../lib/components/composer/harness-menu.ts";

test("the approval submenu lists every mode and disables those the Runtime does not offer", () => {
	assert.deepEqual(
		approvalMenuOptions(["inherit", "full_access"], "full_access").map(
			({ mode, checked, disabled }) => [mode, checked, disabled],
		),
		[
			["inherit", false, false],
			["auto", false, true],
			["full_access", true, false],
			["read_only", false, true],
		],
	);
	assert.equal(approvalMenuOptions([], "inherit")[0]?.disabled, false);
});

test("the keyboard opens the submenu from its row and backs out one level at a time", () => {
	const path = (steps: [string, Parameters<typeof harnessMenuKey>[1]][]) =>
		steps.map(([key, at]) => harnessMenuKey(key, at));
	assert.deepEqual(
		path([
			["ArrowRight", "submenu-row"],
			["ArrowDown", "submenu"],
			["ArrowLeft", "submenu"],
			["ArrowRight", "submenu-row"],
			["Escape", "submenu"],
			["Escape", "submenu-row"],
		]),
		["open-submenu", "move", "back", "open-submenu", "back", "close"],
	);
	assert.deepEqual(
		path([
			["ArrowRight", "menu"],
			["ArrowLeft", "menu"],
			["Tab", "submenu"],
			["Tab", "menu"],
		]),
		[null, null, "dismiss", "dismiss"],
	);
	assert.deepEqual(
		[
			movedIndex("ArrowDown", 3, 4),
			movedIndex("ArrowUp", 0, 4),
			movedIndex("ArrowUp", -1, 4),
			movedIndex("Home", 2, 4),
		],
		[0, 3, 3, 0],
	);
});
