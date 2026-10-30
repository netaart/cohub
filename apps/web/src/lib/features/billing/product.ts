import type {
	BillingCatalog,
	BillingCatalogProduct,
	BillingConversionIntent,
	BillingSubscriptionSummary,
} from "@neta-art/cohub";

/**
 * Pure product/pricing helpers shared by every purchase surface — the public
 * pricing page, the billing settings tab and the in-app conversion sheet.
 * Nothing here touches Svelte state or i18n: callers format the results.
 */

export type PlanInterval = "monthly" | "yearly";

export type PlanTier = "free" | "plus" | "pro" | "max" | (string & {});

/** Credits are stored at 1e-8 USD per unit. */
const CREDIT_UNIT_USD = 0.000_000_01;

export function planTier(product: BillingCatalogProduct): PlanTier {
	const source = `${product.key} ${product.name}`.toLowerCase();
	if (product.pricing.amountUsd === 0 || source.includes("free")) return "free";
	if (source.includes("max")) return "max";
	if (source.includes("pro") || source.includes("standard")) return "pro";
	if (source.includes("plus")) return "plus";
	return product.key;
}

export function isFreeProduct(product: BillingCatalogProduct): boolean {
	return product.pricing.amountUsd === 0;
}

export function sortByPrice<T extends BillingCatalogProduct>(
	products: T[],
): T[] {
	return [...products].sort(
		(a, b) => a.pricing.amountMinor - b.pricing.amountMinor,
	);
}

/**
 * USD balance a product grants per billing cycle (month for plans, once for
 * packs). Falls back to raw credits, then to the price itself — every paid
 * product is at minimum worth its price in usage.
 */
export function includedBalanceUsd(product: BillingCatalogProduct): number {
	const benefits = product.display.creditBenefits;
	if (benefits.length > 0) {
		return benefits.reduce((sum, benefit) => sum + benefit.cycleAmountUsd, 0);
	}
	if (product.display.creditsAmount && product.display.creditsAmount > 0) {
		return product.display.creditsAmount * CREDIT_UNIT_USD;
	}
	return product.pricing.amountUsd;
}

/** Total balance a yearly plan grants over the whole term. */
export function periodBalanceUsd(product: BillingCatalogProduct): number {
	const benefits = product.display.creditBenefits;
	if (benefits.length > 0) {
		return benefits.reduce((sum, benefit) => sum + benefit.periodAmountUsd, 0);
	}
	return includedBalanceUsd(product);
}

/**
 * Percentage a product saves against its own list price. Plans carry a
 * `compareAt` from the catalog; yearly plans fall back to 12× the matching
 * monthly tier.
 */
export function listSavingsPercent(
	product: BillingCatalogProduct,
	monthlyPlans: BillingCatalogProduct[] = [],
): number | null {
	const rate = product.pricing.discountRate;
	if (typeof rate === "number" && rate > 0) return Math.round(rate * 100);
	const compareAt = product.pricing.compareAtAmountUsd;
	if (typeof compareAt === "number" && compareAt > product.pricing.amountUsd) {
		return Math.round(
			((compareAt - product.pricing.amountUsd) / compareAt) * 100,
		);
	}
	if (product.interval !== "yearly") return null;
	const monthly = monthlyPlans.find(
		(plan) => planTier(plan) === planTier(product),
	);
	if (!monthly || monthly.pricing.amountUsd <= 0) return null;
	const annualized = monthly.pricing.amountUsd * 12;
	const percent = Math.round(
		((annualized - product.pricing.amountUsd) / annualized) * 100,
	);
	return percent > 0 ? percent : null;
}

/** Highest yearly saving across a set of plans, for the interval toggle badge. */
export function bestYearlySavingsPercent(
	yearlyPlans: BillingCatalogProduct[],
	monthlyPlans: BillingCatalogProduct[],
): number | null {
	let best: number | null = null;
	for (const plan of yearlyPlans) {
		const percent = listSavingsPercent(plan, monthlyPlans);
		if (percent !== null && (best === null || percent > best)) best = percent;
	}
	return best;
}

