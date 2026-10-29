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

test("plan summaries keep grace and closing on the paid plan, then follow the confirmed result", async () => {
	const { currentCatalogSubscription, subscriptionDisplayState } = await import(
		"../lib/features/billing/product"
	);
	const paid = {
		id: "paid",
		productKey: "pro",
		productName: "Pro",
		status: "past_due",
		currentPeriodStart: null,
		currentPeriodEnd: null,
		cancelAtPeriodEnd: false,
		renewalRecovery: {
			state: "grace" as const,
			effectiveEndsAt: "2026-11-01T00:00:00Z",
			payInvoice: { allowed: true, reason: null },
			endRecovery: { allowed: true, reason: null },
			subscribe: { allowed: false, reason: "occupied" },
		},
	};
	const free = {
		...paid,
		id: "free",
		productKey: "free",
		status: "active",
		renewalRecovery: undefined,
	};
	const catalog = {
		currentSubscriptions: [free, paid],
		defaultPlanProductKey: "free",
	};
	const before = Date.parse("2026-10-31T00:00:00Z");
	const deadline = Date.parse("2026-11-01T00:00:00Z");
	assert.equal(currentCatalogSubscription(catalog, before)?.id, "paid");
	assert.equal(subscriptionDisplayState(paid, before), "grace");
	assert.equal(currentCatalogSubscription(catalog, deadline)?.id, "paid");
	assert.equal(subscriptionDisplayState(paid, deadline), "closing");
	assert.equal(
		subscriptionDisplayState(
			{
				...paid,
				renewalRecovery: { ...paid.renewalRecovery, state: "closing" },
			},
			before,
		),
		"closing",
	);
	const recovered = {
		...paid,
		id: "recovered",
		status: "active",
		renewalRecovery: { ...paid.renewalRecovery, state: "none" as const },
	};
	assert.equal(
		currentCatalogSubscription(
			{ ...catalog, currentSubscriptions: [free, paid, recovered] },
			before,
		)?.id,
		"recovered",
	);
	assert.equal(subscriptionDisplayState(recovered, before), "active");
	assert.equal(
		currentCatalogSubscription(
			{
				...catalog,
				currentSubscriptions: [
					free,
					{ ...paid, status: "ended", renewalRecovery: undefined },
				],
			},
			before,
		)?.id,
		"free",
	);
	assert.equal(
		subscriptionDisplayState({ ...paid, renewalRecovery: undefined }, before),
		null,
	);
});

test("subscription processing keeps an explicit independent credits purchase intent", async () => {
	const { purchaseFocus } = await import("../lib/features/billing/product");
	const product: Parameters<typeof purchaseFocus>[0]["monthlyPlans"][number] = {
		id: "plan",
		key: "pro",
		name: "Pro",
		description: null,
		status: "active",
		visibility: "public",
		billingType: "recurring",
		billingPeriod: "monthly",
		billingIntervalCount: 1,
		currency: "USD",
		kind: "plan",
		interval: "monthly",
		pricing: {
			amountMinor: 100,
			amountUsd: 1,
			compareAtAmountMinor: null,
			compareAtAmountUsd: null,
			discountLabel: null,
			discountRate: null,
		},
		promotion: null,
		offer: null,
		display: {
			description: null,
			benefits: [],
			creditsAmount: null,
			validity: null,
			creditBenefits: [],
		},
		isDefaultPlan: false,
	};
	const view: Parameters<typeof purchaseFocus>[0] = {
		hasPaidPlan: true,
		packs: [
			{ ...product, key: "credits", kind: "addon", interval: "one_time" },
		],
		monthlyPlans: [product],
		yearlyPlans: [],
	};
	assert.equal(purchaseFocus(view), "packs");
	assert.equal(purchaseFocus(view, null, true), "plans");
	assert.equal(
		purchaseFocus(view, { preferredOfferKind: "addon" }, true),
		"packs",
	);
	assert.equal(
		purchaseFocus(view, { preferredOfferKind: "plan" }, true),
		"plans",
	);
});

