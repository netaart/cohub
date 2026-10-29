<script lang="ts">
import { Check, ChevronDown, Loader2, X } from "lucide-svelte";
import type { Locale } from "$lib/i18n/locale";
import { m } from "$lib/paraglide/messages.js";
import { formatMoney, formatPrice } from "./format";
import { daysUntil, includedBalanceUsd, periodBalanceUsd } from "./product";
import type { PurchaseFlow } from "./purchase.svelte";

const {
	flow,
	locale,
	signedIn,
	ctaLabel,
	onbuy,
}: {
	flow: PurchaseFlow;
	locale: Locale;
	signedIn: boolean;
	/** Overrides the default verb, e.g. "Sign in to claim" for visitors. */
	ctaLabel?: string;
	onbuy: () => void;
} = $props();

let codeOpen = $state(false);

const product = $derived(flow.selected);
const pricing = $derived(flow.activePricing);
const discount = $derived(pricing?.discountAmountUsd ?? 0);
const listUsd = $derived(pricing?.amountUsd ?? product?.pricing.amountUsd ?? 0);
const isPlan = $derived(product?.kind === "plan");
const yearly = $derived(product?.interval === "yearly");
const endsIn = $derived(daysUntil(product?.offer?.endsAt ?? null));
const balance = $derived(product ? includedBalanceUsd(product) : 0);
const periodBalance = $derived(product ? periodBalanceUsd(product) : 0);
const canBuy = $derived(!!product && flow.canBuy(product));
const blockedReason = $derived.by(() => {
	const view = flow.view;
	if (!product || !view) return null;
	if (!view.paymentAvailable)
		return (
			view.paymentReason ?? m.billing_payment_unavailable_plain({}, { locale })
		);
	if (isPlan && flow.recoverySubscription)
		return m.billing_recovery_purchase_blocked({}, { locale });
	if (isPlan && view.currentPlan?.key === product.key)
		return m.purchase_already_on_plan({}, { locale });
	if (isPlan && view.hasActiveSubscription)
		return m.purchase_active_subscription_blocks({}, { locale });
	return null;
});
const discountLabel = $derived(
	flow.appliedCode
		? m.purchase_code_discount(
				{ code: flow.appliedCode.promotionCode },
				{ locale },
			)
		: m.purchase_first_order_discount({}, { locale }),
);
const renewal = $derived.by(() => {
	if (!product || !isPlan) return null;
	const price = formatPrice(product.pricing.amountUsd, locale);
	return yearly
		? m.purchase_renews_yearly({ amount: price }, { locale })
		: m.purchase_renews_monthly({ amount: price }, { locale });
});
const cta = $derived(
	ctaLabel ??
		(isPlan
			? m.purchase_cta_subscribe({}, { locale })
			: m.purchase_cta_add_balance({}, { locale })),
);

function submitCode(event: SubmitEvent) {
	event.preventDefault();
	void flow.applyPromotionCode();
}
</script>

