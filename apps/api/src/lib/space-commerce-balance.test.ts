import assert from "node:assert/strict";
import test from "node:test";
import {
  COHUB_BILLING_CREDIT_UNITS,
  COHUB_BILLING_TOKEN_TYPES,
} from "@cohub/billing";
import type { CreditsBenefit, Product } from "@cohub/billing";
import { serializeProduct } from "./commerce-serialize.js";
import {
  buildCohubBalanceBenefitConfig,
  buildCohubBalanceBenefitKey,
  buildCohubBalanceProductMeta,
  CohubBalanceValidationError,
  collectManagedBalanceBenefitKeys,
  isCohubBalanceBenefitValid,
  isCohubBalanceProductValid,
  parseCohubBalanceProductMeta,
  readCohubBalanceDescriptor,
  resolveBalanceProductCreateState,
  resolveCohubBalanceSpec,
  serializeCohubBalance,
  COHUB_BALANCE_META_KEY,
} from "./space-commerce-balance.js";

test("never creates a Balance product as draft, because Billing cannot bind to drafts", () => {
  // Regression: staging a Balance product as `draft` made bindBenefit fail with
  // 409, so provisioning could never succeed.
  for (const requestedStatus of ["draft", "active"] as const) {
    for (const requestedVisibility of ["public", "private"] as const) {
      const state = resolveBalanceProductCreateState({
        hasBalance: true,
        requestedStatus,
        requestedVisibility,
      });
      assert.equal(state.status, "active");
      // Must not be publicly reachable before the Benefit is bound.
      assert.equal(state.visibility, "private");
    }
  }
});

test("passes through the requested state when there is no Balance", () => {
  assert.deepEqual(
    resolveBalanceProductCreateState({
      hasBalance: false,
      requestedStatus: "draft",
      requestedVisibility: "public",
    }),
    { status: "draft", visibility: "public" },
  );
  assert.deepEqual(
    resolveBalanceProductCreateState({
      hasBalance: false,
      requestedStatus: "active",
      requestedVisibility: "private",
    }),
    { status: "active", visibility: "private" },
  );
});

test("resolves a whole-dollar Cohub Balance spec", () => {
  const spec = resolveCohubBalanceSpec({ value: 5, productAmountMinor: 799 });
  assert.ok(spec);
  assert.deepEqual(spec, {
    amountUsd: 5,
    amountMinor: 500,
    benefitAmount: 5 * COHUB_BILLING_CREDIT_UNITS.usdMicroCent.unitsPerUsd,
    policyVersion: "balance-bundle-v1",
  });
  assert.deepEqual(buildCohubBalanceBenefitConfig(spec), {
    token_type: COHUB_BILLING_TOKEN_TYPES.usdMicroCent,
    amount: 5 * COHUB_BILLING_CREDIT_UNITS.usdMicroCent.unitsPerUsd,
    scope: "global",
    grant_kind: "purchased",
  });
});

test("rejects fractional, zero, and underpriced Cohub Balance specs", () => {
  for (const value of [0, -1, 1.5, "5"]) {
    assert.throws(
      () => resolveCohubBalanceSpec({ value, productAmountMinor: 1_000 }),
      CohubBalanceValidationError,
    );
  }
  assert.throws(
    () => resolveCohubBalanceSpec({ value: 5, productAmountMinor: 499 }),
    /Product price must cover Cohub Balance/,
  );
});

test("builds deterministic provider-safe benefit keys", () => {
  const productKey = "a".repeat(128);
  const first = buildCohubBalanceBenefitKey(productKey, 5);
  assert.equal(first, buildCohubBalanceBenefitKey(productKey, 5));
  assert.ok(first.length <= 64);
  assert.match(first, /^[a-zA-Z0-9_-]+$/);
  assert.notEqual(first, buildCohubBalanceBenefitKey(productKey, 6));
});

test("round-trips the managed Balance marker through Product meta", () => {
  const spec = resolveCohubBalanceSpec({ value: 5, productAmountMinor: 799 });
  assert.ok(spec);
  const benefitKey = "creator_pack_cb_5_deadbeef";
  const meta = buildCohubBalanceProductMeta(spec, benefitKey);
  assert.deepEqual(meta, {
    version: 1,
    benefit_key: benefitKey,
    amount_minor: 500,
    policy_version: "balance-bundle-v1",
  });
  assert.deepEqual(parseCohubBalanceProductMeta(meta), {
    benefitKey,
    amountMinor: 500,
    policyVersion: "balance-bundle-v1",
  });
  assert.deepEqual(readCohubBalanceDescriptor({ meta: { [COHUB_BALANCE_META_KEY]: meta } }), {
    benefitKey,
    amountMinor: 500,
    policyVersion: "balance-bundle-v1",
  });
  assert.deepEqual(serializeCohubBalance(
    readCohubBalanceDescriptor({ meta: { [COHUB_BALANCE_META_KEY]: meta } }),
  ), {
    amountUsd: 5,
    amountMinor: 500,
    policyVersion: "balance-bundle-v1",
  });
});

