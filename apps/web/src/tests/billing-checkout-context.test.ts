import assert from "node:assert/strict";
import { test } from "node:test";
import {
	type CheckoutContext,
	currentCheckoutContext,
	finishCheckoutContext,
	readCheckoutContext,
	readRenewalPurchaseIntent,
	saveCheckoutContext,
	saveRenewalPurchaseIntent,
} from "../lib/features/billing/checkout-context";
import {
	readCheckoutReturn,
	stripCheckoutReturn,
} from "../lib/features/billing/checkout-return";

test("checkout receipts remain scoped to their purchase and user when newer purchases or other windows exist", () => {
	const previous = Object.getOwnPropertyDescriptor(
		globalThis,
		"sessionStorage",
	);
	const data = new Map<string, string>();
	Object.defineProperty(globalThis, "sessionStorage", {
		configurable: true,
		value: {
			getItem: (key: string) => data.get(key) ?? null,
			setItem: (key: string, value: string) => data.set(key, value),
			removeItem: (key: string) => data.delete(key),
		},
	});
	try {
		const old: CheckoutContext = {
			purchaseId: "purchase-old",
			userId: "user",
			productKey: "pack",
			checkoutId: "order-old",
			request: { returnUrl: "https://cohub.test/settings/billing" },
		};
		const next = {
			...old,
			purchaseId: "purchase-new",
			checkoutId: "order-new",
		};
		saveCheckoutContext(old);
		saveCheckoutContext(next);
		const returned = readCheckoutReturn(
			new URL(
				"https://cohub.test/settings/billing?cohub_billing=success&cohub_billing_product=pack&cohub_billing_purchase=purchase-old",
			),
		);
		assert.equal(
			readCheckoutContext("user", returned?.purchaseId ?? "")?.checkoutId,
			"order-old",
		);
		finishCheckoutContext(old);
		assert.equal(
			currentCheckoutContext("user", "pack")?.checkoutId,
			"order-new",
		);
		assert.equal(readCheckoutContext("other", "purchase-old"), null);
		saveRenewalPurchaseIntent("user", {
			subscriptionId: "old-subscription",
			productKey: "plan",
		});
		assert.equal(
			readRenewalPurchaseIntent("user")?.subscriptionId,
			"old-subscription",
		);
		assert.equal(readRenewalPurchaseIntent("other"), null);
		data.clear(); // A different window has its own sessionStorage.
		assert.equal(readCheckoutContext("user", "purchase-old"), null);
		assert.equal(readRenewalPurchaseIntent("user"), null);
		assert.equal(
			stripCheckoutReturn(
				new URL(
					"https://cohub.test/?cohub_billing=success&cohub_billing_purchase=old",
				),
			).search,
			"",
		);
	} finally {
		if (previous) Object.defineProperty(globalThis, "sessionStorage", previous);
		else Reflect.deleteProperty(globalThis, "sessionStorage");
	}
});