<aside class="summary" aria-live="polite">
	{#if product}
		<div class="selection">
			<span class="label">{isPlan ? m.purchase_selected_plan({}, { locale }) : m.purchase_selected_pack({}, { locale })}</span>
			<span class="value">{product.name}</span>
		</div>

		<dl class="lines">
			<div class="line">
				<dt>{isPlan ? (yearly ? m.purchase_line_yearly({}, { locale }) : m.purchase_line_monthly({}, { locale })) : m.purchase_line_one_time({}, { locale })}</dt>
				<dd>{formatMoney(listUsd, locale)}</dd>
			</div>
			{#if discount > 0}
				<div class="line discount">
					<dt>{discountLabel}</dt>
					<dd>−{formatMoney(discount, locale)}</dd>
				</div>
			{/if}
			<div class="line total">
				<dt>{m.purchase_due_today({}, { locale })}</dt>
				<dd>{formatMoney(flow.dueTodayUsd, locale)}</dd>
			</div>
		</dl>

		<ul class="notes">
			<li>
				{#if !isPlan}
					{m.purchase_note_balance_once({ amount: formatPrice(balance, locale) }, { locale })}
				{:else if yearly}
					{m.purchase_note_balance_yearly({ amount: formatPrice(periodBalance, locale) }, { locale })}
				{:else}
					{m.purchase_note_balance_monthly({ amount: formatPrice(balance, locale) }, { locale })}
				{/if}
			</li>
			{#if renewal && discount > 0}
				<li>{renewal}</li>
			{/if}
			{#if isPlan}
				<li>{m.purchase_note_cancel_anytime({}, { locale })}</li>
			{:else}
				<li>{m.purchase_note_pack_validity({}, { locale })}</li>
			{/if}
			{#if endsIn !== null && discount > 0 && !flow.appliedCode}
				<li class="urgent">{m.purchase_offer_ends_in({ days: endsIn }, { locale })}</li>
			{/if}
		</ul>

		<button
			type="button"
			class="cta primary-key"
			disabled={flow.checkoutLoading || flow.promotionLoading || (signedIn && !canBuy)}
			onclick={onbuy}
		>
			{#if flow.checkoutLoading}
				<Loader2 class="spin" aria-hidden="true" />
				{m.purchase_cta_redirecting({}, { locale })}
			{:else}
				{cta}
			{/if}
		</button>

		{#if signedIn && blockedReason}
			<p class="blocked">{blockedReason}</p>
		{/if}

		{#if flow.error}
			<p class="error" role="alert">
				{flow.error.message}
				{#if flow.error.offerChanged}
					{m.purchase_error_refreshed({}, { locale })}
				{/if}
			</p>
		{/if}

		{#if signedIn}
			<div class="code">
				{#if flow.appliedCode}
					<div class="code-applied">
						<Check class="icon" aria-hidden="true" />
						<span class="mono">{flow.appliedCode.promotionCode}</span>
						<button type="button" class="code-remove" onclick={() => flow.clearPromotion()} aria-label={m.billing_checkout_remove_promo({}, { locale })}>
							<X class="icon" aria-hidden="true" />
						</button>
					</div>
				{:else}
					<button type="button" class="code-toggle" aria-expanded={codeOpen} onclick={() => (codeOpen = !codeOpen)}>
						{m.purchase_have_code({}, { locale })}
						<ChevronDown class="icon chevron" aria-hidden="true" />
					</button>
					{#if codeOpen}
						<form class="code-form" onsubmit={submitCode}>
							<input
								bind:value={flow.promotionCode}
								maxlength="256"
								autocomplete="off"
								autocapitalize="characters"
								spellcheck="false"
								placeholder={m.billing_checkout_enter_code({}, { locale })}
								aria-label={m.billing_checkout_promo_code({}, { locale })}
								disabled={flow.promotionLoading}
							/>
							<button type="submit" disabled={!flow.promotionCode.trim() || flow.promotionLoading}>
								{#if flow.promotionLoading}<Loader2 class="icon spin" aria-hidden="true" />{:else}{m.billing_checkout_apply({}, { locale })}{/if}
							</button>
						</form>
					{/if}
				{/if}
			</div>
		{/if}

		<p class="trust">{m.purchase_trust_line({}, { locale })}</p>
	{:else}
		<p class="empty">{m.purchase_pick_prompt({}, { locale })}</p>
	{/if}
</aside>

<style>
	.summary {
		display: flex;
		flex-direction: column;
		gap: 16px;
		font-size: 12px;
	}

	.selection {
		display: flex;
		flex-direction: column;
		gap: 2px;
	}
	.label {
		font-size: 11px;
		letter-spacing: 0.08em;
		text-transform: uppercase;
		color: var(--text-tertiary);
	}
	.value {
		font-size: 16px;
		font-weight: 600;
		letter-spacing: -0.01em;
		color: var(--text-primary);
	}

	.lines {
		display: flex;
		flex-direction: column;
		gap: 8px;
		margin: 0;
	}
	.line {
		display: flex;
		justify-content: space-between;
		gap: 12px;
		color: var(--text-tertiary);
	}
	.line dd {
		margin: 0;
		font-family: var(--font-mono);
		font-variant-numeric: tabular-nums;
		color: var(--text-secondary);
	}
	.discount dd {
		color: var(--color-success);
	}
	.total {
		align-items: baseline;
		padding-top: 10px;
		border-top: 1px solid var(--border-subtle);
		color: var(--text-primary);
		font-weight: 500;
	}
	.total dd {
		font-size: 22px;
		font-weight: 600;
		letter-spacing: -0.03em;
		color: var(--text-primary);
	}

	.notes {
		display: flex;
		flex-direction: column;
		gap: 4px;
		margin: 0;
		padding: 0;
		list-style: none;
		font-size: 11.5px;
		line-height: 16px;
		color: var(--text-tertiary);
	}
	.urgent {
		color: var(--brand-muted-fg);
	}

	.cta {
		gap: 8px;
		min-height: 44px;
		font-size: 13px;
		font-weight: 600;
	}

	.blocked {
		margin: -6px 0 0;
		font-size: 11px;
		color: var(--text-tertiary);
	}
	.error {
		margin: -6px 0 0;
		font-size: 11px;
		line-height: 16px;
		color: var(--color-error-soft);
	}

	.code {
		display: flex;
		flex-direction: column;
		gap: 8px;
	}
	.code-toggle {
		display: inline-flex;
		align-items: center;
		gap: 4px;
		align-self: flex-start;
		font-size: 11px;
		color: var(--text-tertiary);
		cursor: pointer;
	}
	.code-toggle:hover {
		color: var(--text-secondary);
	}
	.code-toggle[aria-expanded="true"] :global(.chevron) {
		transform: rotate(180deg);
	}
	:global(.summary .chevron) {
		transition: transform 150ms;
	}
	.code-form {
		display: flex;
		gap: 6px;
	}
	.code-form input {
		flex: 1;
		min-width: 0;
		height: 36px;
		padding: 0 10px;
		border-radius: 5px;
		border: 1px solid var(--border-subtle);
		background: var(--bg-input);
		font-family: var(--font-mono);
		font-size: 12px;
		text-transform: uppercase;
		color: var(--text-primary);
	}
	.code-form input::placeholder {
		text-transform: none;
		color: var(--text-placeholder);
	}
	.code-form input:focus {
		outline: none;
		border-color: var(--brand);
	}
	.code-form button {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		min-width: 64px;
		height: 36px;
		padding: 0 10px;
		border-radius: 5px;
		border: 1px solid var(--border-subtle);
		background: var(--bg-input);
		font-size: 12px;
		font-weight: 500;
		color: var(--text-primary);
		cursor: pointer;
	}
	.code-form button:disabled {
		cursor: not-allowed;
		opacity: 0.5;
	}
	.code-applied {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		align-self: flex-start;
		padding: 4px 6px 4px 8px;
		border-radius: 5px;
		background: var(--color-success-bg);
		color: var(--color-success-soft);
		font-size: 11px;
	}
	.mono {
		font-family: var(--font-mono);
	}
	.code-remove {
		display: inline-flex;
		padding: 2px;
		border-radius: 3px;
		color: inherit;
		cursor: pointer;
		opacity: 0.7;
	}
	.code-remove:hover {
		opacity: 1;
	}

	.trust {
		margin: 0;
		font-size: 11px;
		line-height: 16px;
		color: var(--text-placeholder);
	}
	.empty {
		margin: 0;
		color: var(--text-tertiary);
	}

	:global(.summary .icon) {
		width: 13px;
		height: 13px;
	}
	:global(.summary .spin) {
		width: 15px;
		height: 15px;
		animation: spin 800ms linear infinite;
	}
	@keyframes spin {
		to {
			transform: rotate(360deg);
		}
	}
</style>
