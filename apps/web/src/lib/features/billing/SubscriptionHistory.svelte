<script lang="ts">
import type {
	BillingSubscriptionHistoryList,
	BillingSubscriptionHistoryStatus,
} from "@neta-art/cohub";
import { ChevronLeft, ChevronRight, Clock, Loader2 } from "lucide-svelte";
import { ensureAuth } from "$lib/auth";
import { handleUnauthorizedError } from "$lib/auth-redirect";
import { onSettingsPageActive } from "$lib/features/settings/page-context.svelte";
import { formatDateTime } from "$lib/i18n/format";
import type { Locale } from "$lib/i18n/locale";
import { m } from "$lib/paraglide/messages.js";
import { sdk } from "$lib/sdk";
import { formatMoney } from "./format";
import { subscriptionDisplayState } from "./product";
import { announceBillingChange, onBillingChange } from "./refresh";

const { locale }: { locale: Locale } = $props();

let list = $state.raw<BillingSubscriptionHistoryList | null>(null);
let page = $state(1);
let loading = $state(false);
let error = $state("");
let busyKey = $state<string | null>(null);
let now = $state(Date.now());
const refreshedExpiries = new Set<string>();

const pendingExpiries = $derived(
	(list?.items ?? []).flatMap((item) => {
		const at = checkoutExpiry(item);
		return at === null ? [] : [at];
	}),
);

function checkoutExpiry(item: BillingSubscriptionHistoryStatus) {
	if (item.status !== "pending_checkout" || !item.checkoutExpiresAt)
		return null;
	const at = Date.parse(item.checkoutExpiresAt);
	return Number.isNaN(at) ? null : at;
}

function formatDate(value: string | null | undefined) {
	return value
		? formatDateTime(value, locale, { dateStyle: "medium" })
		: m.billing_no_expiration({}, { locale });
}

function statusLabel(item: BillingSubscriptionHistoryStatus) {
	if (subscriptionDisplayState(item, now) === "closing")
		return m.billing_recovery_processing({}, { locale });
	switch (item.status) {
		case "active":
			return m.billing_status_active({}, { locale });
		case "trialing":
			return m.billing_status_trialing({}, { locale });
		case "past_due":
			return m.billing_recovery_pending({}, { locale });
		case "pending_checkout":
			return m.billing_status_pending_checkout({}, { locale });
		case "ended":
		case "canceled":
			return m.billing_status_ended({}, { locale });
		default:
			return item.status.replace(/[._-]+/g, " ");
	}
}

function period(item: BillingSubscriptionHistoryStatus) {
	const { currentPeriodStart: start, currentPeriodEnd: end } = item;
	if (!start && !end) return m.billing_no_active_period({}, { locale });
	if (!start) return m.billing_until({ date: formatDate(end) }, { locale });
	if (!end) return m.billing_from({ date: formatDate(start) }, { locale });
	return `${formatDate(start)} – ${formatDate(end)}`;
}

function countdown(item: BillingSubscriptionHistoryStatus) {
	const at = checkoutExpiry(item);
	if (at === null) return "";
	const remaining = at - now;
	if (remaining <= 0) return m.billing_checkout_expired({}, { locale });
	const total = Math.ceil(remaining / 1000);
	const hours = Math.floor(total / 3600);
	const minutes = Math.floor((total % 3600) / 60);
	const seconds = total % 60;
	if (hours > 0)
		return m.billing_countdown_hms({ hours, minutes, seconds }, { locale });
	if (minutes > 0)
		return m.billing_countdown_ms({ minutes, seconds }, { locale });
	return m.billing_countdown_s({ seconds }, { locale });
}

const expired = (item: BillingSubscriptionHistoryStatus) => {
	const at = checkoutExpiry(item);
	return at !== null && at <= now;
};

async function load(next = page) {
	if (loading || !(await ensureAuth())) return;
	loading = true;
	error = "";
	try {
		const { subscriptions } = await sdk.billing.getSubscriptions({
			page: Math.max(1, next),
			limit: 10,
		});
		list = subscriptions;
		page = subscriptions.page;
	} catch (cause) {
		if (await handleUnauthorizedError(cause)) return;
		error =
			cause instanceof Error
				? cause.message
				: m.billing_subscriptions_load_failed({}, { locale });
	} finally {
		loading = false;
	}
}

async function act(
	item: BillingSubscriptionHistoryStatus,
	action: "cancel-checkout" | "cancel-auto-renew",
) {
	const checkout = action === "cancel-checkout";
	const confirmText = checkout
		? m.billing_cancel_checkout_confirm({}, { locale })
		: m.billing_cancel_autorenew_confirm({}, { locale });
	if (busyKey || !window.confirm(confirmText)) return;
	busyKey = `${item.id}:${action}`;
	error = "";
	try {
		if (checkout) await sdk.billing.cancelSubscriptionCheckout(item.id);
		else await sdk.billing.cancelSubscriptionAutoRenew(item.id);
		announceBillingChange();
	} catch (cause) {
		if (await handleUnauthorizedError(cause)) return;
		error =
			cause instanceof Error
				? cause.message
				: checkout
					? m.billing_cancel_checkout_failed({}, { locale })
					: m.billing_cancel_autorenew_failed({}, { locale });
	} finally {
		busyKey = null;
	}
}

