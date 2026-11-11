import { getCacheUserKey } from "$lib/cache/keys";

export const WALLET_RETURN_PARAMS = [
	"wallet_order",
	"wallet_space",
	"cohub_billing",
	"cohub_billing_product",
	"cohub_billing_purchase",
] as const;

export const FUND_INTENT_PARAM = "cohub_fund";

function requestKey(
	kind: "checkout" | "transfer",
	spaceId: string,
	ref: string,
) {
	return `cohub:wallet-${kind}:${getCacheUserKey()}:${spaceId}:${ref}`;
}

export function takeRequestId(
	kind: "checkout" | "transfer",
	spaceId: string,
	ref: string,
) {
	const key = requestKey(kind, spaceId, ref);
	try {
		const existing = sessionStorage.getItem(key);
		if (existing) return existing;
		const id = crypto.randomUUID();
		sessionStorage.setItem(key, id);
		return id;
	} catch {
		return crypto.randomUUID();
	}
}

export function clearRequestId(
	kind: "checkout" | "transfer",
	spaceId: string,
	ref: string,
) {
	try {
		sessionStorage.removeItem(requestKey(kind, spaceId, ref));
	} catch {}
}

export function clearCheckoutOrder(spaceId: string, orderId: string) {
	try {
		const prefix = requestKey("checkout", spaceId, "");
		for (let index = sessionStorage.length - 1; index >= 0; index--) {
			const key = sessionStorage.key(index);
			if (key?.startsWith(prefix) && sessionStorage.getItem(key) === orderId)
				sessionStorage.removeItem(key);
		}
	} catch {}
}

export function currentReturnPath() {
	const url = new URL(window.location.href);
	for (const param of [...WALLET_RETURN_PARAMS, FUND_INTENT_PARAM])
		url.searchParams.delete(param);
	return `${url.pathname}${url.search}`;
}

export const fundLink = (spaceId: string) =>
	new URL(`/spaces/${spaceId}/fund`, window.location.origin).toString();
