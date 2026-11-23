<script lang="ts">
import type { BillingBalanceActivity } from "@neta-art/cohub";
import { ChevronRight, Loader2 } from "lucide-svelte";
import { untrack } from "svelte";
import { inScrollView } from "#lib/actions/in-scroll-view.ts";
import Segmented from "#lib/components/Segmented.svelte";
import * as account from "#lib/features/settings/account-data.ts";
import { settingsPageActive } from "#lib/features/settings/page-context.svelte.ts";
import { formatDate, formatDateTime } from "#lib/i18n/format.ts";
import type { Locale } from "#lib/i18n/locale.ts";
import { multiplierLabel } from "#lib/model-pricing.ts";
import { m } from "#lib/paraglide/messages.js";
import { formatBalance } from "./format.ts";
import {
	type LedgerRun,
	ledgerDays,
	quotedName,
	runPricing,
	transferActivityKind,
	usageSubject,
} from "./ledger.ts";
import { onBillingChange } from "./refresh.ts";

const { locale }: { locale: Locale } = $props();
const active = settingsPageActive();

let filter = $state<account.BillingActivityFilter>("all");
let expanded = $state<ReadonlySet<string>>(new Set());
let nearEnd = $state(false);
const feed = $derived(account.billingActivity(filter));
const days = $derived(ledgerDays(feed.items));

const filters = $derived([
	{ value: "all" as const, label: m.billing_filter_all({}, { locale }) },
	{ value: "usage" as const, label: m.billing_filter_usage({}, { locale }) },
	{ value: "grant" as const, label: m.billing_filter_grant({}, { locale }) },
	{ value: "refund" as const, label: m.billing_filter_refund({}, { locale }) },
]);

const USAGE_LABELS: Record<string, () => string> = {
	"generation.llm": () => m.billing_usage_llm({}, { locale }),
	"generation.llm.raw": () => m.billing_usage_completion({}, { locale }),
	"generation.decision": () => m.billing_usage_decision({}, { locale }),
	"generation.image": () => m.billing_usage_image({}, { locale }),
	"generation.video": () => m.billing_usage_video({}, { locale }),
	"generation.audio": () => m.billing_usage_audio({}, { locale }),
	"generation.music": () => m.billing_usage_audio({}, { locale }),
	"generation.3d": () => m.billing_usage_3d({}, { locale }),
	"sandbox.compute": () => m.billing_usage_sandbox({}, { locale }),
	"space.storage": () => m.billing_usage_storage({}, { locale }),
	"app.domain": () => m.billing_usage_domain({}, { locale }),
};

function title(item: BillingBalanceActivity) {
	const transfer = transferActivityKind(item);
	if (transfer === "out") return m.wallet_transfer_out({}, { locale });
	if (transfer === "returned")
		return m.wallet_transfer_returned({}, { locale });
	switch (item.kind) {
		case "usage":
			return USAGE_LABELS[item.usageType ?? ""]?.() ?? item.title;
		case "grant":
			return m.billing_kind_grant({}, { locale });
		case "reversal":
			return m.wallet_activity_reversal({}, { locale });
		case "refund":
			return m.wallet_activity_refund({}, { locale });
		case "expire":
			return m.billing_expired({}, { locale });
		case "revoke":
			return m.wallet_activity_revoke({}, { locale });
		case "adjust":
			return m.wallet_activity_adjust({}, { locale });
	}
}

function detail(item: BillingBalanceActivity) {
	if (transferActivityKind(item)) return quotedName(item.description);
	if (item.kind === "usage") return usageSubject(item);
	return item.description;
}

function dayLabel(date: Date) {
	const today = new Date();
	const yesterday = new Date(today);
	yesterday.setDate(today.getDate() - 1);
	if (date.toDateString() === today.toDateString())
		return m.billing_today({}, { locale });
	if (date.toDateString() === yesterday.toDateString())
		return m.billing_yesterday({}, { locale });
	return formatDate(date, locale, {
		weekday: "short",
		month: "short",
		day: "numeric",
		year: date.getFullYear() === today.getFullYear() ? undefined : "numeric",
	});
}

const time = (value: string) =>
	formatDateTime(value, locale, {
		year: undefined,
		month: undefined,
		day: undefined,
	});

function timeRange(run: LedgerRun) {
	const newest = time(run.first.createdAt);
	const oldest = time(run.items.at(-1)?.createdAt ?? run.first.createdAt);
	return newest === oldest ? newest : `${oldest}–${newest}`;
}

function toggle(id: string) {
	const next = new Set(expanded);
	if (!next.delete(id)) next.add(id);
	expanded = next;
}

function pricingSummary(pricing: NonNullable<ReturnType<typeof runPricing>>) {
	return [
		pricing.quota ? m.billing_pricing_quota(pricing.quota, { locale }) : "",
		pricing.multiplier !== null && pricing.multiplier < 1
			? m.billing_pricing_offer(
					{ label: multiplierLabel(pricing.multiplier, locale) },
					{ locale },
				)
			: "",
	]
		.filter(Boolean)
		.join(" · ");
}

function statusLabel(status: BillingBalanceActivity["status"]) {
	if (status === "overage") return m.billing_status_overage({}, { locale });
	if (status === "partial") return m.billing_status_partial({}, { locale });
	return "";
}

$effect(() => {
	const current = feed;
	if (active()) untrack(() => void current.load());
});

$effect(() => {
	if (nearEnd && feed.hasMore && !feed.loadingMore && !feed.moreFailed)
		void feed.loadMore();
});

$effect(() => onBillingChange(() => void feed.refresh()));
</script>

