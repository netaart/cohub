import type { AppRuntimeCheckoutState } from "./app-runtime.js";

export function readAppCheckoutState(url: { searchParams: Pick<URLSearchParams, "get"> }): AppRuntimeCheckoutState {
  const value = url.searchParams.get("cohub_checkout");
  const status = value === "success" || value === "failed" || value === "cancel" ? value : null;
  return { status, orderId: url.searchParams.get("cohub_order")?.trim() || null };
}

export const pendingPurchaseKey = (appId: string) => `cohub-app-purchase:${appId}`;

export function readPendingOrderId(appId: string): string | null {
  try {
    const raw = sessionStorage.getItem(pendingPurchaseKey(appId));
    const pending = raw && JSON.parse(raw);
    return typeof pending?.orderId === "string" && typeof pending.productKey === "string" && typeof pending.at === "number"
      ? pending.orderId : null;
  } catch {
    return null;
  }
}
