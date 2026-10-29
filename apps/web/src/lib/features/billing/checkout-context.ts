export type CheckoutContext = {
	purchaseId: string;
	userId: string;
	productKey: string;
	checkoutId: string | null;
	request: {
		returnUrl: string;
		promotionCode?: string;
		offer?: { key: string; revision: string };
	};
};

const prefix = "cohub:billing:purchase:";
export type RenewalPurchaseIntent = {
	subscriptionId: string;
	productKey: string;
};
const renewalKey = (userId: string) => `${prefix}renewal:${userId}`;

export function readRenewalPurchaseIntent(
	userId: string,
): RenewalPurchaseIntent | null {
	try {
		const raw = sessionStorage.getItem(renewalKey(userId));
		const value = raw ? (JSON.parse(raw) as RenewalPurchaseIntent) : null;
		return value &&
			typeof value.subscriptionId === "string" &&
			typeof value.productKey === "string"
			? value
			: null;
	} catch {
		return null;
	}
}

export function saveRenewalPurchaseIntent(
	userId: string,
	intent: RenewalPurchaseIntent | null,
) {
	try {
		if (intent)
			sessionStorage.setItem(renewalKey(userId), JSON.stringify(intent));
		else sessionStorage.removeItem(renewalKey(userId));
	} catch {
		/* The current page still retains its closing intent. */
	}
}
const currentKey = (userId: string, productKey: string) =>
	`${prefix}current:${userId}:${productKey}`;

export function readCheckoutContext(
	userId: string,
	purchaseId: string,
): CheckoutContext | null {
	try {
		const raw = sessionStorage.getItem(`${prefix}${purchaseId}`);
		const value = raw ? (JSON.parse(raw) as CheckoutContext) : null;
		return value?.userId === userId && value.purchaseId === purchaseId
			? value
			: null;
	} catch {
		return null;
	}
}

export function currentCheckoutContext(
	userId: string,
	productKey: string,
): CheckoutContext | null {
	try {
		const id = sessionStorage.getItem(currentKey(userId, productKey));
		return id ? readCheckoutContext(userId, id) : null;
	} catch {
		return null;
	}
}

export function saveCheckoutContext(context: CheckoutContext) {
	try {
		sessionStorage.setItem(
			`${prefix}${context.purchaseId}`,
			JSON.stringify(context),
		);
		sessionStorage.setItem(
			currentKey(context.userId, context.productKey),
			context.purchaseId,
		);
	} catch {
		/* An in-memory controller still retains the same request key. */
	}
}

export function finishCheckoutContext(context: CheckoutContext) {
	try {
		const key = currentKey(context.userId, context.productKey);
		if (sessionStorage.getItem(key) === context.purchaseId)
			sessionStorage.removeItem(key);
		// Keep the exact receipt identity for an older return in this tab.
	} catch {
		/* Storage is optional. */
	}
}
