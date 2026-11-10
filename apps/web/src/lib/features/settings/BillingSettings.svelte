<script lang="ts">
import { BarChart3, CreditCard, Gift, Loader2 } from "lucide-svelte";
import { tick } from "svelte";
import { goto } from "$app/navigation";
import { page } from "$app/state";
import { ensureAuth } from "$lib/auth";
import { handleUnauthorizedError } from "$lib/auth-redirect";
import BalanceLedger from "$lib/features/billing/BalanceLedger.svelte";
import CreditSources from "$lib/features/billing/CreditSources.svelte";
import { formatBalance } from "$lib/features/billing/format";
import { trackPurchase } from "$lib/features/billing/funnel";
import PurchasePanel from "$lib/features/billing/PurchasePanel.svelte";
import {
	currentCatalogSubscription,
	type PurchaseFocus,
	subscriptionDisplayState,
} from "$lib/features/billing/product";
import { PurchaseFlow } from "$lib/features/billing/purchase.svelte";
import {
	announceBillingChange,
	onBillingChange,
} from "$lib/features/billing/refresh";
import SubscriptionHistory from "$lib/features/billing/SubscriptionHistory.svelte";
import * as account from "$lib/features/settings/account-data";
import {
	onSettingsPageActive,
	settingsPageActive,
} from "$lib/features/settings/page-context.svelte";
import { formatDate } from "$lib/i18n/format";
import { getLocale } from "$lib/i18n/locale.svelte";
import { m } from "$lib/paraglide/messages.js";
import { sdk } from "$lib/sdk";
import { billingCatalogStore } from "$lib/stores/billing-catalog.svelte";

type Tab = "activity" | "plans";

const locale = $derived(getLocale());
const active = settingsPageActive();
const purchase = new PurchaseFlow("settings");

let tab = $state<Tab>("activity");
let planFocus = $state<PurchaseFocus | null>(null);
let catalogError = $state("");
let redeemOpen = $state(false);
let redeemCode = $state("");
let redeeming = $state(false);
let redeemError = $state("");
let redeemDone = $state(false);
let redeemInput = $state<HTMLInputElement | null>(null);

const credit = $derived(account.billingCredits.data);
const catalog = $derived(billingCatalogStore.catalog);
const subscription = $derived(
	catalog ? currentCatalogSubscription(catalog) : null,
);
const defaultPlan = $derived(
	catalog?.plans.find((plan) => plan.key === catalog.defaultPlanProductKey) ??
		null,
);
const hasPaidPlan = $derived(
	Boolean(
		subscription && subscription.productKey !== catalog?.defaultPlanProductKey,
	),
);
const expiringSoonUsd = $derived(
	credit?.groups.find((group) => group.key === "lt_7d")?.remainingAmountUsd ??
		0,
);

const planName = $derived(
	subscription?.productName ??
		subscription?.productKey ??
		defaultPlan?.name ??
		m.sidebar_free_plan({}, { locale }),
);

const planDetail = $derived.by(() => {
	if (!subscription) return "";
	const state = subscriptionDisplayState(subscription);
	if (state === "closing") return m.billing_recovery_processing({}, { locale });
	if (state === "grace") return m.billing_recovery_pending({}, { locale });
	if (!subscription.currentPeriodEnd) return "";
	const date = formatDate(subscription.currentPeriodEnd, locale);
	return subscription.cancelAtPeriodEnd
		? m.billing_plan_ends({ date }, { locale })
		: m.billing_plan_renews({ date }, { locale });
});

const tabs = $derived<[Tab, string][]>([
	["activity", m.billing_tab_activity({}, { locale })],
	["plans", m.billing_tab_plans({}, { locale })],
]);

function setTab(next: Tab, focus: PurchaseFocus | null = null) {
	tab = next;
	planFocus = focus;
	const target = new URL(page.url);
	if (next === "plans") target.searchParams.set("tab", "plans");
	else target.searchParams.delete("tab");
	void goto(`${target.pathname}${target.search}${target.hash}`, {
		replaceState: true,
		keepFocus: true,
		noScroll: true,
	});
}

