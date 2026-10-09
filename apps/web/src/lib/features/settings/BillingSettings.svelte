<script lang="ts">
import type {
	BillingBalanceActivityList,
	BillingCatalog,
	BillingCreditStatus,
	BillingSubscriptionHistoryList,
	BillingSubscriptionHistoryStatus,
} from "@neta-art/cohub";
import {
	AlertCircle,
	ChevronLeft,
	ChevronRight,
	Clock,
	Gift,
	Loader2,
	Wallet,
} from "lucide-svelte";
import { goto } from "$app/navigation";
import { page } from "$app/state";
import { ensureAuth } from "$lib/auth";
import { handleUnauthorizedError } from "$lib/auth-redirect";
import { trackPurchase } from "$lib/features/billing/funnel";
import PurchasePanel from "$lib/features/billing/PurchasePanel.svelte";
import { PurchaseFlow } from "$lib/features/billing/purchase.svelte";
import * as account from "$lib/features/settings/account-data";
import {
	onSettingsPageActive,
	settingsPageActive,
} from "$lib/features/settings/page-context.svelte";
import { formatCurrency, formatDateTime } from "$lib/i18n/format";
import { getLocale } from "$lib/i18n/locale.svelte";
import { m } from "$lib/paraglide/messages.js";
import { sdk } from "$lib/sdk";
import { billingCatalogStore } from "$lib/stores/billing-catalog.svelte";

const locale = $derived(getLocale());
const active = settingsPageActive();
type BillingTab = "balance" | "plans" | "redeem";

const purchase = new PurchaseFlow("settings");

function buyFromSettings() {
	void purchase.checkout({
		returnTo: new URL("/settings/billing?tab=plans", window.location.origin),
	});
}

const balanceCredit = $derived(account.billingCredits.data);
let activityPage = $state(1);
let laterActivities = $state.raw<BillingBalanceActivityList | null>(null);
let activityPaging = $state(false);
let activityPagingError = $state("");
const balanceActivities = $derived(
	activityPage === 1 ? account.billingActivity.data : laterActivities,
);
let billingCatalog = $state<BillingCatalog | null>(null);
let billingSubscriptions = $state<BillingSubscriptionHistoryList | null>(null);
const creditLoading = $derived(
	account.billingCredits.loading || account.billingCredits.refreshing,
);
const activityLoading = $derived(
	activityPaging ||
		(activityPage === 1 &&
			(account.billingActivity.loading || account.billingActivity.refreshing)),
);
let catalogLoading = $state(true);
let subscriptionsLoading = $state(true);
const creditError = $derived(
	account.billingCredits.errorMessage(m.billing_load_failed({}, { locale })),
);
const activityError = $derived(
	activityPagingError ||
		(activityPage === 1 && !account.billingActivity.data
			? account.billingActivity.errorMessage(
					m.billing_activity_load_failed({}, { locale }),
				)
			: ""),
);
let catalogError = $state("");
let subscriptionsError = $state("");
let checkoutError = $state("");
let redemptionError = $state("");
let redemptionSuccess = $state("");
let subscriptionsPage = $state(1);
let activeBillingTab = $state<BillingTab>("balance");
let redemptionCode = $state("");
let billingActionBusyKey = $state<string | null>(null);
let redemptionLoading = $state(false);
let checkoutNow = $state(Date.now());
let catalogRequest: Promise<void> | null = null;
let subscriptionsRequest: Promise<void> | null = null;
let checkoutExpiryRefreshRequest: Promise<void> | null = null;
const refreshedExpiredCheckoutKeys = new Set<string>();

const activityHasMore = $derived(
	Boolean(balanceActivities?.pagination.hasMore),
);
const subscriptionsHasMore = $derived(
	Boolean(billingSubscriptions?.pagination.hasMore),
);
const routeBillingTab = $derived(page.url.searchParams.get("tab"));
const currentSubscription = $derived(
	billingCatalog?.currentSubscriptions.find(
		(subscription) => subscription.status === "active",
	) ??
		billingCatalog?.currentSubscriptions.find(
			(subscription) => subscription.status === "trialing",
		) ??
		null,
);
const defaultPlanProduct = $derived.by(() => {
	const catalog = billingCatalog;
	if (!catalog?.defaultPlanProductKey) return null;
	return (
		catalog.plans.find(
			(product) => product.key === catalog.defaultPlanProductKey,
		) ?? null
	);
});
const pendingCheckoutExpirations = $derived.by(() => {
	const expirations: number[] = [];
	for (const subscription of billingSubscriptions?.items ?? []) {
		const expiresAt = getPendingCheckoutExpiration(subscription);
		if (expiresAt !== null) expirations.push(expiresAt);
	}
	return expirations;
});

function formatUsdAmount(value: number): string {
	return formatCurrency(value, "USD", {
		locale,
		minimumFractionDigits: 0,
		maximumFractionDigits: 8,
	});
}

function parseBillingTab(value: string | null): BillingTab {
	if (value === "plans" || value === "redeem") return value;
	return "balance";
}

function setBillingTab(tab: BillingTab) {
	activeBillingTab = tab;
	const target = new URL(page.url);
	if (tab === "balance") {
		target.searchParams.delete("tab");
	} else {
		target.searchParams.set("tab", tab);
	}
	void goto(`${target.pathname}${target.search}${target.hash}`, {
		replaceState: true,
		keepFocus: true,
		noScroll: true,
	});
}

