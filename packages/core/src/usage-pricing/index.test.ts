import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { parsePricingConfig } from "@cohub/billing";
import { parse } from "yaml";
import { clearPricingConfigCache, createUsagePricing, PRICING_CONFIG_PATH, priceUsage } from "./index.js";

test("pricing.yaml hot-reloads, keeps the last valid rules on a bad edit, and prices each payer", async () => {
  const root = await mkdtemp(join(tmpdir(), "usage-pricing-"));
  clearPricingConfigCache();
  try {
    const path = join(root, PRICING_CONFIG_PATH);
    await mkdir(dirname(path), { recursive: true });
    const errors: unknown[] = [];
    const pricing = createUsagePricing({
      billing: { getActiveBenefits: async () => [{ benefitKey: "pro_plan", enabled: true, metadata: {} }] },
      platformConfigRoot: root,
      onConfigError: (error) => errors.push(error),
    });
    const subject = { userId: "u", usageType: "generation.llm", model: "claude", at: new Date("2026-11-21T00:00:00Z") };
    assert.equal((await pricing.quote(subject)).personal.multiplier, 1);

    await writeFile(path, `schema: cohub.billing.pricing.v1
rules:
  - key: weekend-llm
    when:
      usageTypes: [generation.llm]
      startsAt: 2026-11-20T00:00:00+08:00
      endsAt: 2026-11-23T00:00:00+08:00
    effect: { multiplier: 0.8 }
  - key: pro-llm
    when: { usageTypes: [generation.llm], benefits: [pro_plan] }
    effect: { multiplier: 0.5 }
`);
    const quote = await pricing.quote(subject);
    assert.deepEqual([quote.personal.key, quote.spaceWallet.key], ["pro-llm", "weekend-llm"]);
    const admitted = await pricing.freeze("u", []);
    assert.deepEqual(priceUsage(quote, 0.1, "LLM usage p/claude"), {
      amountUsd: 0.05,
      reason: "LLM usage p/claude [list=0.1;x=0.5]",
      spaceWalletCharge: { amountUsd: 0.08, reason: "LLM usage p/claude [list=0.1;x=0.8]" },
    });

    await writeFile(path, "rules: []");
    assert.equal((await pricing.quote(subject)).personal.multiplier, 1);
    assert.equal((await admitted(subject)).personal.key, "pro-llm");

    await writeFile(path, "rules: [{ key: weekend-llm, effect: { multiplier: 8 } }]   ");
    assert.equal((await pricing.quote(subject)).personal.multiplier, 1);
    assert.equal(errors.length, 1);
  } finally {
    clearPricingConfigCache();
    await rm(root, { recursive: true, force: true });
  }
});

test("the documented pricing example stays valid", async () => {
  const example = await readFile(new URL("../../../../docs/examples/billing-pricing.yaml", import.meta.url), "utf-8");
  assert.equal(parsePricingConfig(parse(example)).rules.length, 3);
});

test("a frozen price keeps the admission instant when a window closes before settlement", async () => {
  const root = await mkdtemp(join(tmpdir(), "usage-pricing-"));
  clearPricingConfigCache();
  try {
    const path = join(root, PRICING_CONFIG_PATH);
    await mkdir(dirname(path), { recursive: true });
    const endsAt = new Date(Date.now() + 100).toISOString();
    await writeFile(path, `rules: [{ key: closing, when: { endsAt: "${endsAt}" }, effect: { multiplier: 0.5 } }]`);
    const pricing = createUsagePricing({ billing: { getActiveBenefits: async () => [] }, platformConfigRoot: root, onConfigError: () => {} });
    const admitted = await pricing.freeze("u", []);
    await new Promise((resolve) => setTimeout(resolve, 150));
    const subject = { usageType: "generation.llm.raw", model: "m" };
    assert.equal((await admitted(subject)).personal.multiplier, 0.5);
    assert.equal((await pricing.quote({ ...subject, userId: "u" })).personal.multiplier, 1);
  } finally {
    clearPricingConfigCache();
    await rm(root, { recursive: true, force: true });
  }
});
