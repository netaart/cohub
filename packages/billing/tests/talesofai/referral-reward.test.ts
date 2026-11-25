import assert from "node:assert/strict";
import { test } from "node:test";
import { createTalesofaiBillingOperations } from "../../src/client.js";

const benefit = (amount: number) => ({
  benefit: {
    id: "benefit_1",
    business_id: "business_1",
    key: "referral_inviter_credit",
    type: "credits",
    name: "Referral reward",
    description: null,
    status: "active",
    config: {
      token_type: "usd_micro_cent",
      amount,
      scope: "business",
      grant_kind: "promo",
      expires_in_days: 90,
    },
    config_version: "1",
    created_at: new Date(0).toISOString(),
    updated_at: new Date(0).toISOString(),
  },
});

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

test("referral reward validates amount and uses a stable HTTP idempotency key", async () => {
  const requests: Array<{ url: URL; init: RequestInit }> = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    requests.push({ url, init: init ?? {} });
    if (url.pathname === "/v1/benefits/referral_inviter_credit") {
      return jsonResponse(benefit(500_000_000));
    }
    if (url.pathname === "/v1/customers") {
      return jsonResponse({ customer: { external_user_id: "inviter_1" } });
    }
    if (url.pathname === "/v1/credits/grant") {
      return jsonResponse({
        grant: {
          id: "grant_1",
          original_amount: 500_000_000,
          token_type: "usd_micro_cent",
        },
        transaction: { id: "transaction_1" },
      });
    }
    throw new Error(`Unexpected request: ${url}`);
  };

  try {
    const operations = createTalesofaiBillingOperations({
      baseUrl: "https://billing.example.test/v1",
      businessKey: "cohub",
      adminApiKey: "test-key",
    });
    const result = await operations.grantReferralReward({
      userId: "inviter_1",
      referralId: "referral_1",
      side: "inviter",
      operationId: "referral:referral_1:inviter",
      expectedAmountUsd: 5,
    });

    assert.deepEqual(result, {
      amountUsd: 5,
      benefitKey: "referral_inviter_credit",
      grantId: "grant_1",
      transactionId: "transaction_1",
    });
    const grantRequest = requests.find(({ url }) => url.pathname === "/v1/credits/grant");
    assert.ok(grantRequest);
    assert.equal(
      new Headers(grantRequest.init.headers).get("idempotency-key"),
      "referral:referral_1:inviter",
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("referral reward records the actual amount returned after grant", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    if (url.pathname === "/v1/benefits/referral_inviter_credit") {
      return jsonResponse(benefit(500_000_000));
    }
    if (url.pathname === "/v1/customers") {
      return jsonResponse({ customer: { external_user_id: "inviter_1" } });
    }
    if (url.pathname === "/v1/credits/grant") {
      return jsonResponse({
        grant: {
          id: "grant_1",
          original_amount: 400_000_000,
          token_type: "usd_micro_cent",
        },
        transaction: { id: "transaction_1" },
      });
    }
    throw new Error(`Unexpected request: ${url}`);
  };

  try {
    const operations = createTalesofaiBillingOperations({
      baseUrl: "https://billing.example.test/v1",
      businessKey: "cohub",
      adminApiKey: "test-key",
    });
    const result = await operations.grantReferralReward({
      userId: "inviter_1",
      referralId: "referral_1",
      side: "inviter",
      operationId: "referral:referral_1:inviter",
      expectedAmountUsd: 5,
    });

    assert.equal(result.amountUsd, 4);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("referral reward fails closed when the benefit amount differs", async () => {
  const originalFetch = globalThis.fetch;
  let grantCalls = 0;
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    if (url.pathname === "/v1/benefits/referral_inviter_credit") {
      return jsonResponse(benefit(300_000_000));
    }
    if (url.pathname === "/v1/credits/grant") grantCalls += 1;
    throw new Error(`Unexpected request: ${url}`);
  };

  try {
    const operations = createTalesofaiBillingOperations({
      baseUrl: "https://billing.example.test/v1",
      businessKey: "cohub",
      adminApiKey: "test-key",
    });
    await assert.rejects(
      operations.grantReferralReward({
        userId: "inviter_1",
        referralId: "referral_1",
        side: "inviter",
        operationId: "referral:referral_1:inviter",
        expectedAmountUsd: 5,
      }),
      /must grant USD 5\.00/,
    );
    assert.equal(grantCalls, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
