<script lang="ts">
import type { BillingCatalogProduct } from "@neta-art/cohub";
import { AlertCircle, ChevronUp } from "lucide-svelte";
import Segmented from "$lib/components/Segmented.svelte";
import { formatDateTime } from "$lib/i18n/format";
import type { Locale } from "$lib/i18n/locale";
import { m } from "$lib/paraglide/messages.js";
import CheckoutSummary from "./CheckoutSummary.svelte";
import { formatMoney } from "./format";
import ProductCard from "./ProductCard.svelte";
import {
	bestYearlySavingsPercent,
	isRecommended,
	type PurchaseFocus,
	recommendedPack,
} from "./product";
import type { PurchaseFlow } from "./purchase.svelte";

const {
	flow,
	locale,
	signedIn,
	focus,
	density = "page",
	ctaLabel,
	onbuy,
}: {
	flow: PurchaseFlow;
	locale: Locale;
	signedIn: boolean;
	/** Which family leads. The other is one tap away, never hidden. */
	focus: PurchaseFocus;
	/** `page` for full routes, `sheet` inside a dialog. */
	density?: "page" | "sheet";
	ctaLabel?: string;
	onbuy: () => void;
} = $props();

// Local so the user can browse the other family; follows the prop when the
// surface changes what it wants to lead with.
let family = $state<PurchaseFocus>("plans");
let summaryOpen = $state(false);

$effect(() => {
	family = focus;
});

const view = $derived(flow.view);
const plans = $derived(flow.plans);
const packs = $derived(flow.packs);
const hasPlans = $derived(
	(view?.monthlyPlans.length ?? 0) + (view?.yearlyPlans.length ?? 0) > 0,
);
const hasPacks = $derived(packs.length > 0);
const showTabs = $derived(hasPlans && hasPacks);
const products = $derived<BillingCatalogProduct[]>(
	family === "packs" ? packs : plans,
);
const yearlySavings = $derived(
	view ? bestYearlySavingsPercent(view.yearlyPlans, view.monthlyPlans) : null,
);
const recommendedPackKey = $derived(recommendedPack(packs)?.key ?? null);
const compact = $derived(density === "sheet");
const recovery = $derived(flow.recoverySubscription?.renewalRecovery);
let recoveryNow = $state(Date.now());
const recoveryExpired = $derived(
	Boolean(
		recovery?.effectiveEndsAt &&
			Date.parse(recovery.effectiveEndsAt) <= recoveryNow,
	),
);
$effect(() => {
	const deadline = recovery?.effectiveEndsAt
		? Date.parse(recovery.effectiveEndsAt)
		: null;
	recoveryNow = Date.now();
	if (deadline === null || deadline <= Date.now()) return;
	const timer = setTimeout(
		() => {
			recoveryNow = Date.now();
		},
		Math.min(2_147_483_647, deadline - Date.now()),
	);
	return () => clearTimeout(timer);
});

function switchFamily(next: PurchaseFocus) {
	if (family === next) return;
	family = next;
	flow.selectedKey = null;
	flow.ensureSelection(next);
}

function select(product: BillingCatalogProduct) {
	flow.select(product);
}
</script>

