import type {
	BillingCatalog,
	BillingCatalogProduct,
	BillingCheckoutConfirmation,
	BillingPromotionCodePreview,
} from "@neta-art/cohub";
import { HttpError } from "@neta-art/cohub";
import { handleUnauthorizedError } from "$lib/auth-redirect";
import { getLocale } from "$lib/i18n/locale.svelte";
import { m } from "$lib/paraglide/messages.js";
import { sdk } from "$lib/sdk";
import { authStore } from "$lib/stores/auth.svelte";
import { billingCatalogStore } from "$lib/stores/billing-catalog.svelte";
import {
	type CheckoutContext,
	currentCheckoutContext,
	finishCheckoutContext,
	readRenewalPurchaseIntent,
	saveCheckoutContext,
	saveRenewalPurchaseIntent,
} from "./checkout-context";
import { checkoutReturnUrl } from "./checkout-return";
import { trackPurchase } from "./funnel";
import {
	type CatalogView,
	catalogView,
	type PlanInterval,
	type PurchaseFocus,
	plansForInterval,
	planTier,
	purchaseFocus,
	recommendedPack,
	recommendedPlan,
} from "./product";

export type PurchaseSource =
	| "pricing"
	| "settings"
	| "conversion-hard"
	| "conversion-soft";

export type PurchaseError = {
	message: string;
	/** Offer no longer valid — the catalog was refreshed, ask to reconfirm. */
	offerChanged: boolean;
};

const OFFER_STALE_CODES = new Set([
	"first_purchase_offer_changed",
	"first_subscription_required",
	"discount_customer_limit_reached",
	"discount_ended",
	"discount_inactive",
]);

/**
 * One controller for every purchase surface: the public pricing page, the
 * billing settings tab and the in-app conversion sheet. Holds selection,
 * interval and checkout state; the surfaces are just different shells around
 * the same flow so that a fix or an experiment lands everywhere at once.
 */
export class PurchaseFlow {
	catalog = $derived<BillingCatalog | null>(billingCatalogStore.catalog);
	recoveryLoading = $state(false);
	endingSubscriptionId = $state<string | null>(null);
	recoveryNotice = $state<string | null>(null);
	private pendingPaymentSubscriptionId = $state<string | null>(null);
	private attempt: CheckoutContext | null = null;
	readonly recoverySubscription = $derived(
		this.catalog?.currentSubscriptions.find(
			(item) => item.renewalRecovery && item.renewalRecovery.state !== "none",
		) ?? null,
	);
	readonly renewalPaymentPending = $derived(
		this.recoverySubscription?.renewalRecovery?.payInvoice.reason ===
			"payment_unresolved" || Boolean(this.pendingPaymentSubscriptionId),
	);
	loading = $state(false);
	loadError = $state<string | null>(null);
	interval = $state<PlanInterval>("monthly");
	selectedKey = $state<string | null>(null);
	promotionCode = $state("");
	promotionPreview = $state<BillingPromotionCodePreview | null>(null);
	promotionLoading = $state(false);
	checkoutLoading = $state(false);
	error = $state<PurchaseError | null>(null);

	readonly view = $derived<CatalogView | null>(
		this.catalog ? catalogView(this.catalog) : null,
	);
	readonly plans = $derived<BillingCatalogProduct[]>(
		this.view ? plansForInterval(this.view, this.interval) : [],
	);
	readonly packs = $derived<BillingCatalogProduct[]>(this.view?.packs ?? []);
	readonly hasYearly = $derived((this.view?.yearlyPlans.length ?? 0) > 0);
	readonly selected = $derived<BillingCatalogProduct | null>(
		this.catalog?.products.find(
			(product) => product.key === this.selectedKey,
		) ?? null,
	);
	readonly appliedCode = $derived(
		this.promotionPreview?.eligible ? this.promotionPreview : null,
	);
	/** Pricing that will actually be charged for the selection. */
	readonly activePricing = $derived(
		this.appliedCode?.pricing ?? this.selected?.offer?.pricing ?? null,
	);
	readonly dueTodayUsd = $derived(
		this.activePricing?.paidAmountUsd ?? this.selected?.pricing.amountUsd ?? 0,
	);

