import assert from "node:assert/strict";
import { test } from "node:test";
import { stale } from "../../scripts/board-themes.ts";

test("the SDK's built-in Board themes match the theme stylesheets", () => {
	assert.equal(stale(), false, "run pnpm --filter web generate:board-themes");
});
