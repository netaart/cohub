import assert from "node:assert/strict";
import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { test } from "node:test";
import { BillingWebhookVerificationError, configureBillingRuntime, parseBillingWebhook } from "../../src/index.js";

const key = randomBytes(32);
const secret = `whsec_${key.toString("base64")}`;
const paidAt = "2026-11-26T08:00:00.000Z";

configureBillingRuntime({
  config: {
    talesofaiBillingBaseUrl: "https://billing.test/v1",
    talesofaiBillingBusinessKey: "cohub",
    talesofaiBillingAdminApiKey: "admin",
    talesofaiBillingWebhookSecret: secret,
  },
});

const product = { id: randomUUID(), key: "addon_10", name: "Credits" };
const envelope = (type: string, resource: "order" | "subscription", data: object, businessKey = "cohub") => ({
  id: randomUUID(),
  type,
  api_version: "2026-08-21",
  timestamp: paidAt,
  environment: "test",
  business: { id: randomUUID(), key: businessKey },
  customer: { id: randomUUID(), external_user_id: "user-1" },
  resource: { type: resource, id: (data as { object: { id: string } }).object.id, version: null },
  data,
});

const orderPaid = (overrides: { paid?: number; source?: string; reason?: string; businessKey?: string } = {}) =>
  envelope(
    "order.paid",
    "order",
    {
      object: {
        id: randomUUID(),
        status: "paid",
        product,
        amount_snapshot: 1000,
        discount_amount_snapshot: 1000 - (overrides.paid ?? 1000),
        paid_amount_snapshot: overrides.paid ?? 1000,
        currency_snapshot: "USD",
        paid_at: paidAt,
        billing_reason: overrides.reason ?? "purchase",
        fulfillment_source: overrides.source ?? "checkout",
      },
    },
    overrides.businessKey,
  );

const subscriptionActivated = (overrides: { paid?: number; source?: string } = {}) => {
  const period = { start: paidAt, end: "2026-12-26T08:00:00.000Z" };
  return envelope("subscription.activated", "subscription", {
    object: {
      id: randomUUID(),
      status: "active",
      product,
      amount_snapshot: 2000,
      discount_amount_snapshot: 0,
      paid_amount_snapshot: 2000,
      currency_snapshot: "USD",
      billing_period_snapshot: "month",
      billing_interval_count_snapshot: 1,
      renewal_mode: "automatic",
      cancel_at_period_end: false,
      current_period_start: period.start,
      current_period_end: period.end,
      canceled_at: null,
      ended_at: null,
    },
    paid_period: {
      id: randomUUID(),
      period_start: period.start,
      period_end: period.end,
      paid_at: paidAt,
      billing_cycle_number: 1,
      amount_snapshot: 2000,
      discount_amount_snapshot: 2000 - (overrides.paid ?? 2000),
      paid_amount_snapshot: overrides.paid ?? 2000,
      currency: "USD",
      fulfillment_source: overrides.source ?? "provider",
    },
  });
};

const deliver = (event: { id: string }, signingKey = key) => {
  const rawBody = JSON.stringify(event);
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = createHmac("sha256", signingKey).update(`${event.id}.${timestamp}.${rawBody}`).digest("base64");
  const headers = new Headers({ "webhook-id": event.id, "webhook-timestamp": timestamp, "webhook-signature": `v1,${signature}` });
  return parseBillingWebhook({ rawBody: new TextEncoder().encode(rawBody), headers });
};

test("real payments carry the payer and payment time", async () => {
  for (const event of [
    orderPaid(),
    orderPaid({ source: "provider_payment" }),
    orderPaid({ reason: "subscription_create" }),
    orderPaid({ reason: "subscription_cycle" }),
    subscriptionActivated(),
  ]) {
    const parsed = await deliver(event);
    assert.equal(parsed.id, event.id);
    assert.deepEqual(parsed.payment, { userId: "user-1", paidAt: new Date(paidAt) });
  }
});

test("redemptions, manual grants, free charges and other businesses are not payments", async () => {
  for (const event of [
    orderPaid({ source: "redemption" }),
    orderPaid({ source: "manual" }),
    orderPaid({ paid: 0 }),
    orderPaid({ businessKey: "cohub-space-wallet" }),
    subscriptionActivated({ source: "redemption" }),
    subscriptionActivated({ source: "manual" }),
    subscriptionActivated({ paid: 0 }),
  ]) {
    assert.equal((await deliver(event)).payment, null);
  }
});

test("rejects deliveries signed with another secret", async () => {
  await assert.rejects(
    deliver(orderPaid(), randomBytes(32)),
    (error) => error instanceof BillingWebhookVerificationError && error.code === "signature_verification_failed",
  );
});