test("rejects malformed Balance Product meta", () => {
  assert.equal(parseCohubBalanceProductMeta(null), null);
  assert.equal(parseCohubBalanceProductMeta("garbage"), null);
  assert.equal(parseCohubBalanceProductMeta({ version: 2 }), null);
  assert.equal(parseCohubBalanceProductMeta({
    version: 1,
    benefit_key: "",
    amount_minor: 500,
    policy_version: "balance-bundle-v1",
  }), null);
  assert.equal(parseCohubBalanceProductMeta({
    version: 1,
    benefit_key: "k",
    amount_minor: 150,
    policy_version: "balance-bundle-v1",
  }), null);
  assert.equal(parseCohubBalanceProductMeta({
    version: 1,
    benefit_key: "k",
    amount_minor: 500.5,
    policy_version: "balance-bundle-v1",
  }), null);
});

test("serializes Balance separately from Space credits", () => {
  const product: Product = {
    id: "product-id",
    key: "creator_pack",
    name: "Creator Pack",
    description: null,
    status: "active",
    visibility: "public",
    billing_type: "one_time",
    currency: "USD",
    amount: 799,
  };
  const spaceCredits: CreditsBenefit = {
    id: "space-credit-id",
    business_id: "business-id",
    key: "space_credits",
    type: "credits",
    name: "Space credits",
    description: null,
    status: "active",
    config: {
      token_type: "cohub_credit",
      amount: 100,
      scope: "business",
      grant_kind: "purchased",
    },
  };
  const balance: CreditsBenefit = {
    ...spaceCredits,
    id: "balance-id",
    key: "creator_pack_cb_5_deadbeef",
    name: "Cohub Balance $5",
    config: {
      token_type: COHUB_BILLING_TOKEN_TYPES.usdMicroCent,
      amount: 5 * COHUB_BILLING_CREDIT_UNITS.usdMicroCent.unitsPerUsd,
      scope: "global",
      grant_kind: "purchased",
    },
  };
  const descriptor = {
    benefitKey: balance.key,
    amountMinor: 500,
    policyVersion: "balance-bundle-v1",
  };

  const serialized = serializeProduct(product, [spaceCredits, balance], descriptor);
  assert.equal(serialized.display.creditsAmount, 100);
  assert.deepEqual(serialized.display.creditBenefits.map((item) => item.key), [
    spaceCredits.key,
  ]);
  assert.deepEqual(serialized.cohubBalance, {
    amountUsd: 5,
    amountMinor: 500,
    policyVersion: "balance-bundle-v1",
  });
});

test("validates every managed Balance benefit invariant", () => {
  const benefit: CreditsBenefit = {
    id: "benefit-id",
    business_id: "business-id",
    key: "product_cb_5_deadbeef",
    type: "credits",
    name: "Cohub Balance $5",
    description: null,
    status: "active",
    config: {
      token_type: COHUB_BILLING_TOKEN_TYPES.usdMicroCent,
      amount: 5 * COHUB_BILLING_CREDIT_UNITS.usdMicroCent.unitsPerUsd,
      scope: "global",
      grant_kind: "purchased",
    },
  };
  const balance = {
    benefitKey: benefit.key,
    amountMinor: 500,
    policyVersion: "balance-bundle-v1",
  };
  assert.equal(isCohubBalanceBenefitValid(benefit, balance), true);
  assert.equal(isCohubBalanceBenefitValid({
    ...benefit,
    config: { ...benefit.config, amount: 1 },
  }, balance), false);
  assert.equal(isCohubBalanceBenefitValid({
    ...benefit,
    config: { ...benefit.config, scope: "business" },
  }, balance), false);
  assert.equal(isCohubBalanceBenefitValid(benefit, {
    ...balance,
    policyVersion: "future-policy",
  }), false);
});

test("validates the complete managed Balance product binding", () => {
  const balance = {
    benefitKey: "creator-pack-balance",
    amountMinor: 500,
    policyVersion: "balance-bundle-v1",
  };
  const benefit: CreditsBenefit = {
    id: "benefit-id",
    business_id: "business-id",
    key: balance.benefitKey,
    type: "credits",
    name: "Cohub Balance $5",
    description: null,
    status: "active",
    config: {
      token_type: COHUB_BILLING_TOKEN_TYPES.usdMicroCent,
      amount: 5 * COHUB_BILLING_CREDIT_UNITS.usdMicroCent.unitsPerUsd,
      scope: "global",
      grant_kind: "purchased",
    },
  };
  const input = {
    productKey: "creator-pack",
    productAmountMinor: 500,
    productCurrency: "USD",
    balance,
    benefit,
    boundBenefitKeys: [benefit.key],
  };

  assert.equal(isCohubBalanceProductValid(input), true);
  assert.equal(isCohubBalanceProductValid({
    ...input,
    productAmountMinor: 499,
  }), false);
  assert.equal(isCohubBalanceProductValid({
    ...input,
    productCurrency: "EUR",
  }), false);
  assert.equal(isCohubBalanceProductValid({
    ...input,
    benefit: null,
  }), false);
  assert.equal(isCohubBalanceProductValid({
    ...input,
    boundBenefitKeys: [],
  }), false);
});

test("collects managed Balance benefit keys from Product metas", () => {
  const spec = resolveCohubBalanceSpec({ value: 5, productAmountMinor: 800 });
  assert.ok(spec);
  const withBalance = {
    key: "a",
    meta: {
      [COHUB_BALANCE_META_KEY]: buildCohubBalanceProductMeta(spec, "pack_cb_5_x"),
    },
  };
  const withoutBalance = { key: "b", meta: {} };
  const keys = collectManagedBalanceBenefitKeys([withBalance, withoutBalance]);
  assert.deepEqual([...keys], ["pack_cb_5_x"]);
});