async function openRedeem() {
	redeemOpen = !redeemOpen;
	redeemDone = false;
	redeemError = "";
	await tick();
	redeemInput?.focus();
}

async function redeem(event: SubmitEvent) {
	event.preventDefault();
	const code = redeemCode.trim();
	if (redeeming || !code) return;
	redeeming = true;
	redeemError = "";
	redeemDone = false;
	try {
		const { redemption } = await sdk.billing.createRedemption({ code });
		if (!redemption.redeemed) {
			redeemError =
				redemption.message ?? m.billing_redeem_failed({}, { locale });
			return;
		}
		redeemCode = "";
		redeemDone = true;
		announceBillingChange();
	} catch (error) {
		if (await handleUnauthorizedError(error)) return;
		redeemError =
			error instanceof Error
				? error.message
				: m.billing_redeem_failed({}, { locale });
	} finally {
		redeeming = false;
	}
}

async function loadCatalog(force = false) {
	if (!(await ensureAuth())) return;
	catalogError = "";
	try {
		await billingCatalogStore.load({ force, silent: Boolean(catalog) });
		purchase.ensureSelection();
		await purchase.restoreRenewalIntent();
	} catch (error) {
		if (await handleUnauthorizedError(error)) return;
		catalogError =
			error instanceof Error
				? error.message
				: m.billing_catalog_load_failed({}, { locale });
	}
}

function buy() {
	void purchase.checkout({
		returnTo: new URL("/settings/billing?tab=plans", window.location.origin),
	});
}

$effect(() => {
	if (!active()) return;
	const requested = page.url.searchParams.get("tab");
	tab = requested === "plans" ? "plans" : "activity";
	if (requested === "redeem") redeemOpen = true;
	if (tab === "plans")
		trackPurchase({
			name: "purchase_open",
			source: "settings",
			focus: purchase.focus(),
		});
});

onSettingsPageActive(() => {
	void loadCatalog();
	void account.billingCredits.load();
});

$effect(() =>
	onBillingChange(() => {
		void loadCatalog(true);
		void account.billingCredits.load({ force: true });
	}),
);
</script>