{#snippet amount(value: number, status: BillingBalanceActivity["status"] = null)}
	<span class="shrink-0 font-mono text-[12px] tabular-nums {value > 0 ? 'text-success-soft' : status && status !== 'covered' ? 'text-warning-soft' : 'text-text-primary'}">{formatBalance(value, locale)}</span>
{/snippet}

{#snippet runRow(run: LedgerRun, open: boolean)}
	{@const sub = detail(run.first)}
	{@const pricing = run.first.kind === "usage" ? runPricing(run.items) : null}
	{@const pricingText = pricing ? pricingSummary(pricing) : ""}
	<span class="flex w-3.5 shrink-0 justify-center text-text-tertiary">
		{#if run.items.length > 1}<ChevronRight class="h-3 w-3 transition-transform duration-150 {open ? 'rotate-90' : ''}" />{/if}
	</span>
	<span class="min-w-0 flex-1">
		<span class="flex min-w-0 items-baseline gap-1.5 text-[12px]">
			<span class="shrink-0 font-medium text-text-primary">{title(run.first)}</span>
			{#if sub || pricingText}<span class="min-w-0 truncate text-text-tertiary">{[sub, pricingText].filter(Boolean).join(" · ")}</span>{/if}
			{#if run.items.length > 1}<span class="shrink-0 font-mono text-[11px] text-text-tertiary">×{run.items.length}</span>{/if}
			{#if statusLabel(run.status)}<span class="tag shrink-0">{statusLabel(run.status)}</span>{/if}
		</span>
		<span class="mt-0.5 block font-mono text-[11px] tabular-nums text-text-placeholder">{timeRange(run)}</span>
	</span>
	<span class="flex shrink-0 flex-col items-end">
		{@render amount(run.amountUsd, run.status)}
		{#if pricing && pricing.listUsd !== null}
			{@const list = formatBalance(pricing.listUsd, locale)}
			<s class="font-mono text-[11px] tabular-nums text-text-placeholder" aria-label={m.pricing_original_price({ price: list }, { locale })}>{list}</s>
		{/if}
	</span>
{/snippet}

<section aria-labelledby="billing-activity-heading" class="pt-5">
	<div class="flex flex-wrap items-center justify-between gap-3">
		<h2 id="billing-activity-heading" class="text-[13px] font-medium text-text-primary">{m.billing_activity_heading({}, { locale })}</h2>
		<Segmented options={filters} value={filter} label={m.billing_activity_heading({}, { locale })} onchange={(value) => (filter = value)} />
	</div>

	{#if feed.error && feed.items.length === 0}
		<div class="mt-4 flex items-center gap-3 text-[12px] text-error-soft" role="alert">
			<span>{m.billing_activity_load_failed({}, { locale })}</span>
			<button type="button" class="text-text-secondary underline-offset-2 hover:underline" onclick={() => feed.refresh()}>{m.common_retry({}, { locale })}</button>
		</div>
	{:else if feed.loading}
		<div class="mt-4 space-y-2" aria-hidden="true">
			{#each { length: 6 } as _, index (index)}<div class="h-9 rounded-[5px] bg-bg-hover-strong"></div>{/each}
		</div>
	{:else if days.length === 0}
		<p class="mt-4 text-[12px] text-text-tertiary">{m.billing_no_activity({}, { locale })}</p>
	{:else}
		{#each days as day (day.key)}
			<div class="mt-3">
				<h3 class="sticky top-0 z-[1] bg-bg-primary py-1.5 text-[11px] font-medium text-text-tertiary">{dayLabel(day.date)}</h3>
				<ul class="divide-y divide-border-subtle border-t border-border-subtle">
					{#each day.runs as run (run.id)}
						{@const many = run.items.length > 1}
						{@const open = many && expanded.has(run.id)}
						<li>
							{#if many}
								<button type="button" class="flex w-full min-w-0 items-center gap-3 rounded-[4px] py-2 text-left transition-colors hover:bg-bg-hover" aria-expanded={open} onclick={() => toggle(run.id)}>
									{@render runRow(run, open)}
								</button>
							{:else}
								<div class="flex min-w-0 items-center gap-3 py-2">{@render runRow(run, false)}</div>
							{/if}
							{#if open}
								<ul class="mb-2 ml-6.5 border-l border-border-subtle pl-3">
									{#each run.items as item (item.id)}
										{@const itemPricing = item.kind === "usage" ? runPricing([item]) : null}
										<li class="flex items-center justify-between gap-3 py-1 text-[11px]">
											<span class="min-w-0 truncate font-mono tabular-nums text-text-tertiary">
												{time(item.createdAt)}{#if itemPricing && pricingSummary(itemPricing)}<span class="font-sans"> · {pricingSummary(itemPricing)}</span>{/if}
											</span>
											<span class="flex shrink-0 items-baseline gap-1.5">
												{#if itemPricing && itemPricing.listUsd !== null}<s class="font-mono tabular-nums text-text-placeholder">{formatBalance(itemPricing.listUsd, locale)}</s>{/if}
												{@render amount(item.amountUsd, item.status)}
											</span>
										</li>
									{/each}
								</ul>
							{/if}
						</li>
					{/each}
				</ul>
			</div>
		{/each}
		<div use:inScrollView={(visible) => (nearEnd = visible)} class="flex h-12 items-center justify-center text-[11px] text-text-tertiary">
			{#if feed.loadingMore}
				<Loader2 class="h-3.5 w-3.5 animate-spin" />
			{:else if feed.moreFailed}
				<button type="button" class="hover:text-text-secondary" onclick={() => feed.loadMore()}>{m.billing_activity_load_failed({}, { locale })} · {m.common_retry({}, { locale })}</button>
			{:else if !feed.hasMore}
				<span>{m.billing_activity_end({}, { locale })}</span>
			{/if}
		</div>
	{/if}
</section>