	constructor(readonly source: PurchaseSource) {}

	focus(intent: Parameters<typeof purchaseFocus>[1] = null): PurchaseFocus {
		return this.view
			? purchaseFocus(this.view, intent, Boolean(this.recoverySubscription))
			: "plans";
	}

	async load(options: { force?: boolean; checkPayment?: boolean } = {}) {
		this.loading = !this.catalog;
		this.loadError = null;
		this.error = null;
		try {
			await billingCatalogStore.load({
				force: options.force,
				silent: !!this.catalog,
			});
			await this.refreshPendingPayment(options.checkPayment);
			this.ensureSelection();
			await this.restoreRenewalIntent();
		} catch (error) {
			this.loadError =
				error instanceof Error ? error.message : "Failed to load pricing";
		} finally {
			this.loading = false;
		}
	}

	private async refreshPendingPayment(checkPayment = false) {
		const id = this.pendingPaymentSubscriptionId;
		if (!id) return;
		const { subscription } = await sdk.billing.getSubscription(id);
		if (
			subscription.renewalRecovery?.subscribe.reason ===
				"paid_coverage_active" ||
			(subscription.status === "ended" &&
				subscription.renewalRecovery?.subscribe.allowed)
		) {
			this.pendingPaymentSubscriptionId = null;
		} else if (
			checkPayment &&
			subscription.renewalRecovery?.payInvoice.allowed
		) {
			// Local eligibility does not resolve a Provider payment already in flight.
			const action = await sdk.billing.getSubscriptionPaymentAction(id);
			if (action.checkoutUrl) {
				this.pendingPaymentSubscriptionId = null;
				await billingCatalogStore.load({ force: true, silent: true });
			}
		}
	}

	async restoreRenewalIntent() {
		this.recoveryNotice = null;
		const userId = authStore.userUuid;
		const intent = userId ? readRenewalPurchaseIntent(userId) : null;
		if (intent && userId) {
			this.endingSubscriptionId = intent.subscriptionId;
			if (
				this.selected?.kind !== "addon" &&
				this.catalog?.products.some(
					(product) =>
						product.key === intent.productKey && product.kind === "plan",
				)
			)
				this.selectedKey = intent.productKey;
			const { subscription } = await sdk.billing.getSubscription(
				intent.subscriptionId,
			);
			if (
				subscription.status === "ended" &&
				subscription.renewalRecovery?.subscribe.allowed
			) {
				this.endingSubscriptionId = null;
				this.recoveryNotice = subscription.paymentConflict
					? m.billing_recovery_previous_payment({}, { locale: getLocale() })
					: m.billing_recovery_ready({}, { locale: getLocale() });
			} else if (
				subscription.renewalRecovery?.subscribe.reason ===
				"paid_coverage_active"
			) {
				this.endingSubscriptionId = null;
				saveRenewalPurchaseIntent(userId, null);
				this.recoveryNotice = m.billing_recovery_paid_before_cancel(
					{},
					{ locale: getLocale() },
				);
			}
		}
	}

	/** Pre-selects the recommended product if nothing (valid) is selected. */
	ensureSelection(focus: PurchaseFocus = this.focus()) {
		if (this.selected) return;
		const pick =
			focus === "packs"
				? recommendedPack(this.packs)
				: recommendedPlan(this.plans);
		this.selectedKey = pick?.key ?? null;
	}

	select(product: BillingCatalogProduct) {
		if (this.selectedKey === product.key) return;
		this.selectedKey = product.key;
		const userId = authStore.userUuid;
		const intent = userId ? readRenewalPurchaseIntent(userId) : null;
		if (userId && intent && product.kind === "plan")
			saveRenewalPurchaseIntent(userId, { ...intent, productKey: product.key });
		this.clearPromotion();
		this.error = null;
		trackPurchase({
			name: "purchase_select",
			source: this.source,
			productKey: product.key,
			hasOffer: !!product.offer,
		});
	}

