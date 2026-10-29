<script lang="ts">
import type { BillingCatalogProduct } from "@neta-art/cohub";
import { Check } from "lucide-svelte";
import type { Locale } from "$lib/i18n/locale";
import { m } from "$lib/paraglide/messages.js";
import { formatPrice } from "./format";
import {
	type DisplayPrice,
	daysUntil,
	displayPrice,
	includedBalanceUsd,
	isFreeProduct,
	listSavingsPercent,
	periodBalanceUsd,
} from "./product";

const {
	product,
	locale,
	signedIn,
	selected = false,
	recommended = false,
	current = false,
	currentLabel,
	disabled = false,
	variant = "full",
	monthlyPlans = [],
	onselect,
}: {
	product: BillingCatalogProduct;
	locale: Locale;
	signedIn: boolean;
	selected?: boolean;
	recommended?: boolean;
	current?: boolean;
	currentLabel?: string;
	disabled?: boolean;
	/** `full` for pricing grids, `compact` for the conversion sheet. */
	variant?: "full" | "compact";
	monthlyPlans?: BillingCatalogProduct[];
	onselect: (product: BillingCatalogProduct) => void;
} = $props();

const free = $derived(isFreeProduct(product));
const price = $derived<DisplayPrice>(displayPrice(product, { signedIn }));
const yearly = $derived(product.interval === "yearly");
const perMonthUsd = $derived(yearly ? price.amountUsd / 12 : price.amountUsd);
const listSavings = $derived(
	price.offerApplied ? null : listSavingsPercent(product, monthlyPlans),
);
const balance = $derived(includedBalanceUsd(product));
const periodBalance = $derived(periodBalanceUsd(product));
const endsIn = $derived(daysUntil(price.endsAt));
const description = $derived(
	product.display.description ?? product.description ?? "",
);
const benefits = $derived(
	product.display.benefits.slice(0, variant === "compact" ? 2 : 4),
);
const unit = $derived(
	product.kind === "addon"
		? null
		: yearly
			? m.purchase_per_year({}, { locale })
			: m.purchase_per_month({}, { locale }),
);
</script>

<button
	type="button"
	class="card"
	class:selected
	class:recommended
	class:compact={variant === "compact"}
	class:current
	{disabled}
	aria-pressed={selected}
	onclick={() => onselect(product)}
