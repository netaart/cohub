import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import {
  BillingConfigurationError,
  BillingWebhookVerificationError,
  parseBillingWebhook,
  type BillingWebhookEvent,
} from "@cohub/billing";
import { qualifyReferralPayment } from "../referrals.js";

const router = new Hono();

/** Billing caps payloads at 8 KiB; leave headroom without accepting arbitrary bodies. */
const BILLING_WEBHOOK_MAX_BYTES = 32 * 1024;

/**
 * Outbound webhooks from Talesofai Billing, verified by signature (no user auth).
 * Non-2xx responses make billing redeliver, so only verified, persisted events are acknowledged.
 */
router.post(
  "/",
  bodyLimit({
    maxSize: BILLING_WEBHOOK_MAX_BYTES,
    onError: (c) => c.json({ message: `webhook body exceeds ${BILLING_WEBHOOK_MAX_BYTES} bytes` }, 413),
  }),
  async (c) => {
    let event: BillingWebhookEvent;
    try {
      event = await parseBillingWebhook({ rawBody: new Uint8Array(await c.req.arrayBuffer()), headers: c.req.raw.headers });
    } catch (error) {
      if (error instanceof BillingConfigurationError) return c.json({ message: error.message }, 503);
      if (error instanceof BillingWebhookVerificationError) {
        if (error.code === "unsupported_event_type") return c.body(null, 204);
        if (error.code === "invalid_signing_secret") return c.json({ message: "billing webhook secret is invalid" }, 503);
        return c.json({ message: error.message, code: error.code }, 400);
      }
      throw error;
    }
    if (event.payment) await qualifyReferralPayment(event.payment);
    return c.body(null, 204);
  },
);

export default router;
