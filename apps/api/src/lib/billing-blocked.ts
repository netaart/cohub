import type { Context } from "hono";
import { serializeBillingBlocked, type BillingAccessBlockedError, type BillingResponsePayload } from "@cohub/billing";
import { config } from "../config.js";

export const billingConversionUrl = () => {
  const origin = (config.webOrigin ?? (config.env === "prod" ? "https://cohub.live" : "https://dev.cohub.live")).replace(/\/+$/, "");
  return `${origin}/settings/billing`;
};

export const serializeChannelBillingBlocked = (error: BillingAccessBlockedError): BillingResponsePayload =>
  serializeBillingBlocked(error, { actionUrl: billingConversionUrl() }).billing;

export const formatChannelBillingBlockedMessage = (billing: BillingResponsePayload) => {
  const { title, message, primaryAction } = billing.conversion;
  const copy = [title.trim(), message.trim()].filter(Boolean);
  const action = primaryAction.href
    ? `${primaryAction.label}: ${primaryAction.href}`
    : primaryAction.label;
  return [...new Set(copy.length > 0 ? copy : ["This request cannot continue."]), action]
    .filter(Boolean)
    .join("\n");
};

/** Standard 402 response for a blocked usage gate (negative balance limit). */
export function billingBlockedResponse(c: Context, error: BillingAccessBlockedError) {
  return c.json(serializeBillingBlocked(error, { actionUrl: billingConversionUrl() }), 402);
}