>
	{#if recommended && !current}
		<span class="flag badge" data-tone="promo">{m.purchase_most_popular({}, { locale })}</span>
	{:else if current}
		<span class="flag badge" data-tone="muted">{currentLabel ?? m.purchase_current_plan({}, { locale })}</span>
	{/if}

	<header class="head">
		<h3 class="name">{product.name}</h3>
		{#if price.offerApplied && price.percentOff}
			<span class="offer">{m.purchase_first_order_off({ percent: price.percentOff }, { locale })}</span>
		{:else if listSavings}
			<span class="save">−{listSavings}%</span>
		{/if}
	</header>

	<div class="price">
		{#if free}
			<span class="hero">{m.pricing_free({}, { locale })}</span>
		{:else}
			{#if price.compareAtUsd !== null}
				<s class="was">{formatPrice(price.compareAtUsd, locale)}</s>
			{/if}
			<span class="figure">
				<span class="hero">{formatPrice(price.amountUsd, locale)}</span>
				{#if unit}<span class="unit">{unit}</span>{/if}
			</span>
			{#if yearly}
				<span class="sub">{m.purchase_per_month_equiv({ amount: formatPrice(perMonthUsd, locale) }, { locale })}</span>
			{:else if price.offerApplied}
				<span class="sub">{m.purchase_then_price({ amount: formatPrice(product.pricing.amountUsd, locale) }, { locale })}</span>
			{/if}
		{/if}
	</div>

	{#if price.teaser}
		<p class="teaser">{m.purchase_teaser_sign_in({ percent: price.teaser.percentOff }, { locale })}</p>
	{:else if endsIn !== null && price.offerApplied}
		<p class="teaser">{m.purchase_offer_ends_in({ days: endsIn }, { locale })}</p>
	{/if}

	<ul class="facts">
		<li>
			<Check class="tick" aria-hidden="true" />
			<span>
				{#if product.kind === "addon"}
					{m.purchase_balance_once({ amount: formatPrice(balance, locale) }, { locale })}
				{:else if yearly}
					{m.purchase_balance_yearly({ month: formatPrice(balance, locale), year: formatPrice(periodBalance, locale) }, { locale })}
				{:else}
					{m.purchase_balance_monthly({ amount: formatPrice(balance, locale) }, { locale })}
				{/if}
			</span>
		</li>
		{#each benefits as benefit, index (index)}
			<li><Check class="tick" aria-hidden="true" /><span>{benefit}</span></li>
		{/each}
		{#if variant === "full" && description && benefits.length === 0}
			<li class="desc">{description}</li>
		{/if}
	</ul>
</button>

<style>
	.card {
		position: relative;
		display: flex;
		flex-direction: column;
		gap: 14px;
		width: 100%;
		min-height: 100%;
		padding: 18px 18px 16px;
		text-align: left;
		border-radius: 10px;
		border: 1px solid var(--border-subtle);
		background: var(--bg-content);
		color: var(--text-primary);
		cursor: pointer;
		transition:
			border-color 150ms,
			box-shadow 150ms,
			background-color 150ms;
	}
	.card:hover:not(:disabled) {
		border-color: var(--border-primary);
	}
	.card.recommended {
		border-color: color-mix(in srgb, var(--brand) 40%, var(--border-subtle));
	}
	.card.selected {
		border-color: var(--brand);
		box-shadow: 0 0 0 1px var(--brand);
	}
	.card:focus-visible {
		outline: none;
		box-shadow:
			0 0 0 2px var(--bg-primary),
			0 0 0 4px var(--brand);
	}
	.card:disabled {
		cursor: default;
	}
	.card.current {
		background: var(--bg-subtle);
	}
	.compact {
		gap: 10px;
		padding: 14px 14px 12px;
	}

	.flag {
		position: absolute;
		top: -9px;
		left: 16px;
	}

	.head {
		display: flex;
		align-items: baseline;
		justify-content: space-between;
		gap: 10px;
	}
	.name {
		font-size: 14px;
		font-weight: 600;
		letter-spacing: -0.01em;
	}
	.offer,
	.save {
		flex-shrink: 0;
		font-family: var(--font-mono);
		font-size: 11px;
		font-weight: 600;
		letter-spacing: 0.01em;
	}
	.offer {
		padding: 2px 6px;
		border-radius: 4px;
		background: var(--brand-muted);
		color: var(--brand-muted-fg);
	}
	.save {
		color: var(--text-tertiary);
	}

	.price {
		display: flex;
		flex-direction: column;
		gap: 2px;
		min-height: 58px;
	}
	.compact .price {
		min-height: 0;
	}
	.was {
		font-family: var(--font-mono);
		font-size: 13px;
		color: var(--text-placeholder);
		text-decoration-thickness: 1px;
	}
	.figure {
		display: flex;
		align-items: baseline;
		gap: 5px;
	}
	.hero {
		font-size: 32px;
		font-weight: 600;
		letter-spacing: -0.045em;
		line-height: 1;
		font-variant-numeric: tabular-nums;
	}
	.compact .hero {
		font-size: 26px;
	}
	.unit {
		font-size: 12px;
		color: var(--text-tertiary);
	}
	.sub {
		font-size: 11px;
		color: var(--text-tertiary);
		font-variant-numeric: tabular-nums;
	}

	.teaser {
		margin: -6px 0 0;
		font-size: 11px;
		line-height: 16px;
		color: var(--brand-muted-fg);
	}

	.facts {
		display: flex;
		flex-direction: column;
		gap: 7px;
		margin: 0;
		padding: 12px 0 0;
		border-top: 1px solid var(--divider-muted);
		list-style: none;
		font-size: 12px;
		line-height: 17px;
		color: var(--text-secondary);
	}
	.compact .facts {
		gap: 5px;
		padding-top: 10px;
		font-size: 11.5px;
	}
	.facts li {
		display: flex;
		align-items: flex-start;
		gap: 8px;
	}
	.facts li:first-child {
		color: var(--text-primary);
		font-weight: 500;
	}
	.facts :global(.tick) {
		flex-shrink: 0;
		width: 13px;
		height: 13px;
		margin-top: 2px;
		color: var(--brand);
	}
	.desc {
		color: var(--text-tertiary);
	}
</style>
