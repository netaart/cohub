import assert from "node:assert/strict";
import { test } from "node:test";
import {
	readRenewalPurchaseIntent,
	saveRenewalPurchaseIntent,
} from "../lib/features/billing/checkout-context";

test("renewal loads preserve Credits selection and reconcile a Provider-unresolved action", async (t) => {
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
	t.after(() => {
		if (previousStorage)
			Object.defineProperty(globalThis, "sessionStorage", previousStorage);
		else Reflect.deleteProperty(globalThis, "sessionStorage");
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
	for (const [path, namedExports] of [
		["@neta-art/cohub", { HttpError: class extends Error {} }],
		["../lib/auth-redirect.ts", { handleUnauthorizedError: async () => false }],
		["../lib/i18n/locale.svelte.ts", { getLocale: () => "en" }],
		[
			"../lib/paraglide/messages.js",
			{ m: new Proxy({}, { get: (_, key) => () => String(key) }) },
		],
		["../lib/sdk.ts", { sdk: fixture.sdk }],
		["../lib/stores/auth.svelte.ts", { authStore: { userUuid: "user" } }],
		[
			"../lib/stores/billing-catalog.svelte.ts",
			{ billingCatalogStore: fixture.store },
		],
		["../lib/features/billing/funnel.ts", { trackPurchase: () => {} }],
	] as const)
		t.mock.module(path, { namedExports });
	const hooks = registerHooks({
		load(url, context, next) {
			if (url !== target) return next(url, context);
			return {
				format: "module",
				shortCircuit: true,
				source: compileModule(
					ts.transpileModule(readFileSync(filename, "utf8"), {
						compilerOptions: {
							target: ts.ScriptTarget.ESNext,
							module: ts.ModuleKind.ESNext,
						},
					}).outputText,
					{ filename: filename.pathname, generate: "server" },
				).js.code,
			};
		},
	});
	t.after(() => hooks.deregister());
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
});
