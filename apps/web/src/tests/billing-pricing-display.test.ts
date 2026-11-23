import assert from "node:assert/strict";
import { test } from "node:test";
import {
	runPricing,
	usagePricing,
	usageSubject,
} from "../lib/features/billing/ledger.ts";
import {
	liveOffer,
	multiplierLabel,
	offerDeadline,
} from "../lib/model-pricing.ts";

const usage = (description: string, amountUsd = -1) => ({
	id: description,
	kind: "usage" as const,
	tokenType: "usd_micro_cent",
	title: "",
	description,
	usageType: "generation.video",
	sourceType: null,
	sourceId: null,
	operationId: null,
	amountUsd,
	status: "covered" as const,
	createdAt: "2026-11-21T00:00:00.000Z",
});

test("ledger reads the pricing suffix and keeps the subject clean", () => {
	const item = usage("Generation h3 [list=5;x=0.5;quota=6/10]");
	assert.equal(usageSubject(item), "h3");
	assert.deepEqual(usagePricing(item), {
		listUsd: 5,
		multiplier: 0.5,
		quota: { covered: 6, requested: 10 },
	});
	assert.equal(usagePricing(usage("Generation h3")), null);
	assert.deepEqual(runPricing([item, usage("Generation h3 [list=1;x=0.5]")]), {
		listUsd: -6,
		multiplier: 0.5,
		quota: null,
	});
	assert.equal(runPricing([item, usage("Generation h3")]), null);
	const covered = {
		...usage("Generation h3", 0),
		quota: { tokenType: "video_second", units: 10 },
	};
	assert.deepEqual(runPricing([covered]), {
		listUsd: null,
		multiplier: null,
		quota: { covered: 10, requested: 10 },
	});
});

test("offers expire on the client and count down in their final day", () => {
	const now = Date.parse("2026-11-22T11:00:00Z");
	const offer = {
		multiplier: 0.5,
		ruleKey: "launch",
		endsAt: "2026-11-22T16:00:00Z",
		announce: true,
	};
	assert.equal(liveOffer(offer, now), offer);
	assert.equal(liveOffer(offer, Date.parse("2026-11-22T16:00:00Z")), null);
	assert.equal(liveOffer({ ...offer, multiplier: 1 }, now), null);
	assert.equal(offerDeadline(offer, "en", now), "5h left");
	assert.equal(
		offerDeadline(offer, "zh-CN", Date.parse("2026-11-22T15:30:00Z")),
		"剩 30 分钟",
	);
	assert.equal(multiplierLabel(0.5, "en"), "-50%");
	assert.equal(multiplierLabel(0, "zh-CN"), "免费");
});
