import assert from "node:assert/strict";
import { test } from "node:test";
import { createTalesofaiBillingOperations } from "../src/client.js";

const response = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

const product = (key: string, billingType: "recurring" | "one_time") => ({
  id: `product_${key}`,
  business_id: "business_1",
  key,
  name: key,
  description: null,
  status: "active",
  visibility: "public",
  billing_type: billingType,
  amount: 2_000,
  currency: "USD",
  billing_period: billingType === "recurring" ? "month" : "one_time",
  billing_interval_count: 1,
  meta: { appName: "cohub" },
  created_at: "2026-08-01T00:00:00.000Z",
  updated_at: "2026-08-01T00:00:00.000Z",
});

const discount = (input: {
  id: string;
  kind: "subscription" | "addon";
  productKey?: string;
}) => ({
  id: input.id,
  name: `${input.kind} half price`,
  effective_status: "available",
  code_preview: null,
  effect: { type: "percentage", percentage_bps: 5_000 },
  duration: { type: "once" },
  ends_at: null,
  max_redemptions_per_customer: 1,
  version: 1,
  metadata: {
    cohub_first_purchase_default_v1: input.kind,
    ...(input.productKey
      ? { cohub_first_purchase_product_key: input.productKey }
      : {}),
  },
  created_at: "2026-08-01T00:00:00.000Z",
});

function preview(discountId: string) {
  return {
    eligible: true,
    reason_code: null,
    discount: {
      discount_id: discountId,
      name: `${discountId} half price`,
      ends_at: null,
    },
    duration: { type: "once" },
    pricing: {
      amount: 2_000,
      discount_amount: 1_000,
      paid_amount: 1_000,
      currency: "USD",
    },
  };
}

