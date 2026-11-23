import assert from "node:assert/strict";
import { test } from "node:test";
import {
	describePricingOffer,
	isPricingSnapshotFree,
	parsePricingConfig,
	parsePricingSnapshot,
	quotaUnitsRequested,
	quotePricing,
	snapshotMultiplier,
	type PricingSnapshot,
} from "../src/pricing.js";

const config = parsePricingConfig({
	schema: "cohub.billing.pricing.v1",
	rules: [
		{
			key: "video-launch",
			announce: true,
			when: {
				usageTypes: ["generation.video"],
				models: ["h3"],
				startsAt: "2026-11-20T00:00:00+08:00",
				endsAt: "2026-11-23T00:00:00+08:00",
			},
			effect: { multiplier: 0.5 },
		},
		{ key: "paused", enabled: false, when: { models: ["h3"] }, effect: { multiplier: 0 } },
		{ key: "pro-video", when: { usageTypes: ["generation.video"], benefits: ["pro_plan"] }, effect: { multiplier: 0.4 } },
		{ key: "daily-video", when: { models: ["h3"], benefits: ["pro_plan"] }, effect: { quota: { tokenType: "video_second", parameter: "duration" } } },
		{ key: "llm-weekend", when: { usageTypes: ["generation.llm"], payer: "space_wallet" }, effect: { multiplier: 0.8 } },
	],
});

const during = new Date("2026-11-21T12:00:00Z");
const after = new Date("2026-11-22T16:00:00Z");
const noBenefits = async () => [];
const pro = async () => [{ benefitKey: "pro_plan", enabled: true, metadata: {} }];

test("pricing config rejects rules that could silently misprice", () => {
	const rule = (patch: Record<string, unknown>) => ({ rules: [{ key: "r", effect: { multiplier: 0.5 }, ...patch }] });
	const invalid: unknown[] = [
		rule({ when: { usageTypes: ["sandbox.compute"] } }),
		rule({ when: { usageType: ["generation.video"] } }),
		rule({ effect: { multiplier: 1.5 } }),
		rule({ effect: { multiplier: 0.5, quota: { tokenType: "s", parameter: "duration" } } }),
		rule({ effect: { quota: { tokenType: "usd_micro_cent", parameter: "duration" } } }),
		rule({ effect: { quota: { tokenType: "s", parameter: "duration" } }, when: { payer: "personal" } }),
		rule({ when: { benefits: ["pro_plan"], payer: "space_wallet" } }),
		rule({ when: { startsAt: "2026-11-20T00:00:00" } }),
		rule({ when: { startsAt: "2026-11-21T00:00:00Z", endsAt: "2026-11-20T00:00:00Z" } }),
		rule({ key: "Has Spaces" }),
		{ rules: [{ key: "r", effect: { multiplier: 1 } }, { key: "r", effect: { multiplier: 1 } }] },
		{ schema: "cohub.billing.pricing.v2" },
	];
	for (const document of invalid) assert.throws(() => parsePricingConfig(document), JSON.stringify(document));
	assert.deepEqual(parsePricingConfig(null).rules, []);
});

test("a campaign prices both payers inside its window and nothing outside it", async () => {
	const subject = { usageType: "generation.video", model: "h3" };
	const inWindow = await quotePricing({ config, subject: { ...subject, at: during }, loadBenefits: noBenefits });
	assert.deepEqual(inWindow.personal, { multiplier: 0.5, source: "rule", key: "video-launch" });
	assert.deepEqual(inWindow.spaceWallet, { multiplier: 0.5, source: "rule", key: "video-launch" });
	const ended = await quotePricing({ config, subject: { ...subject, at: after }, loadBenefits: noBenefits });
	assert.equal(ended.personal.multiplier, 1);
	assert.equal(ended.spaceWallet.multiplier, 1);
});

test("benefit rules and per-model benefit discounts only price personal charges, lowest wins", async () => {
	const quote = await quotePricing({ config, subject: { usageType: "generation.video", model: "h3", at: during }, loadBenefits: pro });
	assert.deepEqual(quote.personal, { multiplier: 0.4, source: "rule", key: "pro-video" });
	assert.deepEqual(quote.spaceWallet, { multiplier: 0.5, source: "rule", key: "video-launch" });
	assert.deepEqual(quote.quota, { ruleKey: "daily-video", tokenType: "video_second", parameter: "duration" });

	const modelDiscount = await quotePricing({
		config: { rules: [] },
		subject: { usageType: "generation.image", model: "gpt-image-2", modelDiscounts: true },
		loadBenefits: async () => [{ benefitKey: "max_model_discount_v1", enabled: true, metadata: { "gpt-image-2": 0 } }],
	});
	assert.deepEqual(modelDiscount.personal, { multiplier: 0, source: "benefit", key: "max_model_discount_v1" });
	assert.equal(modelDiscount.spaceWallet.multiplier, 1);
});

test("benefits are only read when a candidate rule needs them", async () => {
	let reads = 0;
	const counted = async () => {
		reads += 1;
		return [];
	};
	const llm = await quotePricing({ config, subject: { usageType: "generation.llm", model: "claude", at: during }, loadBenefits: counted });
	assert.equal(reads, 0);
	assert.equal(llm.personal.multiplier, 1);
	assert.deepEqual(llm.spaceWallet, { multiplier: 0.8, source: "rule", key: "llm-weekend" });
	await quotePricing({ config, subject: { usageType: "generation.video", model: "x", at: during }, loadBenefits: counted });
	assert.equal(reads, 1);
	const outside = await quotePricing({ config, subject: { usageType: "sandbox.compute", model: "h3", at: during }, loadBenefits: counted });
	assert.equal(outside.personal.multiplier, 1);
});

test("snapshots charge only the uncovered share of a partially covered request", () => {
	const quota = { ruleKey: "daily-video", tokenType: "video_second", requested: 10, covered: 6 };
	const snapshot: PricingSnapshot = {
		resolvedAt: during.toISOString(),
		personal: { multiplier: 0.5, source: "rule", key: "video-launch" },
		spaceWallet: { multiplier: 1, source: null, key: null },
		quota,
	};
	assert.equal(snapshotMultiplier(snapshot, "personal"), 0.2);
	assert.equal(snapshotMultiplier(snapshot, "space_wallet"), 0.4);
	assert.equal(isPricingSnapshotFree(snapshot), false);
	assert.equal(isPricingSnapshotFree({ ...snapshot, quota: { ...quota, covered: 10 } }), true);
	assert.deepEqual(parsePricingSnapshot(JSON.parse(JSON.stringify(snapshot))), snapshot);
	assert.throws(() => parsePricingSnapshot({ ...snapshot, quota: { ...quota, covered: 11 } }));
	assert.equal(quotaUnitsRequested({ duration: 9.2 }, "duration"), 10);
	assert.equal(quotaUnitsRequested({ duration: "10" }, "duration"), 0);
});

test("offers expose the personal price and the end of the winning rule", async () => {
	const quote = await quotePricing({ config, subject: { usageType: "generation.video", model: "h3", at: during }, loadBenefits: noBenefits });
	assert.deepEqual(describePricingOffer(config, quote), {
		offer: { multiplier: 0.5, ruleKey: "video-launch", endsAt: "2026-11-22T16:00:00.000Z", announce: true },
		quota: null,
	});
	const listPrice = await quotePricing({ config, subject: { usageType: "generation.video", model: "seedance" }, loadBenefits: noBenefits });
	assert.deepEqual(describePricingOffer(config, listPrice), { offer: null, quota: null });
});
