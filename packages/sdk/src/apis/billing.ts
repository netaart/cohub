import type {
  BillingBalanceActivityList,
  BillingCatalog,
  BillingCheckoutConfirmation,
  BillingCheckoutResult,
  BillingCreditStatus,
  BillingDiscountOfferRef,
  BillingPromotionCodePreview,
  BillingRedemptionResult,
  BillingSubscriptionHistoryList,
  BillingSubscriptionHistoryStatus,
} from "../types.js";
import type { HttpTransport } from "../transport.js";

export class BillingApi {
  constructor(private readonly transport: HttpTransport) {}

  async getCredits(input?: { tokenType?: string }) {
    const query = input?.tokenType
      ? `?tokenType=${encodeURIComponent(input.tokenType)}`
      : "";
    return this.transport.request<BillingCreditStatus>(
      `/api/billing/credits${query}`,
    );
  }

  async getBalanceActivities(input?: { tokenType?: string; page?: number; limit?: number }) {
    const params = new URLSearchParams();
    if (input?.tokenType) params.set("tokenType", input.tokenType);
    if (input?.page) params.set("page", String(input.page));
    if (input?.limit) params.set("limit", String(input.limit));
    const query = params.toString();
    return this.transport.request<{ activities: BillingBalanceActivityList }>(
      `/api/billing/balance-activities${query ? `?${query}` : ""}`,
    );
  }

  async getCatalog() {
    return this.transport.request<{ catalog: BillingCatalog }>(
      "/api/billing/catalog",
    );
  }

  async getFeatureEntitlement(featureKey: string) {
    return this.transport.request<{ enabled: boolean; validUntil: string | null }>(
      `/api/billing/features/${encodeURIComponent(featureKey)}`,
    );
  }

  async getSubscriptions(input?: { page?: number; limit?: number }) {
    const params = new URLSearchParams();
    if (input?.page) params.set("page", String(input.page));
    if (input?.limit) params.set("limit", String(input.limit));
    const query = params.toString();
    return this.transport.request<{ subscriptions: BillingSubscriptionHistoryList }>(
      `/api/billing/subscriptions${query ? `?${query}` : ""}`,
    );
  }

  /** Confirms a returned checkout against the provider's order/subscription state. */
  async confirmCheckout(productKey: string, checkoutId: string) {
    return this.transport.request<{ confirmation: BillingCheckoutConfirmation }>(
      "/api/billing/checkout-confirmation",
      { method: "POST", body: JSON.stringify({ productKey, checkoutId }) },
    );
  }

  async previewPromotionCode(input: { productKey: string; promotionCode: string }) {
    return this.transport.request<{ preview: BillingPromotionCodePreview }>(
      "/api/billing/promotion-code-preview",
      { method: "POST", body: JSON.stringify(input) },
    );
  }

  async createOrder(productKey: string, input?: {
    purchaseId?: string;
    returnUrl?: string;
    promotionCode?: string;
    offer?: BillingDiscountOfferRef;
  }) {
    return this.transport.request<{ checkout: BillingCheckoutResult }>(
      "/api/billing/orders",
      {
        method: "POST",
        body: JSON.stringify({ ...(input ?? {}), productKey }),
      },
    );
  }

  async createSubscription(productKey: string, input?: {
    purchaseId?: string;
    returnUrl?: string;
    promotionCode?: string;
    offer?: BillingDiscountOfferRef;
  }) {
    return this.transport.request<{ checkout: BillingCheckoutResult }>(
      "/api/billing/subscriptions",
      {
        method: "POST",
        body: JSON.stringify({ ...(input ?? {}), productKey }),
      },
    );
  }

  async cancelSubscriptionCheckout(subscriptionId: string) {
    return this.transport.request<{ subscription: BillingSubscriptionHistoryStatus }>(
      `/api/billing/subscriptions/${encodeURIComponent(subscriptionId)}/checkout`,
      { method: "DELETE" },
    );
  }

  async getSubscription(subscriptionId: string) {
    return this.transport.request<{ subscription: BillingSubscriptionHistoryStatus }>(
      `/api/billing/subscriptions/${encodeURIComponent(subscriptionId)}`,
    );
  }

  async getSubscriptionPaymentAction(subscriptionId: string) {
    return this.transport.request<{ checkoutUrl: string | null; reason: string | null }>(
      `/api/billing/subscriptions/${encodeURIComponent(subscriptionId)}/payment-action`,
      { method: "POST" },
    );
  }

  async cancelSubscriptionAutoRenew(subscriptionId: string) {
    return this.transport.request<{ subscription: BillingSubscriptionHistoryStatus }>(
      `/api/billing/subscriptions/${encodeURIComponent(subscriptionId)}`,
      {
        method: "PATCH",
        body: JSON.stringify({ cancelAtPeriodEnd: true }),
      },
    );
  }

  async createRedemption(input: { code: string }) {
    return this.transport.request<{ redemption: BillingRedemptionResult }>(
      "/api/billing/redemptions",
      {
        method: "POST",
        body: JSON.stringify(input),
      },
    );
  }
}