/**
 * How a price should read on a card. `offer` is a real, user-specific price
 * the server has already validated; `promotion` is the campaign that exists
 * whether or not this viewer qualifies. Exactly one of them (or neither) is
 * surfaced so cards never promise a price the checkout cannot honour.
 */
export type DisplayPrice = {
	/** Amount to render as the hero figure. */
	amountUsd: number;
	/** Struck-through list price when the hero figure is discounted. */
	compareAtUsd: number | null;
	/** Whole-number percent off applied to the hero figure. */
	percentOff: number | null;
	/** Personalised offer already applied to the hero figure. */
	offerApplied: boolean;
	/** Campaign this viewer can still unlock (e.g. by signing in). */
	teaser: { percentOff: number; endsAt: string | null } | null;
	/** The offer window, when the campaign has one. */
	endsAt: string | null;
};

export function displayPrice(
	product: BillingCatalogProduct,
	options: { signedIn: boolean },
): DisplayPrice {
	const offer = product.offer;
	if (offer && offer.pricing.discountAmountUsd > 0) {
		const percent = Math.round(
			(offer.pricing.discountAmountUsd / offer.pricing.amountUsd) * 100,
		);
		return {
			amountUsd: offer.pricing.paidAmountUsd,
			compareAtUsd: offer.pricing.amountUsd,
			percentOff: percent,
			offerApplied: true,
			teaser: null,
			endsAt: offer.endsAt,
		};
	}
	const promotion = product.promotion;
	// Signed-in viewers without an offer are not eligible (already bought,
	// campaign ended…); teasing them would be a broken promise.
	const teaser =
		promotion && !options.signedIn
			? { percentOff: promotion.percentOff, endsAt: promotion.endsAt }
			: null;
	return {
		amountUsd: product.pricing.amountUsd,
		compareAtUsd: null,
		percentOff: null,
		offerApplied: false,
		teaser,
		endsAt: teaser?.endsAt ?? null,
	};
}

/** Whole days until `endsAt`, or null if unset or already passed. */
export function daysUntil(
	endsAt: string | null,
	now = Date.now(),
): number | null {
	if (!endsAt) return null;
	const end = Date.parse(endsAt);
	if (Number.isNaN(end) || end <= now) return null;
	return Math.ceil((end - now) / 86_400_000);
}

export type CatalogView = {
	freePlan: BillingCatalogProduct | null;
	monthlyPlans: BillingCatalogProduct[];
	yearlyPlans: BillingCatalogProduct[];
	packs: BillingCatalogProduct[];
	currentSubscription: BillingSubscriptionSummary | null;
	currentPlan: BillingCatalogProduct | null;
	/** Paid plan currently active — packs become the primary upsell. */
	hasPaidPlan: boolean;
	/** Any blocking subscription — a second plan checkout would be rejected. */
	hasActiveSubscription: boolean;
	paymentAvailable: boolean;
	paymentReason: string | null;
};

export function subscriptionDisplayState(
	subscription: BillingSubscriptionSummary | null,
	now = Date.now(),
): "active" | "grace" | "closing" | null {
	if (!subscription) return null;
	const recovery = subscription.renewalRecovery;
	if (recovery?.state === "closing") return "closing";
	if (recovery?.state === "grace") {
		return recovery.effectiveEndsAt &&
			Date.parse(recovery.effectiveEndsAt) > now
			? "grace"
			: "closing";
	}
	return ["active", "trialing"].includes(subscription.status) ? "active" : null;
}

export function currentCatalogSubscription(
	catalog: Pick<
		BillingCatalog,
		"currentSubscriptions" | "defaultPlanProductKey"
	>,
	now = Date.now(),
) {
	return (
		catalog.currentSubscriptions.find(
			(item) =>
				item.productKey !== catalog.defaultPlanProductKey &&
				subscriptionDisplayState(item, now) === "active",
		) ??
		catalog.currentSubscriptions.find(
			(item) =>
				item.productKey !== catalog.defaultPlanProductKey &&
				subscriptionDisplayState(item, now) !== null,
		) ??
		catalog.currentSubscriptions.find(
			(item) => subscriptionDisplayState(item, now) === "active",
		) ??
		null
	);
}

