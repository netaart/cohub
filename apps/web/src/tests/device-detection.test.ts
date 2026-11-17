import assert from "node:assert/strict";
import { test } from "node:test";
import { getDeviceType } from "#lib/device-detection.ts";

const WINDOWS_CHROME_USER_AGENT =
	"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
	"(KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36";
const IPHONE_USER_AGENT =
	"Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) " +
	"AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 " +
	"Mobile/15E148 Safari/604.1";
const IPAD_USER_AGENT =
	"Mozilla/5.0 (iPad; CPU OS 18_6 like Mac OS X) AppleWebKit/605.1.15 " +
	"(KHTML, like Gecko) Version/18.6 Mobile/15E148 Safari/604.1";

test("classifies a Windows touchscreen browser as desktop", () => {
	assert.equal(getDeviceType(WINDOWS_CHROME_USER_AGENT), "desktop");
});

test("classifies mobile and tablet user agents", () => {
	assert.equal(getDeviceType(IPHONE_USER_AGENT), "mobile");
	assert.equal(getDeviceType(IPAD_USER_AGENT), "tablet");
});

test("returns unknown when the user agent has no platform classification", () => {
	assert.equal(getDeviceType("Mozilla/5.0"), "unknown");
	assert.equal(getDeviceType(""), "unknown");
});