test("catalog shares one first-purchase offer across plans and isolates addon offers per product", async () => {
  const originalFetch = globalThis.fetch;
  const products = [
    product("cohub_pro_monthly", "recurring"),
    product("cohub_max_monthly", "recurring"),
    product("cohub_credits_small", "one_time"),
    product("cohub_credits_large", "one_time"),
  ];
  let createdSubscriptionBody: Record<string, unknown> | null = null;
  let subscriptionCreateRequests = 0;
  let subscriptionCreated = false;
  let orderCreateRequests = 0;
  let orderCreated = false;
  let discountListRequests = 0;
  let failingPreviewId: string | null = null;
  const discounts = [
    discount({ id: "discount_subscription", kind: "subscription" }),
    discount({
      id: "discount_small",
      kind: "addon",
      productKey: "cohub_credits_small",
    }),
    discount({
      id: "discount_large",
      kind: "addon",
      productKey: "cohub_credits_large",
    }),
  ];

  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    if (url.pathname === "/v1/customers" && method === "POST") {
      return response({ customer: { external_user_id: "user_1" } });
    }
    if (url.pathname === "/v1/products") {
      return response({ items: products, pagination: { has_more: false } });
    }
    if (url.pathname === "/v1/benefits") {
      return response({ items: [], pagination: { has_more: false } });
    }
    if (url.pathname === "/v1/business-default-plan") {
      return response({
        default_plan: { status: "disabled", product_id: null },
      });
    }
    if (url.pathname === "/v1/providers/status") {
      return response({
        status: "available",
        checkout_available: true,
        active_provider_key: "stripe",
        providers: [],
      });
    }
    if (url.pathname === "/v1/subscriptions" && method === "POST") {
      subscriptionCreateRequests += 1;
      subscriptionCreated = true;
      createdSubscriptionBody = JSON.parse(String(init?.body)) as Record<
        string,
        unknown
      >;
      return response({
        subscription: { id: "subscription_1" },
        checkout: {
          checkout_usable: true,
          checkout_url: "https://checkout.example.test/session_1",
        },
        reused: false,
      });
    }
    if (url.pathname === "/v1/orders" && method === "POST") {
      orderCreateRequests += 1;
      orderCreated = true;
      return response({
        order: { id: "order_1", subscription_id: null },
        checkout: {
          checkout_usable: true,
          checkout_url: "https://checkout.example.test/order_1",
        },
      });
    }
    if (url.pathname === "/v1/orders/order_1" && method === "GET") {
      return response({
        order: { id: "order_1", subscription_id: null },
        checkout: {
          checkout_usable: true,
          checkout_url: "https://checkout.example.test/order_1",
        },
        discount: { discount_id: "discount_small" },
      });
    }
    if (url.pathname === "/v1/orders") {
      return response({
        items: orderCreated ? [{ id: "order_1" }] : [],
        pagination: { has_more: false },
      });
    }
    if (
      url.pathname === "/v1/subscriptions/subscription_1" &&
      method === "GET"
    ) {
      return response({
        subscription: {
          id: "subscription_1",
          status: "pending_checkout",
          product_key_snapshot: "cohub_pro_monthly",
        },
        checkout: {
          checkout_usable: true,
          checkout_url: "https://checkout.example.test/session_1",
        },
        discount: { discount_id: "discount_subscription" },
      });
    }
    if (url.pathname === "/v1/subscriptions") {
      return response({
        items: subscriptionCreated
          ? [
              {
                id: "subscription_1",
                status: "pending_checkout",
                product_key_snapshot: "cohub_pro_monthly",
              },
            ]
          : [],
        pagination: { has_more: false },
      });
    }
    if (url.pathname.startsWith("/v1/products/") && method === "GET") {
      const productKey = decodeURIComponent(
        url.pathname.split("/").at(-1) ?? "",
      );
      const found = products.find((item) => item.key === productKey);
      return found
        ? response({ product: found })
        : response({ error: { message: "Not found" } }, 404);
    }
    if (url.pathname === "/v1/discounts" && method === "GET") {
      discountListRequests += 1;
      return response({ items: discounts, pagination: { has_more: false } });
    }
    if (url.pathname === "/v1/customers/user_1/purchase-facts") {
      return response({
        checked_at: "2026-08-15T00:00:00.000Z",
        facts: {
          subscription_purchase: { exists: false },
          order_purchase: { exists: false },
        },
      });
    }
    if (url.pathname === "/v1/discounts/preview" && method === "POST") {
      const body = JSON.parse(String(init?.body)) as { discount_id: string };
      return body.discount_id === failingPreviewId
        ? response({ error: { message: "Preview unavailable" } }, 503)
        : response(preview(body.discount_id));
    }
    throw new Error(`Unexpected request: ${method} ${url}`);
  };

  try {
    const operations = createTalesofaiBillingOperations({
      baseUrl: "https://billing.example.test/v1",
      businessKey: "cohub",
      adminApiKey: "test-key",
    });
    const catalog = await operations.getCatalog({ userId: "user_1" });
    const pro = catalog.plans.find((item) => item.key === "cohub_pro_monthly");
    const max = catalog.plans.find((item) => item.key === "cohub_max_monthly");
    const small = catalog.addons.find(
      (item) => item.key === "cohub_credits_small",
    );
    const large = catalog.addons.find(
      (item) => item.key === "cohub_credits_large",
    );

    assert.ok(pro?.offer);
    assert.ok(max?.offer);
    assert.deepEqual(pro.promotion, {
      kind: "first_purchase",
      percentOff: 50,
      endsAt: null,
    });
    assert.deepEqual(small?.promotion, pro.promotion);
    assert.equal(pro.offer.ref.key, "cohub-first-subscription-v1");
    assert.equal(pro.offer.ref.revision, max.offer.ref.revision);
    assert.equal(pro.pricing.amountMinor, 2_000);
    assert.equal(pro.offer.pricing.paidAmountMinor, 1_000);
    assert.ok(small?.offer);
    assert.ok(large?.offer);
    assert.notEqual(small.offer.ref.key, large.offer.ref.key);
    assert.notEqual(small.offer.ref.revision, large.offer.ref.revision);

    failingPreviewId = "discount_large";
    const partiallyAvailableCatalog = await operations.getCatalog({
      userId: "user_1",
    });
    assert.ok(partiallyAvailableCatalog.plans.every((item) => item.offer));
    assert.ok(
      partiallyAvailableCatalog.addons.find(
        (item) => item.key === "cohub_credits_small",
      )?.offer,
    );
    assert.equal(
      partiallyAvailableCatalog.addons.find(
        (item) => item.key === "cohub_credits_large",
      )?.offer,
      null,
    );
    assert.equal(discountListRequests, 2);
    failingPreviewId = null;

    const anonymousCatalog = await operations.getCatalog();
    assert.ok(anonymousCatalog.products.every((item) => item.offer === null));
    assert.ok(
      anonymousCatalog.products.every(
        (item) => item.promotion?.kind === "first_purchase",
      ),
    );
    assert.equal(discountListRequests, 2);

    const checkout = await operations.createSubscription({
      userId: "user_1",
      productKey: pro.key,
      offer: pro.offer.ref,
      returnUrl: "https://cohub.example.test/settings/billing",
    });
    assert.equal(checkout.checkoutUsable, true);
    assert.equal(createdSubscriptionBody?.discount_id, "discount_subscription");
    assert.equal(createdSubscriptionBody?.discount_code, undefined);

    const retriedCheckout = await operations.createSubscription({
      userId: "user_1",
      productKey: pro.key,
      offer: pro.offer.ref,
      returnUrl: "https://cohub.example.test/settings/billing",
    });
    assert.equal(retriedCheckout.reused, true);
    assert.equal(subscriptionCreateRequests, 1);

    const addonCheckout = await operations.purchaseAddon({
      userId: "user_1",
      productKey: small.key,
      offer: small.offer.ref,
      returnUrl: "https://cohub.example.test/settings/billing",
    });
    const retriedAddonCheckout = await operations.purchaseAddon({
      userId: "user_1",
      productKey: small.key,
      offer: small.offer.ref,
      returnUrl: "https://cohub.example.test/settings/billing",
    });
    assert.equal(addonCheckout.checkoutUsable, true);
    assert.equal(retriedAddonCheckout.reused, true);
    assert.equal(orderCreateRequests, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("promotion code preview preserves Billing pricing and rejection reasons", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    if (url.pathname === "/v1/products/cohub_pro_monthly") {
      return response({ product: product("cohub_pro_monthly", "recurring") });
    }
    if (url.pathname === "/v1/customers" && method === "POST") {
      return response({ customer: { external_user_id: "user_1" } });
    }
    if (url.pathname === "/v1/discounts/preview" && method === "POST") {
      const body = JSON.parse(String(init?.body)) as { discount_code: string };
      if (body.discount_code === "HALF")
        return response(preview("discount_code"));
      return response({
        eligible: false,
        reason_code: "discount_not_found",
        message: "Promotion code not found",
      });
    }
    throw new Error(`Unexpected request: ${method} ${url}`);
  };

  try {
    const operations = createTalesofaiBillingOperations({
      baseUrl: "https://billing.example.test/v1",
      businessKey: "cohub",
      adminApiKey: "test-key",
    });
    const eligible = await operations.previewPromotionCode({
      userId: "user_1",
      productKey: "cohub_pro_monthly",
      promotionCode: " half ",
    });
    assert.equal(eligible.promotionCode, "HALF");
    assert.equal(eligible.eligible, true);
    assert.equal(eligible.pricing?.amountMinor, 2_000);
    assert.equal(eligible.pricing?.discountAmountMinor, 1_000);
    assert.equal(eligible.pricing?.paidAmountMinor, 1_000);

    const rejected = await operations.previewPromotionCode({
      userId: "user_1",
      productKey: "cohub_pro_monthly",
      promotionCode: "missing",
    });
    assert.equal(rejected.eligible, false);
    assert.equal(rejected.reasonCode, "discount_not_found");
    assert.equal(rejected.pricing, null);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("checkout confirmation reads provider order/subscription state", async () => {
  const originalFetch = globalThis.fetch;
  const products = [
    product("cohub_pro_monthly", "recurring"),
    product("cohub_credits_small", "one_time"),
  ];
  const subscriptions = [
    {
      id: "sub_live",
      status: "active",
      external_user_id: "user_1",
      product_key_snapshot: "cohub_pro_monthly",
    },
  ];
  const orders = [
    {
      id: "order_paid",
      status: "paid",
      external_user_id: "user_1",
      product_key_snapshot: "cohub_credits_small",
    },
  ];
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    if (url.pathname === "/v1/customers" && method === "POST") {
      return response({ customer: { external_user_id: "user_1" } });
    }
    if (url.pathname.startsWith("/v1/products/") && method === "GET") {
      const productKey = decodeURIComponent(url.pathname.split("/").at(-1) ?? "");
      const found = products.find((item) => item.key === productKey);
      return found
        ? response({ product: found })
        : response({ error: { message: "Not found" } }, 404);
    }
    if (url.pathname === "/v1/subscriptions/sub_live" && method === "GET") {
      return response({ subscription: subscriptions[0], checkout: { status: subscriptions[0]?.status, checkout_usable: subscriptions[0]?.status === "pending_checkout", checkout_url: "https://checkout.example.test/exact-subscription" } });
    }
    if (url.pathname === "/v1/orders/order_paid" && method === "GET") {
      return response({ order: orders[0] });
    }
    throw new Error(`Unexpected request: ${method} ${url}`);
  };
  try {
    const operations = createTalesofaiBillingOperations({
      baseUrl: "https://billing.example.test/v1",
      businessKey: "cohub",
      adminApiKey: "test-key",
    });
    const plan = await operations.resolveCheckoutConfirmation({
      userId: "user_1",
      productKey: "cohub_pro_monthly",
      checkoutId: "sub_live",
    });
    assert.equal(plan.settled, true);
    assert.equal(plan.status, "active");
    assert.equal(plan.productName, "cohub_pro_monthly");
    assert.ok(subscriptions[0]);
    subscriptions[0].status = "pending_checkout";
    const resumedPlan = await operations.resolveCheckoutConfirmation({ userId: "user_1", productKey: "cohub_pro_monthly", checkoutId: "sub_live" });
    assert.equal(resumedPlan.checkoutUrl, "https://checkout.example.test/exact-subscription");
    assert.equal(resumedPlan.settled, false);
    const pack = await operations.resolveCheckoutConfirmation({
      userId: "user_1",
      productKey: "cohub_credits_small",
      checkoutId: "order_paid",
    });
    assert.equal(pack.settled, true);
    assert.equal(pack.status, "paid");
    const missing = await operations.resolveCheckoutConfirmation({
      userId: "user_1",
      productKey: "cohub_nope",
      checkoutId: "missing",
    });
    assert.equal(missing.settled, false);
    assert.equal(missing.status, null);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("an identified purchase retries its exact key and return identity without adopting another pending order", async () => {
  const originalFetch = globalThis.fetch;
  const keys: string[] = [];
  const bodies: Record<string, unknown>[] = [];
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname === "/v1/orders" && init?.method !== "POST") return response({ items: [], pagination: { has_more: false } });
    if (url.pathname === "/v1/products/cohub_credits_small") return response({ product: product("cohub_credits_small", "one_time") });
    if (url.pathname === "/v1/customers") return response({ customer: { external_user_id: "user_1" } });
    if (url.pathname === "/v1/providers/status") return response({ status: "available", checkout_available: true });
    if (url.pathname === "/v1/orders" && init?.method === "POST") {
      keys.push(new Headers(init.headers).get("Idempotency-Key") ?? "");
      bodies.push(JSON.parse(String(init.body)));
      return response({ order: { id: "order_1", status: "pending_checkout" }, checkout: { checkout_usable: true, checkout_url: "https://checkout.example.test/original" } });
    }
    throw new Error(`Unexpected request: ${url}`);
  };
  try {
    const operations = createTalesofaiBillingOperations({ baseUrl: "https://billing.example.test/v1", businessKey: "cohub", adminApiKey: "test-key" });
    const input = { userId: "user_1", productKey: "cohub_credits_small", purchaseId: "66b87c53-d24f-4b7a-9ad2-8f07d07e188b", returnUrl: "https://cohub.example.test/settings/billing" };
    await operations.purchaseAddon(input);
    await operations.purchaseAddon(input);
    assert.equal(keys.length, 2);
    assert.ok(keys[0].includes(input.purchaseId));
    assert.equal(keys[0], keys[1]);
    assert.deepEqual(bodies[0], bodies[1]);
    assert.equal(new URL(String(bodies[0].success_redirect_url)).searchParams.get("cohub_billing_purchase"), input.purchaseId);
    await operations.purchaseAddon({ ...input, purchaseId: "f0847124-56e6-4f55-ac42-668c4d8eb788" });
    assert.notEqual(keys[0], keys[2]);
  } finally { globalThis.fetch = originalFetch; }
});

test("only a confirmed unpaid closed order can restart; unknown and conflict remain unresolved", async () => {
  const originalFetch = globalThis.fetch;
  let status = "pending_checkout";
  let checkoutState: string | null = null;
  let paidAt: string | null = null;
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    if (url.pathname === "/v1/customers") return response({ customer: { external_user_id: "user_1" } });
    if (url.pathname.startsWith("/v1/products/")) return response({ product: product("cohub_credits_small", "one_time") });
    if (url.pathname === "/v1/orders/order_1") {
      if (status === "unknown") return response({ error: { message: "Not found" } }, 404);
      return response({ order: { id: "order_1", external_user_id: "user_1", product_key_snapshot: "cohub_credits_small", status, paid_at: paidAt, payment_conflicted_at: status === "payment_conflicted" ? "2026-10-29T00:00:00Z" : null }, checkout: { status: checkoutState ?? status, checkout_usable: status === "pending_checkout", checkout_url: "https://checkout.example.test/original" } });
    }
    throw new Error(`Unexpected request: ${url}`);
  };
  try {
    const operations = createTalesofaiBillingOperations({ baseUrl: "https://billing.example.test/v1", businessKey: "cohub", adminApiKey: "test-key" });
    const inspect = () => operations.resolveCheckoutConfirmation({ userId: "user_1", productKey: "cohub_credits_small", checkoutId: "order_1" });
    assert.equal((await inspect()).checkoutUrl, "https://checkout.example.test/original");
    for (status of ["payment_conflicted", "unknown"]) assert.equal((await inspect()).canRestart, false);
    for (status of ["checkout_expired", "checkout_canceled"]) assert.equal((await inspect()).canRestart, true);
    checkoutState = "unknown";
    assert.equal((await inspect()).canRestart, false);
    checkoutState = null;
    paidAt = "2026-10-29T00:00:00Z";
    assert.equal((await inspect()).canRestart, false);
  } finally { globalThis.fetch = originalFetch; }
});

for (const kind of ["order", "subscription"] as const) {
  test(`${kind} lost create response resolves the original paid receipt before changed eligibility`, async () => {
    const originalFetch = globalThis.fetch;
    const path = kind === "order" ? "/v1/orders" : "/v1/subscriptions";
    const productKey = kind === "order" ? "cohub_credits_small" : "cohub_pro_monthly";
    let accepted: Record<string, unknown> | null = null;
    let creates = 0;
    let previews = 0;
    let duplicate = false;
    globalThis.fetch = async (input, init) => {
      const url = new URL(String(input));
      const method = init?.method ?? "GET";
      if (url.pathname === path && method === "GET") {
        if (url.searchParams.has("meta_contains")) {
          assert.equal(url.searchParams.get("external_user_id"), "user_1");
          return response({ items: accepted ? duplicate ? [accepted, accepted] : [accepted] : [], pagination: { has_more: false } });
        }
        if (accepted) throw new Error("A retry must resolve the original receipt before active-subscription admission");
        return response({ items: [], pagination: { has_more: false } });
      }
      if (url.pathname === `${path}/original`) return response({ [kind]: accepted, checkout: { checkout_usable: false, status: kind === "order" ? "paid" : "active" } });
      if (url.pathname === `/v1/products/${productKey}`) {
        if (accepted) throw new Error("A receipt cannot depend on the current catalog");
        return response({ product: product(productKey, kind === "order" ? "one_time" : "recurring") });
      }
      if (url.pathname === "/v1/customers") return response({ customer: { external_user_id: "user_1" } });
      if (url.pathname === "/v1/providers/status") return response({ status: "available", checkout_available: true });
      if (url.pathname === "/v1/discounts/preview") {
        previews++;
        if (accepted) return response({ eligible: false, reason_code: "discount_customer_limit_reached", message: "Already redeemed" });
        return response(preview("first_purchase"));
      }
      if (url.pathname === path && method === "POST") {
        creates++;
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        accepted = { id: "original", status: kind === "order" ? "paid" : "active", external_user_id: "user_1", product_key_snapshot: productKey, meta: body.meta };
        throw new TypeError("Connection closed after the server committed");
      }
      throw new Error(`Unexpected request: ${method} ${url.pathname}`);
    };
    try {
      const config = { baseUrl: "https://billing.example.test/v1", businessKey: "cohub", adminApiKey: "test-key" };
      const input = { userId: "user_1", productKey, purchaseId: "66b87c53-d24f-4b7a-9ad2-8f07d07e188b", promotionCode: "HALF", returnUrl: "https://cohub.example.test/settings/billing" };
      const first = createTalesofaiBillingOperations(config);
      const run = (operations: ReturnType<typeof createTalesofaiBillingOperations>, value = input) => kind === "order" ? operations.purchaseAddon(value) : operations.createSubscription(value);
      await assert.rejects(run(first), /Connection closed/);
      const next = createTalesofaiBillingOperations(config);
      const recovered = await run(next);
      assert.equal(recovered.orderId ?? recovered.subscriptionId, "original");
      assert.equal(recovered.reused, true);
      assert.equal(recovered.checkoutUsable, false);
      assert.equal(previews, 1);
      assert.equal(creates, 1);
      await assert.rejects(run(next, { ...input, promotionCode: "DIFFERENT" }), /intent differs/);
      duplicate = true;
      await assert.rejects(run(next), /identity is ambiguous/);
      assert.equal(creates, 1);
    } finally { globalThis.fetch = originalFetch; }
  });
}