<div class="panel" class:compact>
	<div class="catalog">
    {#if flow.recoveryNotice}<p class="recovery" role="status">{flow.recoveryNotice}</p>{/if}
    {#if recovery && recovery.state !== "none"}
      <section class="recovery" aria-live="polite">
        <strong>{recovery.state === "closing" || recoveryExpired ? m.billing_recovery_closing({}, { locale }) : m.billing_recovery_grace({}, { locale })}</strong>
        <p>{recovery.state === "closing" || recoveryExpired
          ? m.billing_recovery_closing_detail({}, { locale })
          : m.billing_recovery_grace_detail({ date: recovery.effectiveEndsAt ? formatDateTime(recovery.effectiveEndsAt, locale) : "" }, { locale })}</p>
        <div class="recovery-actions">
          {#if recovery.payInvoice.allowed && !recoveryExpired}
            <button type="button" class="primary-key" disabled={flow.recoveryLoading} onclick={() => flow.payRenewal()}>{m.billing_recovery_pay({}, { locale })}</button>
          {/if}
          {#if recovery.endRecovery.allowed && !recoveryExpired && flow.selected?.kind === "plan"}
            <button type="button" class="secondary-key" disabled={flow.recoveryLoading} onclick={() => flow.endRecovery()}>{m.billing_recovery_resubscribe({}, { locale })}</button>
          {/if}
          <button type="button" class="secondary-key" disabled={flow.recoveryLoading || flow.loading} onclick={() => flow.load({ force: true })}>{m.billing_recovery_refresh({}, { locale })}</button>
        </div>
      </section>
    {/if}
		<div class="controls">
			{#if showTabs}
				<Segmented
					role="tablist"
					label={m.purchase_family_label({}, { locale })}
					value={family}
					options={[
						{ value: "plans", label: m.purchase_family_plans({}, { locale }) },
						{ value: "packs", label: m.purchase_family_packs({}, { locale }) },
					]}
					onchange={switchFamily}
				/>
			{:else}
				<span></span>
			{/if}
			{#if family === "plans" && hasPlans}
				<Segmented
					label={m.purchase_billing_interval({}, { locale })}
					value={flow.interval}
					options={[
						{ value: "monthly", label: m.billing_monthly({}, { locale }) },
						{
							value: "yearly",
							label: m.billing_yearly({}, { locale }),
							disabled: !flow.hasYearly,
							note: flow.hasYearly && yearlySavings ? `−${yearlySavings}%` : undefined,
						},
					]}
					onchange={(interval) => flow.setInterval(interval)}
				/>
			{/if}
		</div>

		{#if flow.loading && !view}
			<div class="grid" aria-busy="true">
				{#each [0, 1, 2] as i (i)}
					<div class="skeleton"></div>
				{/each}
			</div>
		{:else if flow.loadError && !view}
			<div class="notice">
				<AlertCircle class="icon" aria-hidden="true" />
				<span>{flow.loadError}</span>
				<button type="button" onclick={() => flow.load({ force: true })}>{m.common_retry({}, { locale })}</button>
			</div>
		{:else if products.length === 0}
			<p class="muted">{m.pricing_no_plans({}, { locale })}</p>
		{:else}
			<div class="grid" style:--count={products.length}>
				{#each products as product (product.key)}
					<ProductCard
						{product}
						{locale}
						{signedIn}
						selected={flow.selectedKey === product.key}
						recommended={product.kind === "plan" ? isRecommended(product, plans) : product.key === recommendedPackKey}
						current={view?.currentPlan?.key === product.key}
						monthlyPlans={view?.monthlyPlans ?? []}
						variant={compact ? "compact" : "full"}
						onselect={select}
					/>
				{/each}
			</div>
		{/if}

		{#if family === "packs" && view?.hasPaidPlan === false && hasPlans}
			<p class="hint">
				{m.purchase_hint_plans_cheaper({}, { locale })}
				<button type="button" class="link" onclick={() => switchFamily("plans")}>{m.purchase_family_plans({}, { locale })} →</button>
			</p>
		{/if}
	</div>

	<div class="aside">
		<CheckoutSummary {flow} {locale} {signedIn} {ctaLabel} {onbuy} />
	</div>

	{#if flow.selected}
		<div class="bar" class:open={summaryOpen}>
			<button type="button" class="bar-toggle" aria-expanded={summaryOpen} onclick={() => (summaryOpen = !summaryOpen)}>
				<span class="bar-name">{flow.selected.name}</span>
				<span class="bar-price">{formatMoney(flow.dueTodayUsd, locale)}</span>
				<ChevronUp class="icon" aria-hidden="true" />
			</button>
			{#if summaryOpen}
				<div class="bar-body">
					<CheckoutSummary {flow} {locale} {signedIn} {ctaLabel} {onbuy} />
				</div>
			{:else}
				<button type="button" class="bar-cta primary-key" disabled={flow.checkoutLoading || (signedIn && !flow.canBuy(flow.selected))} onclick={onbuy}>
					{ctaLabel ?? (flow.selected.kind === "plan" ? m.purchase_cta_subscribe({}, { locale }) : m.purchase_cta_add_balance({}, { locale }))}
				</button>
			{/if}
		</div>
	{/if}
</div>

<style>
  .recovery { display: flex; flex-direction: column; gap: 8px; padding-bottom: 20px; font-size: 13px; }
  .recovery p { color: var(--text-secondary); line-height: 1.5; }
  .recovery-actions { display: flex; flex-wrap: wrap; gap: 8px; }
  .recovery-actions button { min-height: 44px; padding: 8px 12px; }
	.panel {
		display: grid;
		gap: 28px;
		grid-template-columns: minmax(0, 1fr);
	}
	@media (min-width: 960px) {
		.panel {
			grid-template-columns: minmax(0, 1fr) 280px;
			gap: 40px;
			align-items: start;
		}
		.compact {
			grid-template-columns: minmax(0, 1fr) 240px;
			gap: 24px;
		}
	}

	.catalog {
		display: flex;
		flex-direction: column;
		gap: 18px;
		min-width: 0;
	}
	.controls {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		justify-content: space-between;
		gap: 10px;
	}
	.grid {
		display: grid;
		gap: 14px;
		grid-template-columns: minmax(0, 1fr);
	}
	@media (min-width: 560px) {
		.grid {
			grid-template-columns: repeat(2, minmax(0, 1fr));
		}
	}
	@media (min-width: 1200px) {
		.panel:not(.compact) .grid {
			grid-template-columns: repeat(min(var(--count, 3), 3), minmax(0, 1fr));
		}
	}
	.compact .grid {
		gap: 10px;
	}

	.skeleton {
		height: 220px;
		border-radius: 10px;
		background: var(--bg-hover-strong);
		animation: pulse 1.4s ease-in-out infinite;
	}
	@keyframes pulse {
		50% {
			opacity: 0.55;
		}
	}
	@media (prefers-reduced-motion: reduce) {
		.skeleton {
			animation: none;
		}
	}

	.notice {
		display: flex;
		align-items: center;
		gap: 10px;
		padding: 12px 14px;
		border-radius: 8px;
		border: 1px solid var(--border-subtle);
		font-size: 12px;
		color: var(--text-secondary);
	}
	.notice :global(.icon) {
		color: var(--color-error);
	}
	.notice button {
		margin-left: auto;
		padding: 4px 10px;
		border-radius: 5px;
		border: 1px solid var(--border-subtle);
		font-size: 12px;
		cursor: pointer;
	}
	.muted {
		margin: 0;
		font-size: 12px;
		color: var(--text-tertiary);
	}
	.hint {
		margin: 0;
		font-size: 11.5px;
		color: var(--text-tertiary);
	}
	.link {
		color: var(--brand-muted-fg);
		cursor: pointer;
	}
	.link:hover {
		text-decoration: underline;
	}

	.aside {
		display: none;
	}
	@media (min-width: 960px) {
		.aside {
			display: block;
			position: sticky;
			top: 24px;
			padding: 20px;
			border-radius: 10px;
			border: 1px solid var(--border-subtle);
			background: var(--bg-content);
		}
		.compact .aside {
			position: static;
			padding: 16px;
		}
	}

	/* Mobile: the summary lives in a bottom bar that expands on demand. */
	.bar {
		position: sticky;
		bottom: 0;
		z-index: 5;
		display: flex;
		flex-direction: column;
		gap: 10px;
		margin: 0 -4px;
		padding: 10px 14px calc(10px + env(safe-area-inset-bottom));
		border-top: 1px solid var(--border-subtle);
		background: var(--bg-primary);
	}
	@media (min-width: 960px) {
		.bar {
			display: none;
		}
	}
	.bar-toggle {
		display: flex;
		align-items: center;
		gap: 8px;
		font-size: 13px;
		cursor: pointer;
	}
	.bar-name {
		font-weight: 500;
		color: var(--text-primary);
	}
	.bar-price {
		margin-left: auto;
		font-family: var(--font-mono);
		font-weight: 600;
		color: var(--text-primary);
	}
	.bar-toggle :global(.icon) {
		color: var(--text-tertiary);
		transition: transform 150ms;
	}
	.open .bar-toggle :global(.icon) {
		transform: rotate(180deg);
	}
	.bar-cta {
		min-height: 44px;
		font-size: 13px;
		font-weight: 600;
	}
	.bar-body {
		max-height: 60vh;
		overflow-y: auto;
		padding-top: 4px;
	}

	:global(.panel .icon) {
		width: 14px;
		height: 14px;
		flex-shrink: 0;
	}
</style>
