import assert from "node:assert/strict";
import { test } from "node:test";
import {
	BILLING_ACCESS_BLOCKED_ERROR_CODE,
	FEATURE_NOT_ENTITLED_ERROR_CODE,
	extractBillingPayload,
	isBillingAccessBlockedCode,
	isBillingAccessBlockedError,
	isFeatureNotEntitledError,
} from "../src/http-error.js";
import { HttpError } from "../src/transport.js";

const conversion = {
	level: "hard",
	reason: "negative_balance_limit_exceeded",
	audience: "unknown",
	preferredOfferKind: "mixed",
	title: "Add credits to continue",
	message: "Add credits to resume AI requests.",
	primaryAction: { label: "Add credits", action: "open_billing_conversion" },
	source: "session_prompt",
};

test("extractBillingPayload reads standard blocked body", () => {
	const body = {
		code: BILLING_ACCESS_BLOCKED_ERROR_CODE,
		message: "Add credits to continue.",
		billing: {
			status: "blocked",
			netUsd: 0.5,
			minimumBalanceUsd: 1.01,
			conversion: { ...conversion, reason: "minimum_balance_not_met" },
		},
	};
	const payload = extractBillingPayload(body);
	assert.ok(payload);
	assert.equal(payload.status, "blocked");
	assert.equal(payload.minimumBalanceUsd, 1.01);
	assert.equal(payload.conversion.reason, "minimum_balance_not_met");
	assert.equal(payload.conversion.title, "Add credits to continue");
});

test("extractBillingPayload reads from HttpError", () => {
	const error = new HttpError("blocked", 402, {
		code: BILLING_ACCESS_BLOCKED_ERROR_CODE,
		message: "blocked",
		billing: { status: "blocked", conversion },
	});
	const payload = extractBillingPayload(error);
	assert.ok(payload);
	assert.equal(payload.status, "blocked");
});

test("extractBillingPayload reads a bare billing payload (realtime event)", () => {
	const payload = extractBillingPayload({ status: "blocked", netUsd: -2, conversion });
	assert.ok(payload);
	assert.equal(payload.status, "blocked");
	assert.equal(payload.conversion.title, "Add credits to continue");
});

test("extractBillingPayload rejects body without a valid conversion", () => {
	assert.equal(extractBillingPayload({ billing: { status: "blocked" } }), null);
	assert.equal(extractBillingPayload({ message: "nope" }), null);
	assert.equal(extractBillingPayload(null), null);
});

test("feature gate body extracts its conversion", () => {
	const body = {
		code: FEATURE_NOT_ENTITLED_ERROR_CODE,
		message: "Upgrade required.",
		billing: { conversion: { ...conversion, reason: "feature_not_entitled" } },
	};
	const payload = extractBillingPayload(body);
	assert.ok(payload);
	assert.equal(payload.status, undefined);
	assert.equal(payload.conversion.reason, "feature_not_entitled");
});

test("error code helpers classify HttpError instances", () => {
	const blocked = new HttpError("x", 402, { code: BILLING_ACCESS_BLOCKED_ERROR_CODE });
	const gate = new HttpError("x", 402, { code: FEATURE_NOT_ENTITLED_ERROR_CODE });
	assert.equal(isBillingAccessBlockedError(blocked), true);
	assert.equal(isBillingAccessBlockedError(gate), false);
	assert.equal(isFeatureNotEntitledError(gate), true);
	assert.equal(isBillingAccessBlockedCode(BILLING_ACCESS_BLOCKED_ERROR_CODE), true);
	assert.equal(isBillingAccessBlockedCode(null), false);
});