$effect(() => {
	if (!active()) return;
	activeBillingTab = parseBillingTab(routeBillingTab);
	if (activeBillingTab === "plans") {
		trackPurchase({
			name: "purchase_open",
			source: "settings",
			focus: purchase.focus(),
		});
	}
});

function formatProductPrice(value: number): string {
	return formatCurrency(value, "USD", {
		locale,
		minimumFractionDigits: 2,
		maximumFractionDigits: 2,
	});
}

function getExpiryGroupLabel(
	key: BillingCreditStatus["groups"][number]["key"],
): string {
	switch (key) {
		case "expired":
			return m.billing_expired({}, { locale });
		case "lt_7d":
			return m.billing_expires_within_7d({}, { locale });
		case "lt_30d":
			return m.billing_expires_within_30d({}, { locale });
		case "gte_30d":
			return m.billing_expires_after_30d({}, { locale });
		case "never":
			return m.billing_no_expiration({}, { locale });
	}
}

function currentSubscriptionLine(): string {
	if (!currentSubscription) return "";
	const parts = [formatHistoryStatus(currentSubscription.status)];
	if (!currentSubscription.currentPeriodEnd) return parts.join(" - ");
	parts.push(
		currentSubscription.cancelAtPeriodEnd
			? m.billing_auto_renew_canceled_ends(
					{ date: formatBillingDate(currentSubscription.currentPeriodEnd) },
					{ locale },
				)
			: m.billing_renews(
					{ date: formatBillingDate(currentSubscription.currentPeriodEnd) },
					{ locale },
				),
	);
	return parts.join(" - ");
}

function formatBillingDate(value: string | null | undefined): string {
	if (!value) return m.billing_no_expiration({}, { locale });
	const date = new Date(value);
	if (Number.isNaN(date.getTime())) return value;
	return formatDateTime(date, locale, {
		dateStyle: "medium",
		timeStyle: "short",
	});
}

function formatHistoryStatus(value: string): string {
	switch (value) {
		case "active":
			return m.billing_status_active({}, { locale });
		case "trialing":
			return m.billing_status_trialing({}, { locale });
		case "pending_checkout":
			return m.billing_status_pending_checkout({}, { locale });
		default:
			return value
				.split(/[._-]/g)
				.filter(Boolean)
				.map((part) => part.charAt(0).toUpperCase() + part.slice(1))
				.join(" ");
	}
}

function formatPeriod(subscription: BillingSubscriptionHistoryStatus): string {
	if (!subscription.currentPeriodStart && !subscription.currentPeriodEnd)
		return m.billing_no_active_period({}, { locale });
	if (!subscription.currentPeriodStart)
		return m.billing_until(
			{ date: formatBillingDate(subscription.currentPeriodEnd) },
			{ locale },
		);
	if (!subscription.currentPeriodEnd)
		return m.billing_from(
			{ date: formatBillingDate(subscription.currentPeriodStart) },
			{ locale },
		);
	return `${formatBillingDate(subscription.currentPeriodStart)} - ${formatBillingDate(subscription.currentPeriodEnd)}`;
}

function getPendingCheckoutExpiration(
	item: BillingSubscriptionHistoryStatus,
): number | null {
	if (item.status !== "pending_checkout" || !item.checkoutExpiresAt)
		return null;
	const expiresAt = Date.parse(item.checkoutExpiresAt);
	return Number.isNaN(expiresAt) ? null : expiresAt;
}

function getPendingCheckoutRefreshKey(
	item: BillingSubscriptionHistoryStatus,
): string | null {
	if (item.status !== "pending_checkout" || !item.checkoutExpiresAt)
		return null;
	return `${item.id}:${item.checkoutExpiresAt}`;
}

function formatCheckoutCountdown(
	item: BillingSubscriptionHistoryStatus,
): string {
	const expiresAt = getPendingCheckoutExpiration(item);
	if (expiresAt === null) return "";
	const remainingMs = expiresAt - checkoutNow;
	if (remainingMs <= 0) return m.billing_checkout_expired({}, { locale });
	const totalSeconds = Math.ceil(remainingMs / 1000);
	const hours = Math.floor(totalSeconds / 3600);
	const minutes = Math.floor((totalSeconds % 3600) / 60);
	const seconds = totalSeconds % 60;
	if (hours > 0)
		return m.billing_countdown_hms({ hours, minutes, seconds }, { locale });
	if (minutes > 0)
		return m.billing_countdown_ms({ minutes, seconds }, { locale });
	return m.billing_countdown_s({ seconds }, { locale });
}

function isCheckoutExpired(item: BillingSubscriptionHistoryStatus): boolean {
	const expiresAt = getPendingCheckoutExpiration(item);
	return expiresAt !== null && expiresAt <= checkoutNow;
}

function canPayCheckout(item: BillingSubscriptionHistoryStatus): boolean {
	return (
		item.actions.canPay &&
		!!item.actions.checkoutUrl &&
		!isCheckoutExpired(item)
	);
}

function historyAmount(value: {
	paidAmountUsd: number;
	amountUsd: number;
}): string {
	return formatProductPrice(
		value.paidAmountUsd > 0 ? value.paidAmountUsd : value.amountUsd,
	);
}