test("renewal loads preserve Credits selection and reconcile a Provider-unresolved action", async () => {
	const { readFileSync } = await import("node:fs");
	const { registerHooks } = await import("node:module");
	const ts = await import("typescript");
	const { compileModule } = await import("svelte/compiler");
	const filename = new URL(
		"../lib/features/billing/purchase.svelte.ts",
		import.meta.url,
	);
	const target = `${filename.href}?billing-flow-regression`;
	const data = new Map<string, string>();
	const previousStorage = Object.getOwnPropertyDescriptor(
		globalThis,
		"sessionStorage",
	);
	Object.defineProperty(globalThis, "sessionStorage", {
		configurable: true,
		value: {
			getItem: (key: string) => data.get(key) ?? null,
			setItem: (key: string, value: string) => data.set(key, value),
			removeItem: (key: string) => data.delete(key),
		},
	});
	const plan = {
		key: "pro",
		name: "Pro",
		kind: "plan",
		interval: "monthly",
		visibility: "public",
		pricing: { amountUsd: 1, amountMinor: 100 },
		offer: null,
	};
	const pack = { ...plan, key: "credits", kind: "addon", interval: "one_time" };
	const sub = {
		id: "sub",
		productKey: "pro",
		status: "past_due",
		renewalRecovery: {
			state: "closing",
			effectiveEndsAt: "2099-01-01T00:00:00Z",
			payInvoice: { allowed: true, reason: null as string | null },
			endRecovery: { allowed: true, reason: null },
			subscribe: { allowed: false, reason: "subscription_occupied" },
		},
	};
	const catalog = {
		products: [plan, pack],
		plans: [plan],
		addons: [pack],
		currentSubscriptions: [sub],
		defaultPlanProductKey: null,
		hasActiveSubscription: true,
		payment: { available: true },
	};
	let action = {
		checkoutUrl: null as string | null,
		reason: "payment_unresolved" as string | null,
	};
	let actionCalls = 0;
	const fixture = {
		sdk: {
			billing: {
				getSubscription: async () => ({ subscription: sub }),
				getSubscriptionPaymentAction: async () => {
					actionCalls++;
					return action;
				},
			},
		},
		store: { catalog, load: async () => catalog },
	};
	const key = Symbol.for("cohub.billing.flow.regression");
	Reflect.set(globalThis, key, fixture);
	const stubs: Record<string, string> = {
		"@neta-art/cohub": "export class HttpError extends Error {}",
		"$lib/auth-redirect":
			"export const handleUnauthorizedError = async () => false;",
		"$lib/i18n/locale.svelte": 'export const getLocale = () => "en";',
		"$lib/paraglide/messages.js":
			"export const m = new Proxy({}, { get: (_, key) => () => String(key) });",
		"$lib/sdk": "export const sdk = fixture.sdk;",
		"$lib/stores/auth.svelte": 'export const authStore = { userUuid: "user" };',
		"$lib/stores/billing-catalog.svelte":
			"export const billingCatalogStore = fixture.store;",
		"./funnel": "export const trackPurchase = () => {};",
	};
	const hooks = registerHooks({
		resolve(specifier, context, next) {
			if (context.parentURL === target && specifier in stubs)
				return {
					url: `billing-flow-test:${encodeURIComponent(specifier)}`,
					shortCircuit: true,
				};
			return next(specifier, context);
		},
		load(url, context, next) {
			if (url === target)
				return {
					format: "module",
					source: compileModule(
						ts.transpileModule(readFileSync(filename, "utf8"), {
							compilerOptions: {
								target: ts.ScriptTarget.ESNext,
								module: ts.ModuleKind.ESNext,
							},
						}).outputText,
						{ filename: filename.pathname, generate: "server" },
					).js.code,
					shortCircuit: true,
				};
			if (url.startsWith("billing-flow-test:"))
				return {
					format: "module",
					source: `const fixture = globalThis[Symbol.for("cohub.billing.flow.regression")]; ${stubs[decodeURIComponent(url.slice("billing-flow-test:".length))]}`,
					shortCircuit: true,
				};
			return next(url, context);
		},
	});
	try {
		const { PurchaseFlow } = await import(target);
		const flow = new PurchaseFlow("settings");
		saveRenewalPurchaseIntent("user", {
			subscriptionId: "sub",
			productKey: "pro",
		});
		await flow.load({ force: true });
		flow.select(pack);
		assert.equal(readRenewalPurchaseIntent("user")?.productKey, "pro");
		await flow.load({ force: true });
		await flow.load({ force: true });
		assert.equal(flow.selected.key, "credits");
		assert.equal(flow.canBuy(pack), true);
		assert.equal(readRenewalPurchaseIntent("user")?.productKey, "pro");
		saveRenewalPurchaseIntent("user", null);
		flow.endingSubscriptionId = null;
		sub.renewalRecovery.state = "grace";
		await flow.payRenewal();
		assert.equal(flow.renewalPaymentPending, true);
		for (let i = 0; i < 5; i++) await flow.load({ force: true });
		assert.equal(
			flow.renewalPaymentPending,
			true,
			"locally-payable grace cannot override the unresolved Provider action",
		);
		assert.equal(
			actionCalls,
			1,
			"automatic checks do not probe Provider payment actions",
		);
		await flow.payRenewal();
		assert.equal(
			actionCalls,
			1,
			"pending payment cannot issue a second payment action",
		);
		sub.status = "active";
		await flow.load({ force: true });
		assert.equal(
			flow.renewalPaymentPending,
			true,
			"active status alone does not prove the pending payment was accepted",
		);
		sub.renewalRecovery.state = "none";
		sub.renewalRecovery.subscribe.reason = "paid_coverage_active";
		await flow.load({ force: true });
		assert.equal(flow.renewalPaymentPending, false);
		sub.status = "past_due";
		sub.renewalRecovery.state = "grace";
		sub.renewalRecovery.subscribe.reason = "subscription_occupied";
		await flow.payRenewal();
		action = {
			checkoutUrl: "https://checkout.example.test/retry",
			reason: null,
		};
		await flow.load({ force: true, checkPayment: true });
		assert.equal(
			flow.renewalPaymentPending,
			false,
			"an explicitly rechecked usable action clears waiting without redirecting",
		);
		action = { checkoutUrl: null, reason: "payment_unresolved" };
		await flow.payRenewal();
		sub.status = "ended";
		sub.renewalRecovery.state = "none";
		catalog.currentSubscriptions = [];
		await flow.load({ force: true });
		assert.equal(
			flow.renewalPaymentPending,
			true,
			"an unresolved ended subscription still needs confirmation",
		);
		sub.renewalRecovery.subscribe.allowed = true;
		await flow.load({ force: true });
		assert.equal(flow.renewalPaymentPending, false);
		catalog.currentSubscriptions = [sub];
		sub.status = "past_due";
		sub.renewalRecovery.state = "grace";
		sub.renewalRecovery.payInvoice = {
			allowed: false,
			reason: "payment_unresolved",
		};
		assert.equal(
			flow.renewalPaymentPending,
			true,
			"a summary-level unresolved payment also enters bounded checking",
		);
		sub.renewalRecovery.payInvoice = { allowed: true, reason: null };
		await flow.load({ force: true });
		assert.equal(flow.renewalPaymentPending, false);
	} finally {
		hooks.deregister();
		Reflect.deleteProperty(globalThis, key);
		if (previousStorage)
			Object.defineProperty(globalThis, "sessionStorage", previousStorage);
		else Reflect.deleteProperty(globalThis, "sessionStorage");
	}
});
