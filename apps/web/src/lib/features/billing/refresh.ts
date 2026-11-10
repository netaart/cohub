const BILLING_CHANGED = "cohub:billing-refresh";

export function announceBillingChange() {
	window.dispatchEvent(new Event(BILLING_CHANGED));
}

export function onBillingChange(listener: () => void) {
	window.addEventListener(BILLING_CHANGED, listener);
	return () => window.removeEventListener(BILLING_CHANGED, listener);
}
