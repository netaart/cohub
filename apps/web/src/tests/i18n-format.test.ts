import assert from "node:assert/strict";
import { test } from "node:test";
import { formatCompactNumber, formatNumber } from "../lib/i18n/format.ts";

test("formatNumber groups digits per locale", () => {
	assert.equal(formatNumber(1234567, "en"), "1,234,567");
	assert.equal(formatNumber(1234, "zh-CN"), "1,234");
});

test("formatCompactNumber adapts notation per locale", () => {
	assert.equal(formatCompactNumber(1234, "en"), "1.2K");
	assert.equal(formatCompactNumber(1_234_567, "en"), "1.2M");
	// Chinese compacts at 万 (10k), not at 1k.
	assert.equal(formatCompactNumber(1234, "zh-CN"), "1234");
	assert.equal(formatCompactNumber(10_000, "zh-CN"), "1万");
});
