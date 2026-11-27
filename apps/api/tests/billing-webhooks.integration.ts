import assert from "node:assert/strict";
import { mock, test } from "node:test";
import { BillingConfigurationError, BillingWebhookVerificationError, type BillingWebhookEvent } from "@cohub/billing";

process.env.LOG_LEVEL = "silent";

let parse: () => Promise<BillingWebhookEvent> = async () => ({ id: "evt", type: "order.paid", payment: null });
let qualify: (payment: { userId: string; paidAt: Date }) => Promise<unknown> = async () => null;
const qualified: Array<{ userId: string; paidAt: Date }> = [];

mock.module("@cohub/billing", {
  namedExports: {
    BillingConfigurationError,
    BillingWebhookVerificationError,
    parseBillingWebhook: () => parse(),
  },
});
mock.module("../src/referrals.js", {
  namedExports: {
    qualifyReferralPayment: async (payment: { userId: string; paidAt: Date }) => {
      await qualify(payment);
      qualified.push(payment);
    },
  },
});

const { default: router } = await import("../src/routes/billing-webhooks.route.js");
const deliver = () => router.request("/", { method: "POST", body: "{}" });
const reject = (error: Error) => () => Promise.reject(error);

test("verification failures are retried or rejected, unknown events are acknowledged", async () => {
  parse = reject(new BillingConfigurationError("Billing webhooks are not configured"));
  assert.equal((await deliver()).status, 503);
  parse = reject(new BillingWebhookVerificationError("invalid_signing_secret"));
  assert.equal((await deliver()).status, 503);
  parse = reject(new BillingWebhookVerificationError("signature_verification_failed"));
  assert.equal((await deliver()).status, 400);
  parse = reject(new BillingWebhookVerificationError("unsupported_event_type"));
  assert.equal((await deliver()).status, 204);
  assert.equal(qualified.length, 0);
});

test("payments are acknowledged only after qualification persists", async () => {
  const payment = { userId: "user-1", paidAt: new Date() };
  parse = async () => ({ id: "evt", type: "order.paid", payment });

  qualify = () => Promise.reject(new Error("database unavailable"));
  assert.equal((await deliver()).status, 500);
  assert.equal(qualified.length, 0);

  qualify = async () => null;
  assert.equal((await deliver()).status, 204);
  assert.deepEqual(qualified, [payment]);
});