function activityStatusLabel(value: string | null): string {
	if (value === "overage") return m.billing_status_overage({}, { locale });
	if (value === "partial") return m.billing_status_partial({}, { locale });
	return "";
}

function shortIdentifier(value: string | null): string {
	if (!value) return "";
	if (value.length <= 18) return value;
	return `${value.slice(0, 10)}…${value.slice(-6)}`;
}

function grantConsumedPercent(value: number | null): number {
	if (value === null || !Number.isFinite(value)) return 0;
	return Math.min(100, Math.max(0, value));
}

function formatGrantStatus(value: string): string {
	if (value === "active") return m.billing_status_active({}, { locale });
	return value.charAt(0).toUpperCase() + value.slice(1);
}

function getGrantDisplayStatus(grant: {
	status: string;
	daysRemaining: number | null;
}): string {
	if (grant.daysRemaining !== null && grant.daysRemaining <= 0)
		return m.billing_expired({}, { locale });
	return formatGrantStatus(grant.status);
}

function isGrantDisplayActive(grant: {
	status: string;
	daysRemaining: number | null;
}): boolean {
	return (
		grant.status === "active" &&
		!(grant.daysRemaining !== null && grant.daysRemaining <= 0)
	);
}

function loadCreditStatus(options: { force?: boolean } = {}) {
	return account.billingCredits.load(options);
}

async function loadActivityPage(
	page: number,
	options: { force?: boolean } = {},
) {
	activityPagingError = "";
	if (page <= 1) {
		activityPage = 1;
		laterActivities = null;
		return account.billingActivity.load(options);
	}
	if (activityPaging) return;
	activityPaging = true;
	try {
		const { activities } = await sdk.billing.getBalanceActivities({
			page: Math.floor(page),
			limit: account.BALANCE_ACTIVITY_PAGE_SIZE,
		});
		laterActivities = activities;
		activityPage = activities.page;
	} catch (error) {
		if (await handleUnauthorizedError(error)) return;
		activityPagingError =
			error instanceof Error
				? error.message
				: m.billing_activity_load_failed({}, { locale });
		console.error("[balance] Failed to load activity:", error);
	} finally {
		activityPaging = false;
	}
}

async function loadCatalog(options: { force?: boolean } = {}) {
	if (catalogRequest) {
		if (!options.force) return catalogRequest;
		await catalogRequest;
	}
	catalogLoading = true;
	catalogError = "";
	catalogRequest = (async () => {
		if (!(await ensureAuth())) return;
		try {
			billingCatalog = await billingCatalogStore.load({ force: options.force });
			purchase.catalog = billingCatalog;
			purchase.ensureSelection();
		} catch (error) {
			if (await handleUnauthorizedError(error)) return;
			catalogError =
				error instanceof Error
					? error.message
					: m.billing_catalog_load_failed({}, { locale });
			console.error("[billing] Failed to load catalog:", error);
		} finally {
			catalogLoading = false;
			catalogRequest = null;
		}
	})();
	return catalogRequest;
}

async function loadSubscriptionsPage(
	page = subscriptionsPage,
	options: { force?: boolean } = {},
) {
	if (subscriptionsRequest) {
		if (!options.force) return subscriptionsRequest;
		await subscriptionsRequest;
	}
	subscriptionsLoading = true;
	subscriptionsError = "";
	subscriptionsRequest = (async () => {
		if (!(await ensureAuth())) return;
		try {
			const nextPage = Math.max(1, Math.floor(page));
			const { subscriptions } = await sdk.billing.getSubscriptions({
				page: nextPage,
				limit: 10,
			});
			billingSubscriptions = subscriptions;
			subscriptionsPage = subscriptions.page;
		} catch (error) {
			if (await handleUnauthorizedError(error)) return;
			subscriptionsError =
				error instanceof Error
					? error.message
					: m.billing_subscriptions_load_failed({}, { locale });
			console.error("[billing] Failed to load subscriptions:", error);
		} finally {
			subscriptionsLoading = false;
			subscriptionsRequest = null;
		}
	})();
	return subscriptionsRequest;
}

async function refreshExpiredPendingCheckouts() {
	if (checkoutExpiryRefreshRequest) return checkoutExpiryRefreshRequest;
	checkoutExpiryRefreshRequest = Promise.all([
		loadCatalog({ force: true }),
		loadSubscriptionsPage(subscriptionsPage, { force: true }),
	])
		.then(() => undefined)
		.finally(() => {
			checkoutExpiryRefreshRequest = null;
		});
	return checkoutExpiryRefreshRequest;
}

async function createRedemption(event: SubmitEvent) {
	event.preventDefault();
	const code = redemptionCode.trim();
	if (redemptionLoading || !code) return;
	redemptionLoading = true;
	redemptionError = "";
	redemptionSuccess = "";
	try {
		const { redemption } = await sdk.billing.createRedemption({ code });
		if (!redemption.redeemed) {
			redemptionError =
				redemption.message ?? m.billing_redeem_failed({}, { locale });
			return;
		}
		redemptionCode = "";
		redemptionSuccess = m.billing_redeem_success({}, { locale });
		await Promise.all([
			loadCatalog({ force: true }),
			loadCreditStatus({ force: true }),
			loadActivityPage(1, { force: true }),
			loadSubscriptionsPage(1, { force: true }),
		]);
	} catch (error) {
		if (await handleUnauthorizedError(error)) return;
		redemptionError =
			error instanceof Error
				? error.message
				: m.billing_redeem_failed({}, { locale });
	} finally {
		redemptionLoading = false;
	}
}

