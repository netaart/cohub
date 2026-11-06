import type {
  BillingCatalogProduct,
  BillingCheckoutResult,
  SpaceWalletActivityPage,
  SpaceWalletFunding,
  SpaceWalletSummary,
  SpaceWalletTransferStatus,
} from "../types.js";
import type { HttpTransport } from "../transport.js";

export class SpaceWalletApi {
  constructor(private readonly transport: HttpTransport, private readonly spaceId: string) {}

  get() {
    return this.transport.request<SpaceWalletSummary>(`/api/spaces/${this.spaceId}/wallet`);
  }

  catalog() {
    return this.transport.request<{ supported: boolean; paymentAvailable: boolean; products: BillingCatalogProduct[] }>(`/api/spaces/${this.spaceId}/wallet/catalog`);
  }

  funding() {
    return this.transport.request<SpaceWalletFunding>(`/api/spaces/${this.spaceId}/wallet/funding`);
  }

  activities(page = 1) {
    return this.transport.request<SpaceWalletActivityPage>(`/api/spaces/${this.spaceId}/wallet/activities?page=${page}`);
  }

  createOrder(input: { id: string; productKey: string; returnPath?: string }) {
    return this.transport.request<{ checkout: BillingCheckoutResult; orderId: string }>(`/api/spaces/${this.spaceId}/wallet/orders`, {
      method: "POST", body: JSON.stringify(input),
    });
  }

  confirmOrder(orderId: string) {
    return this.transport.request<{ settled: boolean; pending: boolean }>(`/api/spaces/${this.spaceId}/wallet/orders/${encodeURIComponent(orderId)}`);
  }

  transfer(input: { id: string; amountUsd: number }) {
    return this.transport.request<SpaceWalletTransferStatus>(`/api/spaces/${this.spaceId}/wallet/transfers`, {
      method: "POST", body: JSON.stringify(input),
    });
  }

  getTransfer(id: string) {
    return this.transport.request<SpaceWalletTransferStatus>(`/api/spaces/${this.spaceId}/wallet/transfers/${encodeURIComponent(id)}`);
  }
}
