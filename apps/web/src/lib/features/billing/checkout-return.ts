/** Redirect parameters identify a purchase; only a fresh server query confirms payment. */

export type CheckoutOutcome = "success" | "failed" | "cancel";

export const CHECKOUT_PARAM = "cohub_billing";
export const CHECKOUT_PURCHASE_PARAM = "cohub_billing_purchase";

export const CHECKOUT_PRODUCT_PARAM = "cohub_billing_product";

export type CheckoutReturn = {
	outcome: CheckoutOutcome;
	productKey: string | null;
	purchaseId: string | null;
};

/** Base URL the payment page should send the user back to. */
export function checkoutReturnUrl(base: string | URL): string {
	const url = new URL(base);
	url.searchParams.delete(CHECKOUT_PARAM);
	url.searchParams.delete(CHECKOUT_PRODUCT_PARAM);
	url.searchParams.delete(CHECKOUT_PURCHASE_PARAM);
	url.hash = "";
	return url.toString();
}

export function readCheckoutReturn(url: URL): CheckoutReturn | null {
	const outcome = url.searchParams.get(CHECKOUT_PARAM);
	if (outcome !== "success" && outcome !== "failed" && outcome !== "cancel") {
		return null;
	}
	return {
		outcome,
		productKey: url.searchParams.get(CHECKOUT_PRODUCT_PARAM)?.trim() || null,
		purchaseId: url.searchParams.get(CHECKOUT_PURCHASE_PARAM)?.trim() || null,
	};
}

/** The same URL with the round-trip parameters removed. */
export function stripCheckoutReturn(url: URL): URL {
	const next = new URL(url);
	next.searchParams.delete(CHECKOUT_PARAM);
	next.searchParams.delete(CHECKOUT_PRODUCT_PARAM);
	next.searchParams.delete(CHECKOUT_PURCHASE_PARAM);
	return next;
}