function payCheckout(item: BillingSubscriptionHistoryStatus) {
	if (!canPayCheckout(item) || !item.actions.checkoutUrl) return;
	window.location.href = item.actions.checkoutUrl;
}

async function cancelSubscriptionCheckout(
	subscription: BillingSubscriptionHistoryStatus,
) {
	if (!subscription.actions.canCancelCheckout || billingActionBusyKey) return;
	if (!window.confirm(m.billing_cancel_checkout_confirm({}, { locale })))
		return;
	billingActionBusyKey = `subscription:${subscription.id}:cancel-checkout`;
	checkoutError = "";
	try {
		await sdk.billing.cancelSubscriptionCheckout(subscription.id);
		await Promise.all([
			loadSubscriptionsPage(subscriptionsPage, { force: true }),
			loadCatalog({ force: true }),
			loadCreditStatus({ force: true }),
		]);
	} catch (error) {
		if (await handleUnauthorizedError(error)) return;
		checkoutError =
			error instanceof Error
				? error.message
				: m.billing_cancel_checkout_failed({}, { locale });
	} finally {
		billingActionBusyKey = null;
	}
}

async function cancelSubscriptionAutoRenew(
	subscription: BillingSubscriptionHistoryStatus,
) {
	if (!subscription.actions.canCancelAutoRenew || billingActionBusyKey) return;
	if (!window.confirm(m.billing_cancel_autorenew_confirm({}, { locale })))
		return;
	billingActionBusyKey = `subscription:${subscription.id}:cancel-auto-renew`;
	checkoutError = "";
	try {
		await sdk.billing.cancelSubscriptionAutoRenew(subscription.id);
		await Promise.all([
			loadSubscriptionsPage(subscriptionsPage, { force: true }),
			loadCatalog({ force: true }),
		]);
	} catch (error) {
		if (await handleUnauthorizedError(error)) return;
		checkoutError =
			error instanceof Error
				? error.message
				: m.billing_cancel_autorenew_failed({}, { locale });
	} finally {
		billingActionBusyKey = null;
	}
}

function goToActivityPage(page: number) {
	if (activityLoading) return;
	void loadActivityPage(page);
}

function goToSubscriptionsPage(page: number) {
	if (subscriptionsLoading) return;
	void loadSubscriptionsPage(page);
}

onSettingsPageActive(() => {
	void loadCatalog();
	void loadCreditStatus();
	if (activityPage === 1) void loadActivityPage(1);
	void loadSubscriptionsPage();
});

$effect(() => {
	if (!active() || pendingCheckoutExpirations.length === 0) return;
	checkoutNow = Date.now();
	const interval = window.setInterval(() => {
		checkoutNow = Date.now();
	}, 1000);
	return () => window.clearInterval(interval);
});

$effect(() => {
	if (!active() || pendingCheckoutExpirations.length === 0) return;
	const nextExpiration = Math.min(...pendingCheckoutExpirations);
	const delay = nextExpiration - checkoutNow;
	if (delay <= 0) {
		const expiredKeys = [...(billingSubscriptions?.items ?? [])]
			.filter((item) => {
				const expiresAt = getPendingCheckoutExpiration(item);
				return expiresAt !== null && expiresAt <= checkoutNow;
			})
			.map(getPendingCheckoutRefreshKey)
			.filter((key): key is string => key !== null)
			.filter((key) => !refreshedExpiredCheckoutKeys.has(key));
		if (expiredKeys.length === 0) return;
		void refreshExpiredPendingCheckouts().then(() => {
			for (const key of expiredKeys) refreshedExpiredCheckoutKeys.add(key);
		});
		return;
	}
	const timeout = window.setTimeout(
		() => {
			checkoutNow = Date.now();
		},
		Math.max(250, delay),
	);
	return () => window.clearTimeout(timeout);
});
</script>

