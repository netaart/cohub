import assert from "node:assert/strict";
import { test } from "node:test";
import {
	isRootSelector,
	scopeSelectorList,
} from "$lib/custom-theme/island-selectors";

test("theme island selectors target the island root", () => {
	assert.equal(
		scopeSelectorList(
			':root, html[data-theme="dark"] body .x, .html-x, [title=":root"]',
		),
		':scope, :scope[data-theme="dark"] .x, .html-x, [title=":root"]',
	);
	assert.ok(isRootSelector(':scope[data-theme="dark"]'));
	assert.ok(!isRootSelector(":scope .x"));
});