	setInterval(interval: PlanInterval) {
		if (this.interval === interval) return;
		const previous = this.selected;
		this.interval = interval;
		// Keep the same tier selected across the toggle when it exists.
		if (previous?.kind === "plan") {
			const view = this.view;
			const candidates = view ? plansForInterval(view, interval) : [];
			const tierMatch = candidates.find(
				(plan) => planTier(plan) === planTier(previous),
			);
			this.selectedKey =
				tierMatch?.key ?? recommendedPlan(candidates)?.key ?? null;
			this.clearPromotion();
		}
	}

	canBuy(product: BillingCatalogProduct): boolean {
		const view = this.view;
		if (!view?.paymentAvailable) return false;
		if (product.kind === "addon") return true;
		if (this.endingSubscriptionId) return false;
		if (view.currentPlan?.key === product.key) return false;
		return !view.hasActiveSubscription;
	}

	async applyPromotionCode() {
		const product = this.selected;
		const code = this.promotionCode.trim();
		if (!product || !code || this.promotionLoading) return;
		this.promotionLoading = true;
		this.error = null;
		this.promotionPreview = null;
		try {
			const { preview } = await sdk.billing.previewPromotionCode({
				productKey: product.key,
				promotionCode: code,
			});
			if (this.selectedKey !== product.key) return;
			this.promotionCode = preview.promotionCode;
			if (!preview.eligible) {
				this.error = {
					message: preview.message ?? "This code does not apply here.",
					offerChanged: false,
				};
				return;
			}
			this.promotionPreview = preview;
		} catch (error) {
			if (await handleUnauthorizedError(error)) return;
			this.error = {
				message:
					error instanceof Error ? error.message : "Could not apply code.",
				offerChanged: false,
			};
		} finally {
			this.promotionLoading = false;
		}
	}

	clearPromotion() {
		this.promotionCode = "";
		this.promotionPreview = null;
	}

	/**
	 * Starts checkout for the selection and hands off to the payment page.
	 * Returns false when nothing happened (caller keeps the UI open).
	 */
	async payRenewal() {
		const subscription = this.recoverySubscription;
		if (
			!subscription?.renewalRecovery?.payInvoice.allowed ||
			this.renewalPaymentPending ||
			this.recoveryLoading
		)
			return;
		this.recoveryLoading = true;
		this.error = null;
		try {
			const result = await sdk.billing.getSubscriptionPaymentAction(
				subscription.id,
			);
			if (result.checkoutUrl) window.location.assign(result.checkoutUrl);
			else {
				if (result.reason === "payment_unresolved")
					this.pendingPaymentSubscriptionId = subscription.id;
				await this.load({ force: true });
			}
		} catch (error) {
			this.error = {
				message:
					error instanceof Error
						? error.message
						: m.billing_recovery_refresh_failed({}, { locale: getLocale() }),
				offerChanged: false,
			};
		} finally {
			this.recoveryLoading = false;
		}
	}

	async endRecovery() {
		const subscription = this.recoverySubscription;
		const id = this.endingSubscriptionId ?? subscription?.id;
		if (!id || this.recoveryLoading) return;
		if (!this.endingSubscriptionId) {
			if (!subscription?.renewalRecovery?.endRecovery.allowed) return;
			this.endingSubscriptionId = id;
			if (authStore.userUuid && this.selectedKey)
				saveRenewalPurchaseIntent(authStore.userUuid, {
					subscriptionId: id,
					productKey: this.selectedKey,
				});
		}
		this.recoveryLoading = true;
		this.error = null;
		try {
			if (subscription?.renewalRecovery?.endRecovery.allowed)
				await sdk.billing.cancelSubscriptionAutoRenew(id);
			await this.load({ force: true });
		} catch (error) {
			this.error = {
				message:
					error instanceof Error
						? error.message
						: m.billing_recovery_refresh_failed({}, { locale: getLocale() }),
				offerChanged: false,
			};
		} finally {
			this.recoveryLoading = false;
		}
	}

