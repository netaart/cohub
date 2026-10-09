import assert from "node:assert/strict";
import { test } from "node:test";
import type { BillingResponsePayload } from "@cohub/billing";
import { formatChannelBillingBlockedMessage } from "./billing-blocked.js";

const billingPayload = (input: {
  title: string;
  message: string;
  label: string;
  href?: string;
}): BillingResponsePayload => ({
  status: "blocked",
  conversion: {
    level: "hard",
    reason: "minimum_balance_not_met",
    audience: "unknown",
    preferredOfferKind: "mixed",
    title: input.title,
    message: input.message,
    primaryAction: {
      label: input.label,
      action: "open_billing_conversion",
      ...(input.href ? { href: input.href } : {}),
    },
    source: "session_prompt",
  },
});

test("channel billing message preserves the conversion copy and action", () => {
  assert.equal(
    formatChannelBillingBlockedMessage(billingPayload({
      title: "Insufficient balance",
      message: "Video generation requires a balance of at least $1.01.",
      label: "Add credits",
      href: "https://cohub.live/settings/billing",
    })),
    "Insufficient balance\nVideo generation requires a balance of at least $1.01.\nAdd credits: https://cohub.live/settings/billing",
  );

  assert.equal(
    formatChannelBillingBlockedMessage(billingPayload({
      title: "Upgrade to continue",
      message: "This feature requires a higher plan.",
      label: "View plans",
    })),
    "Upgrade to continue\nThis feature requires a higher plan.\nView plans",
  );
});