<div class="flex-1 px-6 py-7">
	<div class="max-w-4xl">
		<h1 class="text-[18px] font-semibold tracking-tight text-text-primary">{m.page_title_billing({}, { locale })}</h1>

		<section class="mt-5 flex flex-col gap-5 border-b border-border-subtle pb-6 sm:flex-row sm:items-end sm:justify-between" aria-label={m.billing_balance({}, { locale })}>
			<div class="min-w-0">
				<div class="text-[11px] font-medium uppercase tracking-wider text-text-tertiary">{m.billing_balance({}, { locale })}</div>
				<div class="mt-1.5 h-9 font-mono text-[30px] font-semibold leading-9 tracking-tight tabular-nums {credit && credit.netUsd < 0 ? 'text-error-soft' : 'text-text-primary'}">
					{#if credit}
						{formatBalance(credit.netUsd, locale)}
					{:else if account.billingCredits.error}
						<span class="text-[13px] font-normal text-error-soft">{account.billingCredits.errorMessage(m.billing_load_failed({}, { locale }))}</span>
					{:else}
						<span class="inline-block h-7 w-36 rounded-[5px] bg-bg-hover-strong align-middle" aria-hidden="true"></span>
					{/if}
				</div>
				{#if expiringSoonUsd > 0}
					<p class="mt-1.5 text-[12px] text-warning-soft">{m.billing_expiring_soon({ amount: formatBalance(expiringSoonUsd, locale) }, { locale })}</p>
				{/if}
				<div class="mt-4 flex min-w-0 items-center gap-2 text-[12px]">
					<CreditCard class="h-3.5 w-3.5 shrink-0 text-text-tertiary" />
					{#if catalog}
						<span class="truncate font-medium text-text-primary">{planName}</span>
						{#if planDetail}<span class="truncate text-text-tertiary">{planDetail}</span>{/if}
					{:else}
						<span class="h-3.5 w-28 rounded-[4px] bg-bg-hover-strong" aria-hidden="true"></span>
					{/if}
				</div>
			</div>
			<div class="flex flex-wrap items-center gap-2">
				<button type="button" class="primary-key h-8 px-3 text-[12px]" onclick={() => setTab("plans", "packs")}>{m.billing_top_up({}, { locale })}</button>
				<button type="button" class="secondary-key h-8 px-3 text-[12px]" onclick={() => setTab("plans", "plans")}>{hasPaidPlan ? m.billing_change_plan({}, { locale }) : m.billing_upgrade({}, { locale })}</button>
				<button type="button" class="inline-flex h-8 items-center gap-1.5 rounded-[6px] px-2 text-[12px] text-text-tertiary transition-colors hover:bg-bg-hover hover:text-text-secondary" aria-expanded={redeemOpen} onclick={openRedeem}>
					<Gift class="h-3.5 w-3.5" />{m.billing_redeem_code({}, { locale })}
				</button>
			</div>
		</section>

		{#if redeemOpen}
			<form class="flex flex-col gap-2 border-b border-border-subtle py-4 sm:flex-row sm:items-center" onsubmit={redeem}>
				<label class="sr-only" for="billing-redemption-code">{m.billing_redemption_code_label({}, { locale })}</label>
				<input id="billing-redemption-code" bind:this={redeemInput} bind:value={redeemCode} autocomplete="off" spellcheck="false" disabled={redeeming} placeholder={m.billing_redemption_code_placeholder({}, { locale })} class="h-8 min-w-0 rounded-[5px] border border-border-subtle bg-bg-input px-3 font-mono text-[13px] text-text-primary outline-none transition-colors placeholder:text-text-placeholder focus:border-brand disabled:opacity-55 sm:w-72" />
				<button type="submit" class="secondary-key h-8 px-3 text-[12px]" disabled={redeeming || !redeemCode.trim()}>
					{#if redeeming}<Loader2 class="h-3.5 w-3.5 animate-spin" />{/if}
					{m.billing_redeem({}, { locale })}
				</button>
				{#if redeemError}
					<span class="text-[12px] text-error-soft" role="alert">{redeemError}</span>
				{:else if redeemDone}
					<span class="text-[12px] text-success-soft" role="status">{m.billing_redeem_success({}, { locale })}</span>
				{/if}
			</form>
		{/if}

		{#if catalogError}
			<p class="mt-4 text-[12px] text-error-soft" role="alert">{catalogError}</p>
		{/if}

		<div class="mt-2 flex items-center justify-between gap-3 border-b border-border-subtle" role="tablist">
			<div class="flex gap-1">
				{#each tabs as [value, label] (value)}
					<button type="button" role="tab" aria-selected={tab === value} onclick={() => setTab(value)} class="-mb-px border-b-2 px-3 py-2 text-[12px] font-medium transition-colors {tab === value ? 'border-brand text-text-primary' : 'border-transparent text-text-tertiary hover:text-text-secondary'}">{label}</button>
				{/each}
			</div>
			{#if tab === "activity"}
				<a href="/settings/activity" class="inline-flex items-center gap-1.5 text-[11px] text-text-tertiary transition-colors hover:text-text-secondary">
					<BarChart3 class="h-3.5 w-3.5" />{m.billing_usage_breakdown({}, { locale })}
				</a>
			{/if}
		</div>

		{#if tab === "activity"}
			{#if credit}<CreditSources {credit} {locale} />{/if}
			<BalanceLedger {locale} />
		{:else}
			<section class="py-5">
				<PurchasePanel flow={purchase} {locale} signedIn focus={planFocus ?? purchase.focus()} onbuy={buy} />
				<SubscriptionHistory {locale} />
			</section>
		{/if}
	</div>
</div>
