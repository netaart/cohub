import type { HttpTransport } from "../transport.js";
import type { SpaceCommerceProduct } from "../types.js";

export type AppCommerceEntitlement = {
  benefitKey: string;
  enabled: boolean;
  metadata: Record<string, string | number | boolean>;
};

export type AppCommerceEntitlementsResponse = {
  entitlements: AppCommerceEntitlement[];
  credits: {
    available: number;
    net: number;
  };
  businessKey: string;
};

export type AppCommerceCheckoutStatus = "success" | "failed" | "cancel" | null;

export type AppCommerceProductResolveResponse = {
  products: SpaceCommerceProduct[];
};

export type AppCommerceCreditConsumeStatus = "consumed" | "insufficient" | "disabled";

export type AppCommerceCreditConsumeResponse = {
  status: AppCommerceCreditConsumeStatus;
  amount: number;
  remaining: number;
  shortfall: number | null;
  businessKey: string;
};

export type AppCommercePurchaseInput = { productKey: string; purchaseAttemptId?: string; returnUrl?: string };

export type AppCommercePurchaseResponse = {
  checkout: {
    providerKey: string | null;
    checkoutUrl: string | null;
    checkoutUsable: boolean;
    status: string | null;
    message: string | null;
    orderId: string;
    productKey: string;
    value: number | null;
    currency: string | null;
  };
};

export type AppCommerceOrder = {
  id: string;
  productKeySnapshot: string;
  productNameSnapshot: string;
  status: string;
  amountSnapshot: number;
  paidAmountSnapshot: number;
  createdAt: string;
  paidAt: string | null;
  buyerProfile: import("../types.js").SpaceCommerceBuyerProfile | null;
};

export class AppCommerceApi {
  constructor(private readonly transport: HttpTransport) {}

  resolveProducts(appId: string, input: { productKeys: string[] }) {
    return this.transport.request<AppCommerceProductResolveResponse>(
      `/api/apps/${encodeURIComponent(appId)}/commerce/products/resolve`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
      },
    );
  }

  getEntitlements(appId: string) {
    return this.transport.request<AppCommerceEntitlementsResponse>(
      `/api/apps/${encodeURIComponent(appId)}/commerce/entitlements`,
    );
  }

  consumeCredits(appId: string, input: { amount: number; operationId: string; reason?: string }) {
    return this.transport.request<AppCommerceCreditConsumeResponse>(
      `/api/apps/${encodeURIComponent(appId)}/commerce/credits/consume`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
      },
    );
  }

  purchase(appId: string, input: AppCommercePurchaseInput) {
    return this.transport.request<AppCommercePurchaseResponse>(
      `/api/apps/${encodeURIComponent(appId)}/commerce/purchase`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
      },
    );
  }

  getOrder(appId: string, orderId: string) {
    return this.transport.request<{ order: AppCommerceOrder }>(
      `/api/apps/${encodeURIComponent(appId)}/commerce/orders/${encodeURIComponent(orderId)}`,
    );
  }
}

// ── Legacy aliases ────────────────────────────────────────────────────────────

/** @deprecated Use `AppCommerceEntitlement`. */
export type WorkCommerceEntitlement = AppCommerceEntitlement;
/** @deprecated Use `AppCommerceEntitlementsResponse`. */
export type WorkCommerceEntitlementsResponse = AppCommerceEntitlementsResponse;
/** @deprecated Use `AppCommerceCheckoutStatus`. */
export type WorkCommerceCheckoutStatus = AppCommerceCheckoutStatus;
/** @deprecated Use `AppCommerceProductResolveResponse`. */
export type WorkCommerceProductResolveResponse = AppCommerceProductResolveResponse;
/** @deprecated Use `AppCommerceCreditConsumeStatus`. */
export type WorkCommerceCreditConsumeStatus = AppCommerceCreditConsumeStatus;
/** @deprecated Use `AppCommerceCreditConsumeResponse`. */
export type WorkCommerceCreditConsumeResponse = AppCommerceCreditConsumeResponse;
/** @deprecated Use `AppCommercePurchaseResponse`. */
export type WorkCommercePurchaseResponse = AppCommercePurchaseResponse;
/** @deprecated Use `AppCommerceApi`. */
export class WorkCommerceApi extends AppCommerceApi {}

/** @deprecated Use `AppCommerceOrder`. */
export type WorkCommerceOrder = AppCommerceOrder;
