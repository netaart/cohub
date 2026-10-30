import assert from "node:assert/strict";
import { test } from "node:test";
import { createTalesofaiBillingOperations } from "../src/client.js";

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

const product = (input: {
  id: string;
  key: string;
  appName?: string;
}) => ({
  id: input.id,
  business_id: "business_1",
  key: input.key,
  name: input.key,
  description: null,
  status: "active",
  visibility: "public",
  billing_type: "recurring",
  amount: 1_000,
  currency: "USD",
  billing_period: "month",
  billing_interval_count: 1,
  meta: input.appName === undefined ? {} : { appName: input.appName },
  created_at: "2026-07-20T00:00:00.000Z",
  updated_at: "2026-07-20T00:00:00.000Z",
});

test("billing catalog only includes products for Cohub", async () => {
  const originalFetch = globalThis.fetch;
  const products = [
    product({ id: "product_cohub", key: "cohub_pro", appName: "cohub" }),
    product({ id: "product_other", key: "other_pro", appName: "other" }),
    product({ id: "product_legacy", key: "legacy_pro" }),
  ];
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    if (url.pathname === "/v1/products") {
      return jsonResponse({
        items: products,
        pagination: { has_more: false },
      });
    }
    if (url.pathname === "/v1/benefits") {
      return jsonResponse({
        items: [],
        pagination: { has_more: false },
      });
    }
    if (url.pathname === "/v1/business-default-plan") {
      return jsonResponse({
        default_plan: {
          status: "enabled",
          product_id: "product_other",
        },
      });
    }
    if (url.pathname === "/v1/providers/status") {
      return jsonResponse({
        status: "available",
        checkout_available: true,
        active_provider_key: "stripe",
        providers: [],
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
    const catalog = await operations.getCatalog();

    assert.deepEqual(
      catalog.products.map(({ key }) => key),
      ["cohub_pro"],
    );
    assert.deepEqual(
      catalog.plans.map(({ key }) => key),
      ["cohub_pro"],
    );
    assert.deepEqual(catalog.addons, []);
    assert.equal(catalog.defaultPlanProductKey, null);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("billing checkout rejects products outside the Cohub catalog", async () => {
  const originalFetch = globalThis.fetch;
  const products = [
    product({
      id: "product_other_plan",
      key: "other_plan",
      appName: "studio",
    }),
    {
      ...product({ id: "product_legacy_addon", key: "legacy_addon" }),
      billing_type: "one_time",
      billing_period: "one_time",
    },
  ];
  const requests: string[] = [];

  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    requests.push(`${method} ${url.pathname}`);
    if (url.pathname.startsWith("/v1/products/") && method === "GET") {
      const productKey = decodeURIComponent(
        url.pathname.split("/").at(-1) ?? "",
      );
      const found = products.find((item) => item.key === productKey);
      return found
        ? jsonResponse({ product: found })
        : jsonResponse({ error: { message: "Not found" } }, 404);
    }
    throw new Error(`Unexpected request: ${method} ${url}`);
  };

  try {
    const operations = createTalesofaiBillingOperations({
      baseUrl: "https://billing.example.test/v1",
      businessKey: "cohub",
      adminApiKey: "test-key",
    });
    const planCheckout = await operations.createSubscription({
      userId: "user_1",
      productKey: "other_plan",
    });
    const addonCheckout = await operations.purchaseAddon({
      userId: "user_1",
      productKey: "legacy_addon",
    });

    assert.equal(planCheckout.checkoutUsable, false);
    assert.equal(planCheckout.message, "Plan is not available for subscription");
    assert.equal(addonCheckout.checkoutUsable, false);
    assert.equal(addonCheckout.message, "Product is not available for purchase");
    assert.deepEqual(requests, [
      "GET /v1/products/other_plan",
      "GET /v1/products/legacy_addon",
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("past-due cancellation preserves closing and paid-before-cancel facts, and payment action checks ownership", async () => {
  const originalFetch = globalThis.fetch;
  const permission = (allowed: boolean) => ({ allowed, reason: allowed ? null : "subscription_occupied" });
  const subscription = { id: "sub_recovery", external_user_id: "user_1", product_key_snapshot: "cohub_pro", product_name_snapshot: "Pro", status: "past_due", cancel_at_period_end: false, current_period_end: "2026-10-29T00:00:00Z", renewal_recovery: { state: "grace", effective_ends_at: "2026-11-01T00:00:00Z", pay_invoice: permission(true), end_recovery: permission(true), subscribe: permission(false) } };
  let paidWon = false;
  let actionRequests = 0;
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname === "/v1/subscriptions/sub_recovery") return jsonResponse({ subscription, checkout: { provider_key: "stripe" }, payment_conflict: { reason: "recovery_deadline_expired", actual_amount: 100, actual_currency: "USD" } });
    if (url.pathname.endsWith("/cancel") && init?.method === "POST") return jsonResponse({ subscription: { ...subscription, status: paidWon ? "active" : "past_due", cancel_at_period_end: paidWon, renewal_recovery: { ...subscription.renewal_recovery, state: paidWon ? "none" : "closing", end_recovery: permission(false) } } });
    if (url.pathname.endsWith("/payment-action")) { actionRequests++; return jsonResponse({ subscription_id: subscription.id, payment_action: { kind: "stripe_hosted_invoice", checkout_ui_mode: "hosted_page", checkout_url: "https://invoice.stripe.test/current" }, reason: null }); }
    throw new Error(`Unexpected request: ${url}`);
  };
  try {
    const operations = createTalesofaiBillingOperations({ baseUrl: "https://billing.example.test/v1", businessKey: "cohub", adminApiKey: "test-key" });
    const ref = { userId: "user_1", subscriptionId: subscription.id };
    const closing = await operations.cancelSubscriptionAutoRenew(ref);
    assert.equal(closing.cancelAtPeriodEnd, false);
    assert.equal(closing.renewalRecovery?.state, "closing");
    assert.equal(closing.renewalRecovery?.subscribe.allowed, false);
    paidWon = true;
    const paid = await operations.cancelSubscriptionAutoRenew(ref);
    assert.equal(paid.status, "active");
    assert.equal(paid.cancelAtPeriodEnd, true);
    assert.equal((await operations.getSubscriptionPaymentAction(ref)).checkoutUrl, "https://invoice.stripe.test/current");
    await assert.rejects(operations.getSubscriptionPaymentAction({ ...ref, userId: "other" }));
    assert.equal(actionRequests, 1);
    assert.deepEqual((await operations.getSubscription(ref)).paymentConflict, { reason: "recovery_deadline_expired", amountMinor: 100, currency: "USD" });
  } finally { globalThis.fetch = originalFetch; }
});