<div class="flex-1 px-6 py-7">
	<section class="max-w-5xl">
		<div class="flex flex-col gap-3 border-b border-border-subtle pb-5 sm:flex-row sm:items-center sm:justify-between">
			<div>
				<h1 class="text-[18px] font-semibold text-text-primary tracking-tight">{m.page_title_billing({}, { locale })}</h1>
				<p class="mt-1 max-w-xl text-[13px] leading-5 text-text-tertiary">{m.billing_description({}, { locale })}</p>
			</div>
		</div>

		{#if catalogError}
			<div class="mt-4 flex items-start gap-2 rounded-md border border-error-soft/30 bg-error-bg p-3 text-[12px] text-error-soft">
				<AlertCircle class="mt-0.5 h-3.5 w-3.5 shrink-0" />
				<span class="break-all">{catalogError}</span>
			</div>
		{/if}

		{#if checkoutError}
			<div class="mt-4 flex items-start gap-2 rounded-md border border-error-soft/30 bg-error-bg p-3 text-[12px] text-error-soft">
				<AlertCircle class="mt-0.5 h-3.5 w-3.5 shrink-0" />
				<span class="break-all">{checkoutError}</span>
			</div>
		{/if}

		<section class="grid gap-3 py-5 md:grid-cols-3">
			<div class="rounded-[6px] border border-border-subtle px-3 py-3 md:col-span-2">
				<div class="text-[11px] uppercase tracking-wider text-text-tertiary">{m.billing_subscription({}, { locale })}</div>
				<div class="mt-2 truncate text-[14px] font-semibold text-text-primary">
					{#if catalogLoading && !billingCatalog}
						<span class="text-text-tertiary">{m.billing_loading({}, { locale })}</span>
					{:else if currentSubscription}
						{currentSubscription.productName ?? currentSubscription.productKey ?? m.billing_active_plan({}, { locale })}
					{:else if defaultPlanProduct}
						{defaultPlanProduct.name}
					{:else}
						{m.billing_no_subscription({}, { locale })}
					{/if}
				</div>
				{#if currentSubscription}
					<div class="mt-1 truncate text-[11px] text-text-tertiary">
						{currentSubscriptionLine()}
					</div>
				{:else if defaultPlanProduct}
					<div class="mt-1 truncate text-[11px] text-text-tertiary">
						{m.billing_default_subscription({}, { locale })}
					</div>
				{:else if billingCatalog?.payment.available === false}
					<div class="mt-1 truncate text-[11px] text-text-tertiary">
						{m.billing_payment_unavailable(
							{ reason: billingCatalog.payment.reason ?? m.billing_no_provider({}, { locale }) },
							{ locale },
						)}
					</div>
				{/if}
			</div>
			<div class="rounded-[6px] border border-border-subtle px-3 py-3">
				<div class="flex items-center gap-2 text-[11px] uppercase tracking-wider text-text-tertiary">
					<Wallet class="h-3.5 w-3.5" />
					<span>{m.billing_balance({}, { locale })}</span>
				</div>
				<div class="mt-2 font-mono text-[18px] font-semibold tracking-tight {balanceCredit && balanceCredit.netUsd < 0 ? 'text-error-soft' : 'text-text-primary'}">
					{#if creditLoading && !balanceCredit}
						<span class="text-text-tertiary">{m.billing_loading({}, { locale })}</span>
					{:else}
						{formatUsdAmount(balanceCredit?.netUsd ?? 0)}
					{/if}
				</div>
			</div>
		</section>

		<div class="border-b border-border-subtle">
			<div class="flex gap-1">
				<button type="button" onclick={() => setBillingTab("balance")} class="border-b-2 px-3 py-2 text-[12px] font-medium transition-colors {activeBillingTab === 'balance' ? 'border-brand text-text-primary' : 'border-transparent text-text-tertiary hover:text-text-secondary'}">{m.billing_tab_balance({}, { locale })}</button>
				<button type="button" onclick={() => setBillingTab("plans")} class="border-b-2 px-3 py-2 text-[12px] font-medium transition-colors {activeBillingTab === 'plans' ? 'border-brand text-text-primary' : 'border-transparent text-text-tertiary hover:text-text-secondary'}">{m.billing_tab_plans({}, { locale })}</button>
				<button type="button" onclick={() => setBillingTab("redeem")} class="border-b-2 px-3 py-2 text-[12px] font-medium transition-colors {activeBillingTab === 'redeem' ? 'border-brand text-text-primary' : 'border-transparent text-text-tertiary hover:text-text-secondary'}">{m.billing_tab_redeem({}, { locale })}</button>
			</div>
		</div>

		{#if activeBillingTab === "plans"}
		<section class="py-5">
			<PurchasePanel
				flow={purchase}
				{locale}
				signedIn
				focus={purchase.focus()}
				onbuy={buyFromSettings}
			/>

			<div class="mt-6 border-t border-border-subtle pt-5">
				<div class="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
					<div>
						<h2 class="text-[14px] font-medium text-text-primary">{m.billing_subscriptions_heading({}, { locale })}</h2>
					</div>
					<div class="flex items-center gap-2 text-[11px] text-text-tertiary">
						<button type="button" onclick={() => goToSubscriptionsPage(subscriptionsPage - 1)} disabled={subscriptionsLoading || subscriptionsPage <= 1} class="inline-flex h-7 w-7 items-center justify-center rounded-[5px] border border-border-subtle bg-bg-input transition-colors hover:bg-bg-hover disabled:cursor-not-allowed disabled:opacity-45" title={m.billing_prev_subs_title({}, { locale })}>
							<ChevronLeft class="h-3.5 w-3.5" />
						</button>
						<span>{m.billing_page({ page: subscriptionsPage }, { locale })}</span>
						<button type="button" onclick={() => goToSubscriptionsPage(subscriptionsPage + 1)} disabled={subscriptionsLoading || !subscriptionsHasMore} class="inline-flex h-7 w-7 items-center justify-center rounded-[5px] border border-border-subtle bg-bg-input transition-colors hover:bg-bg-hover disabled:cursor-not-allowed disabled:opacity-45" title={m.billing_next_subs_title({}, { locale })}>
							<ChevronRight class="h-3.5 w-3.5" />
						</button>
					</div>
				</div>

				{#if subscriptionsError}
					<div class="mt-3 flex items-start gap-2 rounded-md border border-error-soft/30 bg-error-bg p-3 text-[12px] text-error-soft">
						<AlertCircle class="mt-0.5 h-3.5 w-3.5 shrink-0" />
						<span class="break-all">{subscriptionsError}</span>
					</div>
				{/if}

				{#if subscriptionsLoading && !billingSubscriptions}
					<div class="mt-3 h-32 rounded-[6px] bg-bg-hover-strong" aria-hidden="true"></div>
				{:else if !billingSubscriptions || billingSubscriptions.items.length === 0}
					<p class="mt-4 text-[12px] text-text-tertiary">{m.billing_no_subscriptions_yet({}, { locale })}</p>
				{:else}
					<div class="mt-3 divide-y divide-border-subtle rounded-[6px] border border-border-subtle">
						{#each billingSubscriptions.items as subscription (subscription.id)}
							<div class="grid gap-3 px-3 py-3 text-[12px] md:grid-cols-[1.2fr_0.9fr_1.4fr_0.7fr_auto] md:items-center">
								<div class="min-w-0">
									<div class="truncate font-medium text-text-primary">{subscription.productName}</div>
									<div class="mt-0.5 truncate font-mono text-[10px] text-text-placeholder">{shortIdentifier(subscription.id)}</div>
								</div>
								<div class="min-w-0">
									<div class="truncate text-text-secondary">{formatHistoryStatus(subscription.status)}</div>
									{#if subscription.cancelAtPeriodEnd}
										<div class="mt-0.5 text-[11px] text-text-tertiary">{m.billing_auto_renew_canceled({}, { locale })}</div>
									{/if}
								</div>
								<div class="min-w-0 text-text-tertiary">
									<div class="truncate">{formatPeriod(subscription)}</div>
									{#if formatCheckoutCountdown(subscription)}
										<div class="mt-0.5 flex items-center gap-1.5 text-[11px] {isCheckoutExpired(subscription) ? 'text-error-soft' : 'text-text-tertiary'}">
											<Clock class="h-3 w-3 shrink-0" />
											<span>{m.billing_checkout({ countdown: formatCheckoutCountdown(subscription) }, { locale })}</span>
										</div>
									{/if}
								</div>
								<div class="font-mono text-text-primary md:text-right">{historyAmount(subscription)}</div>
								<div class="flex flex-wrap gap-2 md:justify-end">
									{#if canPayCheckout(subscription)}
										<button type="button" onclick={() => payCheckout(subscription)} class="inline-flex h-7 items-center justify-center rounded-[5px] border border-border-subtle bg-bg-input px-2.5 text-[11px] font-medium text-text-primary transition-colors hover:bg-bg-hover">{m.billing_pay({}, { locale })}</button>
									{/if}
									{#if subscription.actions.canCancelCheckout}
										<button type="button" onclick={() => cancelSubscriptionCheckout(subscription)} disabled={billingActionBusyKey !== null} class="inline-flex h-7 items-center justify-center rounded-[5px] border border-border-subtle bg-bg-input px-2.5 text-[11px] font-medium text-text-primary transition-colors hover:bg-bg-hover disabled:cursor-not-allowed disabled:opacity-55">
											{#if billingActionBusyKey === `subscription:${subscription.id}:cancel-checkout`}
												<Loader2 class="mr-1 h-3 w-3 animate-spin" />
											{/if}
											<span>{m.billing_cancel({}, { locale })}</span>
										</button>
									{:else if subscription.actions.canCancelAutoRenew}
										<button type="button" onclick={() => cancelSubscriptionAutoRenew(subscription)} disabled={billingActionBusyKey !== null} class="inline-flex h-7 items-center justify-center rounded-[5px] border border-border-subtle bg-bg-input px-2.5 text-[11px] font-medium text-text-primary transition-colors hover:bg-bg-hover disabled:cursor-not-allowed disabled:opacity-55">
											{#if billingActionBusyKey === `subscription:${subscription.id}:cancel-auto-renew`}
												<Loader2 class="mr-1 h-3 w-3 animate-spin" />
											{/if}
											<span>{m.billing_cancel_auto_renew({}, { locale })}</span>
										</button>
									{:else}
										<span class="self-center text-[11px] text-text-placeholder">{m.billing_no_actions({}, { locale })}</span>
									{/if}
								</div>
							</div>
						{/each}
					</div>
				{/if}
			</div>
		</section>
		{/if}

		{#if activeBillingTab === "redeem"}
		<section class="border-t border-border-subtle py-5">
			<div class="max-w-xl">
				<h2 class="text-[14px] font-medium text-text-primary">{m.billing_redeem_code({}, { locale })}</h2>
				<form class="mt-4 flex flex-col gap-2 sm:flex-row" onsubmit={createRedemption}>
					<label class="sr-only" for="billing-redemption-code">{m.billing_redemption_code_label({}, { locale })}</label>
					<input id="billing-redemption-code" bind:value={redemptionCode} autocomplete="off" spellcheck="false" disabled={redemptionLoading} class="h-9 min-w-0 flex-1 rounded-[5px] border border-border-subtle bg-bg-input px-3 font-mono text-[13px] text-text-primary outline-none transition-colors placeholder:text-text-placeholder focus:border-brand disabled:cursor-not-allowed disabled:opacity-55" placeholder={m.billing_redemption_code_placeholder({}, { locale })} />
					<button type="submit" disabled={redemptionLoading || !redemptionCode.trim()} class="inline-flex h-9 items-center justify-center rounded-[5px] border border-border-subtle bg-bg-input px-3 text-[12px] font-medium text-text-primary transition-colors hover:bg-bg-hover disabled:cursor-not-allowed disabled:opacity-55">
						{#if redemptionLoading}
							<Loader2 class="mr-1.5 h-3.5 w-3.5 animate-spin" />
							<span>{m.billing_redeeming({}, { locale })}</span>
						{:else}
							<Gift class="mr-1.5 h-3.5 w-3.5" />
							<span>{m.billing_redeem({}, { locale })}</span>
						{/if}
					</button>
				</form>
				{#if redemptionError}
					<div class="mt-4 flex items-start gap-2 rounded-md border border-error-soft/30 bg-error-bg p-3 text-[12px] text-error-soft">
						<AlertCircle class="mt-0.5 h-3.5 w-3.5 shrink-0" />
						<span class="break-all">{redemptionError}</span>
					</div>
				{/if}
				{#if redemptionSuccess}
					<div class="mt-4 rounded-md border border-success-soft/30 bg-success-bg p-3 text-[12px] text-success-soft">
						{redemptionSuccess}
					</div>
				{/if}
			</div>
		</section>
		{/if}

		{#if activeBillingTab === "balance"}
		<section class="border-t border-border-subtle py-5">
			<h2 class="text-[14px] font-medium text-text-primary">{m.billing_balance_heading({}, { locale })}</h2>
		{#if creditError}
			<div class="mt-4 flex items-start gap-2 rounded-md border border-error-soft/30 bg-error-bg p-3 text-[12px] text-error-soft">
				<AlertCircle class="mt-0.5 h-3.5 w-3.5 shrink-0" />
				<span class="break-all">{creditError}</span>
			</div>
		{/if}

		{#if creditLoading && !balanceCredit}
			<div class="mt-3 h-24 rounded-[6px] bg-bg-hover-strong" aria-hidden="true"></div>
		{:else if balanceCredit}
			<section class="py-5">
				<h2 class="text-[13px] font-medium text-text-primary">{m.billing_balance_by_expiration({}, { locale })}</h2>
				{#if balanceCredit.groups.length === 0}
					<p class="mt-3 text-[12px] text-text-tertiary">{m.billing_no_balance_sources({}, { locale })}</p>
				{:else}
					<div class="mt-3 divide-y divide-border-subtle rounded-[6px] border border-border-subtle">
						{#each balanceCredit.groups as group (group.key)}
							<div class="px-3 py-3">
								<div class="flex min-w-0 items-center justify-between gap-3">
									<div class="min-w-0">
										<div class="truncate text-[12px] font-medium text-text-primary">{getExpiryGroupLabel(group.key)}</div>
										<div class="mt-0.5 truncate text-[11px] text-text-tertiary">{group.grants.length === 1 ? m.billing_grants_one({ count: group.grants.length }, { locale }) : m.billing_grants_many({ count: group.grants.length }, { locale })}</div>
									</div>
									<div class="shrink-0 font-mono text-[13px] text-text-primary">{formatUsdAmount(group.remainingAmountUsd)}</div>
								</div>
								<div class="mt-2 grid gap-2">
									{#each group.grants as grant (grant.id)}
										<div class="rounded-[5px] bg-bg-subtle px-2.5 py-2 text-[11px]">
											<div class="grid gap-1 sm:grid-cols-[1fr_auto]">
												<div class="min-w-0">
													<div class="flex min-w-0 items-center gap-2">
														<div class="truncate text-text-secondary">{grant.benefitName ?? grant.grantKind ?? m.billing_balance_source({}, { locale })}</div>
														<span class="shrink-0 rounded-[4px] border border-border-subtle px-1.5 py-0.5 text-[10px] leading-none {isGrantDisplayActive(grant) ? 'text-text-tertiary' : 'text-text-placeholder'}">{getGrantDisplayStatus(grant)}</span>
													</div>
													<div class="mt-0.5 flex min-w-0 items-center gap-1.5 text-text-tertiary">
														<Clock class="h-3 w-3 shrink-0" />
														<span class="truncate">{formatBillingDate(grant.expiresAt)}</span>
													</div>
												</div>
												<div class="font-mono {grant.remainingAmountUsd > 0 ? 'text-text-secondary' : 'text-text-placeholder'} sm:text-right">{formatUsdAmount(grant.remainingAmountUsd)}</div>
											</div>
											<div class="mt-2">
												<div class="flex min-w-0 items-center justify-between gap-3 text-[10px]">
													<span class="truncate text-text-tertiary">
														{m.billing_used({ amount: formatUsdAmount(grant.consumedAmountUsd ?? 0) }, { locale })}
														{#if grant.originalAmountUsd !== null}
															{m.billing_of({ amount: formatUsdAmount(grant.originalAmountUsd) }, { locale })}
														{/if}
													</span>
													<span class="shrink-0 font-mono text-text-tertiary">{grant.consumedPercent === null ? "0%" : `${grant.consumedPercent}%`}</span>
												</div>
												<div class="mt-1 h-1.5 overflow-hidden rounded-full bg-bg-hover-strong" aria-hidden="true">
													<div class="h-full rounded-full bg-brand/70" style={`width: ${grantConsumedPercent(grant.consumedPercent)}%`}></div>
												</div>
												{#if (grant.usageConsumedAmountUsd ?? 0) > 0 || (grant.settledOverageAmountUsd ?? 0) > 0}
													<div class="mt-1.5 flex flex-wrap gap-x-3 gap-y-1 font-mono text-[10px] text-text-placeholder">
														<span>{m.billing_usage({ amount: formatUsdAmount(grant.usageConsumedAmountUsd ?? 0) }, { locale })}</span>
														{#if (grant.settledOverageAmountUsd ?? 0) > 0}
															<span>{m.billing_overage_settled({ amount: formatUsdAmount(grant.settledOverageAmountUsd ?? 0) }, { locale })}</span>
														{/if}
													</div>
												{/if}
											</div>
										</div>
									{/each}
								</div>
							</div>
						{/each}
					</div>
				{/if}
			</section>

			<section class="border-t border-border-subtle py-5">
				<div class="flex items-center justify-between gap-3">
					<div>
						<h2 class="text-[13px] font-medium text-text-primary">{m.billing_activity_heading({}, { locale })}</h2>
					</div>
					<div class="flex items-center gap-1">
						<button type="button" onclick={() => goToActivityPage(activityPage - 1)} disabled={activityLoading || activityPage <= 1} class="rounded-[5px] p-1.5 text-text-tertiary transition-colors hover:bg-bg-hover hover:text-text-secondary disabled:opacity-40" title={m.billing_prev_page({}, { locale })}>
							<ChevronLeft class="h-3.5 w-3.5" />
						</button>
						<span class="min-w-14 text-center font-mono text-[11px] text-text-tertiary">{m.billing_page({ page: activityPage }, { locale })}</span>
						<button type="button" onclick={() => goToActivityPage(activityPage + 1)} disabled={activityLoading || !activityHasMore} class="rounded-[5px] p-1.5 text-text-tertiary transition-colors hover:bg-bg-hover hover:text-text-secondary disabled:opacity-40" title={m.billing_next_page({}, { locale })}>
							<ChevronRight class="h-3.5 w-3.5" />
						</button>
					</div>
				</div>

				{#if activityError}
					<div class="mt-4 flex items-start gap-2 rounded-md border border-error-soft/30 bg-error-bg p-3 text-[12px] text-error-soft">
						<AlertCircle class="mt-0.5 h-3.5 w-3.5 shrink-0" />
						<span class="break-all">{activityError}</span>
					</div>
				{:else if activityLoading && !balanceActivities}
					<div class="mt-3 h-20 rounded-[6px] bg-bg-hover-strong" aria-hidden="true"></div>
				{:else if !balanceActivities || balanceActivities.items.length === 0}
					<p class="mt-4 text-[12px] text-text-tertiary">{m.billing_no_activity({}, { locale })}</p>
				{:else}
					<div class="mt-3 overflow-hidden rounded-[6px] border border-border-subtle">
						<div class="grid grid-cols-[minmax(0,1fr)_8rem] gap-3 border-b border-border-subtle bg-bg-subtle px-3 py-2 text-[11px] font-medium uppercase tracking-wider text-text-tertiary sm:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)_8rem]">
							<span>{m.billing_activity_header({}, { locale })}</span>
							<span class="hidden sm:block">{m.billing_reference_header({}, { locale })}</span>
							<span class="text-right">{m.billing_change_header({}, { locale })}</span>
						</div>
						<div class="divide-y divide-border-subtle">
							{#each balanceActivities.items as item (item.id)}
								<div class="grid grid-cols-[minmax(0,1fr)_8rem] gap-3 px-3 py-3 text-[12px] sm:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)_8rem]">
									<div class="min-w-0">
										<div class="flex min-w-0 items-center gap-2">
											<div class="truncate font-medium text-text-primary">{item.title}</div>
											{#if activityStatusLabel(item.status)}
												<span class="shrink-0 rounded-[4px] border border-border-subtle px-1.5 py-0.5 text-[10px] leading-none text-text-tertiary">{activityStatusLabel(item.status)}</span>
											{/if}
										</div>
										<div class="mt-0.5 text-[11px] text-text-tertiary">{formatBillingDate(item.createdAt)}</div>
										<div class="mt-1 min-w-0 sm:hidden">
											<div class="truncate font-mono text-[11px] text-text-tertiary" title={item.operationId ?? item.sourceId ?? ""}>{shortIdentifier(item.operationId ?? item.sourceId)}</div>
											<div class="mt-0.5 truncate text-[11px] text-text-placeholder">{item.description ?? item.sourceType ?? ""}</div>
										</div>
									</div>
									<div class="hidden min-w-0 sm:block">
										<div class="truncate font-mono text-[11px] text-text-tertiary" title={item.operationId ?? item.sourceId ?? ""}>{shortIdentifier(item.operationId ?? item.sourceId)}</div>
										<div class="mt-0.5 truncate text-[11px] text-text-placeholder">{item.description ?? item.sourceType ?? ""}</div>
									</div>
									<div class="font-mono text-[12px] {item.amountUsd < 0 ? 'text-text-primary' : 'text-success-soft'} sm:text-right">{formatUsdAmount(item.amountUsd)}</div>
								</div>
							{/each}
						</div>
					</div>
				{/if}
			</section>
			{/if}
			</section>
		{/if}
	</section>
</div>