	async checkout(input: { returnTo: string | URL }): Promise<boolean> {
		const product = this.selected;
		if (!product || this.checkoutLoading || !this.canBuy(product)) return false;
		this.checkoutLoading = true;
		this.error = null;
		const selection = this.appliedCode
			? { promotionCode: this.appliedCode.promotionCode }
			: product.offer
				? { offer: product.offer.ref }
				: {};
		// The server appends the product key and the outcome; the client only
		// supplies where the payment page should send the user back.
		const returnUrl = checkoutReturnUrl(input.returnTo);
		trackPurchase({
			name: "purchase_checkout_start",
			source: this.source,
			productKey: product.key,
			hasOffer: !!product.offer,
			dueTodayUsd: this.dueTodayUsd,
		});
		const userId = authStore.userUuid ?? "";
		let context =
			this.attempt?.userId === userId && this.attempt.productKey === product.key
				? this.attempt
				: currentCheckoutContext(userId, product.key);
		const hadPriorAttempt = context !== null;
		try {
			if (context?.checkoutId) {
				const { confirmation } = await sdk.billing.confirmCheckout(
					product.key,
					context.checkoutId,
				);
				if (confirmation.checkoutUrl) {
					window.location.assign(confirmation.checkoutUrl);
					return true;
				}
				if (confirmation.settled) {
					finishCheckoutContext(context);
					this.attempt = null;
					await this.load({ force: true });
					return false;
				}
				if (confirmation.canRestart) {
					finishCheckoutContext(context);
					this.attempt = null;
					await this.load({ force: true });
					this.error = {
						message: m.billing_checkout_reconfirm({}, { locale: getLocale() }),
						offerChanged: true,
					};
					return false;
				}
				this.error = {
					message: m.purchase_return_confirming_detail(
						{},
						{ locale: getLocale() },
					),
					offerChanged: false,
				};
				return false;
			}
			context ??= {
				purchaseId: crypto.randomUUID(),
				userId,
				productKey: product.key,
				checkoutId: null,
				request: { returnUrl, ...selection },
			};
			this.attempt = context;
			saveCheckoutContext(context);
			const { checkout } =
				product.kind === "plan"
					? await sdk.billing.createSubscription(product.key, {
							...context.request,
							purchaseId: context.purchaseId,
						})
					: await sdk.billing.createOrder(product.key, {
							...context.request,
							purchaseId: context.purchaseId,
						});
			const checkoutId = checkout.orderId ?? checkout.subscriptionId;
			if (checkoutId) {
				context.checkoutId = checkoutId;
				saveCheckoutContext(context);
			}
			if (checkout.checkoutUsable && checkout.checkoutUrl) {
				if (product.kind === "plan") saveRenewalPurchaseIntent(userId, null);
				window.location.assign(checkout.checkoutUrl);
				return true;
			}
			if (checkoutId) {
				const { confirmation } = await sdk.billing.confirmCheckout(
					product.key,
					checkoutId,
				);
				if (confirmation.settled) {
					finishCheckoutContext(context);
					this.attempt = null;
					await this.load({ force: true });
					return false;
				}
			}
			this.error = {
				message:
					checkout.payment.reason ??
					checkout.message ??
					"Checkout is not available right now.",
				offerChanged: false,
			};
			return false;
		} catch (error) {
			if (await handleUnauthorizedError(error)) return false;
			const code = error instanceof HttpError ? error.code : null;
			const offerChanged =
				!hadPriorAttempt && !!code && OFFER_STALE_CODES.has(code);
			this.error = {
				message:
					error instanceof Error ? error.message : "Checkout is not available.",
				offerChanged,
			};
			if (offerChanged) {
				if (context) finishCheckoutContext(context);
				this.attempt = null;
				void this.load({ force: true });
			}
			return false;
		} finally {
			this.checkoutLoading = false;
		}
	}

	/**
	 * Confirms a returned checkout against the provider's order/subscription
	 * state before any success UI is shown. `settled: true` is the only signal
	 * that carries a real purchase; a pending or failed record never does.
	 */
	async confirmCheckout(
		productKey: string,
		checkoutId: string,
	): Promise<BillingCheckoutConfirmation | null> {
		try {
			const { confirmation } = await sdk.billing.confirmCheckout(
				productKey,
				checkoutId,
			);
			return confirmation;
		} catch (error) {
			if (await handleUnauthorizedError(error)) return null;
			console.warn("[billing] Checkout confirmation failed", error);
			return null;
		}
	}
}
