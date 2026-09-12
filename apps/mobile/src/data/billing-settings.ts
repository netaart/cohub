import type { BillingSubscriptionHistoryStatus, CohubClient } from "@neta-art/cohub";

export function subscriptionCheckoutUrl(subscription: BillingSubscriptionHistoryStatus, now: number): string | null {
  if (!subscription.actions.canPay || !subscription.actions.checkoutUsable) return null;
  if (subscription.checkoutExpiresAt && Date.parse(subscription.checkoutExpiresAt) <= now) return null;
  return subscription.actions.checkoutUrl;
}

export async function redeemBillingCode(client: CohubClient, value: string): Promise<string | null> {
  const code = value.trim();
  if (!code) throw new Error("Enter a redemption code.");
  const { redemption } = await client.billing.createRedemption({ code });
  if (!redemption.redeemed) throw new Error(redemption.message || "This code could not be redeemed.");
  return redemption.message;
}