onSettingsPageActive(() => void load());

$effect(() => onBillingChange(() => void load()));

$effect(() => {
	if (pendingExpiries.length === 0) return;
	now = Date.now();
	const interval = window.setInterval(() => (now = Date.now()), 1000);
	return () => window.clearInterval(interval);
});

$effect(() => {
	const due = (list?.items ?? []).filter(
		(item) =>
			expired(item) &&
			!refreshedExpiries.has(`${item.id}:${item.checkoutExpiresAt}`),
	);
	if (due.length === 0) return;
	for (const item of due)
		refreshedExpiries.add(`${item.id}:${item.checkoutExpiresAt}`);
	announceBillingChange();
});
</script>

<section class="mt-8" aria-labelledby="billing-subscriptions-heading">
	<div class="flex items-center justify-between gap-3">
		<h2 id="billing-subscriptions-heading" class="text-[13px] font-medium text-text-primary">{m.billing_subscriptions_heading({}, { locale })}</h2>
		{#if page > 1 || list?.pagination.hasMore}
			<div class="flex items-center gap-1 text-text-tertiary">
				<button type="button" class="rounded-[5px] p-1.5 transition-colors hover:bg-bg-hover hover:text-text-secondary disabled:opacity-40" onclick={() => load(page - 1)} disabled={loading || page <= 1} aria-label={m.billing_prev_page({}, { locale })}><ChevronLeft class="h-3.5 w-3.5" /></button>
				<span class="min-w-10 text-center font-mono text-[11px] tabular-nums">{page}</span>
				<button type="button" class="rounded-[5px] p-1.5 transition-colors hover:bg-bg-hover hover:text-text-secondary disabled:opacity-40" onclick={() => load(page + 1)} disabled={loading || !list?.pagination.hasMore} aria-label={m.billing_next_page({}, { locale })}><ChevronRight class="h-3.5 w-3.5" /></button>
			</div>
		{/if}
	</div>

	{#if error}
		<p class="mt-3 text-[12px] text-error-soft" role="alert">{error}</p>
	{/if}

	{#if !list}
		<div class="mt-3 h-16 rounded-[6px] bg-bg-hover-strong" aria-hidden="true"></div>
	{:else if list.items.length === 0}
		<p class="mt-3 text-[12px] text-text-tertiary">{m.billing_no_subscriptions_yet({}, { locale })}</p>
	{:else}
		<ul class="mt-2 divide-y divide-border-subtle">
			{#each list.items as item (item.id)}
				<li class="grid gap-x-4 gap-y-1 py-2.5 text-[12px] sm:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)_6rem_auto] sm:items-center">
					<div class="min-w-0">
						<div class="truncate font-medium text-text-primary">{item.productName}</div>
						<div class="mt-0.5 truncate text-[11px] text-text-tertiary">
							{statusLabel(item)}{#if item.cancelAtPeriodEnd} · {m.billing_auto_renew_canceled({}, { locale })}{/if}
						</div>
					</div>
					<div class="min-w-0 text-text-tertiary">
						<div class="truncate">{period(item)}</div>
						{#if countdown(item)}
							<div class="mt-0.5 flex items-center gap-1.5 text-[11px] {expired(item) ? 'text-error-soft' : ''}">
								<Clock class="h-3 w-3 shrink-0" />
								<span>{m.billing_checkout({ countdown: countdown(item) }, { locale })}</span>
							</div>
						{/if}
					</div>
					<div class="font-mono tabular-nums text-text-secondary sm:text-right">{formatMoney(item.paidAmountUsd > 0 ? item.paidAmountUsd : item.amountUsd, locale)}</div>
					<div class="flex gap-2 sm:justify-end">
						{#if item.actions.canPay && item.actions.checkoutUrl && !expired(item)}
							<a href={item.actions.checkoutUrl} class="secondary-key inline-flex h-7 items-center px-2.5 text-[11px] font-medium">{m.billing_pay({}, { locale })}</a>
						{/if}
						{#if item.actions.canCancelCheckout || item.actions.canCancelAutoRenew}
							{@const action = item.actions.canCancelCheckout ? "cancel-checkout" : "cancel-auto-renew"}
							<button type="button" class="inline-flex h-7 items-center gap-1 rounded-[5px] px-2 text-[11px] text-text-tertiary transition-colors hover:bg-bg-hover hover:text-text-secondary disabled:opacity-50" onclick={() => act(item, action)} disabled={busyKey !== null}>
								{#if busyKey === `${item.id}:${action}`}<Loader2 class="h-3 w-3 animate-spin" />{/if}
								{action === "cancel-checkout" ? m.billing_cancel({}, { locale }) : m.billing_cancel_auto_renew({}, { locale })}
							</button>
						{/if}
					</div>
				</li>
			{/each}
		</ul>
	{/if}
</section>