export function catalogView(
	catalog: BillingCatalog,
	now = Date.now(),
): CatalogView {
	const plans = catalog.plans.filter((plan) => plan.visibility === "public");
	const defaultKey = catalog.defaultPlanProductKey;
	const freePlan =
		plans.find((plan) => plan.key === defaultKey) ??
		plans.find(isFreeProduct) ??
		null;
	const paid = plans.filter(
		(plan) => plan.key !== freePlan?.key && !isFreeProduct(plan),
	);
	const currentSubscription = currentCatalogSubscription(catalog, now);
	const subscriptionState = subscriptionDisplayState(currentSubscription, now);
	const currentPlan =
		(currentSubscription?.productKey
			? catalog.plans.find(
					(plan) => plan.key === currentSubscription.productKey,
				)
			: null) ?? null;
	const hasPaidPlan =
		!!currentSubscription?.productKey &&
		currentSubscription.productKey !== defaultKey &&
		subscriptionState !== "closing";
	return {
		freePlan,
		monthlyPlans: sortByPrice(
			paid.filter((plan) => plan.interval === "monthly"),
		),
		yearlyPlans: sortByPrice(paid.filter((plan) => plan.interval === "yearly")),
		packs: sortByPrice(catalog.addons),
		currentSubscription,
		currentPlan,
		hasPaidPlan,
		hasActiveSubscription: catalog.hasActiveSubscription,
		paymentAvailable: catalog.payment.available !== false,
		paymentReason: catalog.payment.reason,
	};
}

/** Plans for the toggled interval, falling back when one side is empty. */
export function plansForInterval(
	view: Pick<CatalogView, "monthlyPlans" | "yearlyPlans">,
	interval: PlanInterval,
): BillingCatalogProduct[] {
	if (interval === "yearly" && view.yearlyPlans.length > 0)
		return view.yearlyPlans;
	if (view.monthlyPlans.length === 0) return view.yearlyPlans;
	return view.monthlyPlans;
}

export type PurchaseFocus = "plans" | "packs";

/**
 * Which product family a surface should lead with. The server's conversion
 * intent knows the audience (free vs paid) better than the client; without an
 * intent we infer it from the catalog.
 */
export function purchaseFocus(
	view: Pick<
		CatalogView,
		"hasPaidPlan" | "packs" | "monthlyPlans" | "yearlyPlans"
	>,
	intent: Pick<BillingConversionIntent, "preferredOfferKind"> | null = null,
	recovering = false,
): PurchaseFocus {
	const hasPlans = view.monthlyPlans.length + view.yearlyPlans.length > 0;
	if (!hasPlans) return "packs";
	if (view.packs.length === 0) return "plans";
	switch (intent?.preferredOfferKind) {
		case "addon":
			return "packs";
		case "plan":
		case "upgrade":
			return "plans";
		default:
			return recovering ? "plans" : view.hasPaidPlan ? "packs" : "plans";
	}
}

/**
 * The plan to pre-select. Mirrors the "Most popular" badge so the default
 * highlighted option and the recommended one are always the same card.
 */
export function recommendedPlan(
	plans: BillingCatalogProduct[],
): BillingCatalogProduct | null {
	return (
		plans.find((plan) => planTier(plan) === "pro") ??
		plans[Math.min(1, plans.length - 1)] ??
		null
	);
}

export function isRecommended(
	product: BillingCatalogProduct,
	plans: BillingCatalogProduct[],
): boolean {
	return recommendedPlan(plans)?.key === product.key;
}

/** Middle pack, or the one whose first-purchase saving is biggest. */
export function recommendedPack(
	packs: BillingCatalogProduct[],
): BillingCatalogProduct | null {
	if (packs.length === 0) return null;
	const withOffer = packs.filter((pack) => pack.offer);
	const pool = withOffer.length > 0 ? withOffer : packs;
	return pool[Math.min(1, pool.length - 1)] ?? null;
}
