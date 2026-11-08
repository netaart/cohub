<script lang="ts">
/**
 * In-app purchase entry. Two intensities, chosen by the server intent:
 *
 * - soft  — balance dipped negative but work continues. A dismissible strip
 *           at the bottom of the viewport; never a modal over live work.
 * - hard  — requests are blocked. A sheet leading with the recommended
 *           product for this audience and one primary action.
 */
import { X } from "lucide-svelte";
import Sheet from "$lib/components/Sheet.svelte";
import { formatMoney } from "$lib/features/billing/format";
import { trackPurchase } from "$lib/features/billing/funnel";
import PurchasePanel from "$lib/features/billing/PurchasePanel.svelte";
import { PurchaseFlow } from "$lib/features/billing/purchase.svelte";
import { getLocale } from "$lib/i18n/locale.svelte";
import { m } from "$lib/paraglide/messages.js";
import { billingConversion } from "$lib/stores/billing-conversion.svelte";

const locale = $derived(getLocale());
const open = $derived(billingConversion.open);
const intent = $derived(billingConversion.intent);
const level = $derived(billingConversion.level);
const warning = $derived(billingConversion.warning);
const sheetOpen = $derived(open && level === "hard" && !!intent);
const stripOpen = $derived(open && level === "soft" && !!intent);

const flow = new PurchaseFlow("conversion-hard");
const focus = $derived(flow.focus(intent));
const balance = $derived(
	typeof warning?.netUsd === "number" ? warning.netUsd : null,
);
const headline = $derived(
	intent?.title ?? m.billing_conv_add_credits({}, { locale }),
);
const lede = $derived.by(() => {
	if (!intent) return "";
	if (intent.reason === "feature_not_entitled") return intent.message;
	return focus === "packs"
		? m.purchase_lede_packs({}, { locale })
		: m.purchase_lede_plans({}, { locale });
});

let opened = false;
$effect(() => {
	if (sheetOpen && !opened) {
		opened = true;
		void flow.load().then(() => {
			flow.selectedKey = null;
			flow.ensureSelection(focus);
			trackPurchase({
				name: "purchase_open",
				source: "conversion-hard",
				focus,
			});
		});
	} else if (!sheetOpen) {
		opened = false;
	}
});

function openFromStrip() {
	trackPurchase({ name: "purchase_open", source: "conversion-soft", focus });
	if (intent) billingConversion.showHard({ ...intent, level: "hard" });
}

function buy() {
	void flow.checkout({ returnTo: window.location.href });
}
</script>

{#if stripOpen && intent}
	<div class="strip" role="status">
		<div class="strip-text">
			<span class="strip-title">{intent.title}</span>
			{#if balance !== null}
				<span class="strip-balance">{m.purchase_balance_now({ amount: formatMoney(balance, locale) }, { locale })}</span>
			{/if}
		</div>
		<button type="button" class="strip-cta primary-key" onclick={openFromStrip}>{m.purchase_cta_add_balance({}, { locale })}</button>
		<button type="button" class="strip-close" onclick={() => billingConversion.close()} aria-label={m.common_close({}, { locale })}>
			<X class="icon" aria-hidden="true" />
		</button>
	</div>
{/if}

{#if sheetOpen && intent}
	<Sheet open onClose={() => billingConversion.close()} maxWidth="880px">
		<div class="sheet">
			<header class="head">
				<div class="head-text">
					<h2 class="title">{headline}</h2>
					{#if lede}<p class="lede">{lede}</p>{/if}
				</div>
				{#if balance !== null}
					<div class="balance">
						<span class="balance-label">{m.billing_conv_current_balance({}, { locale })}</span>
						<span class="balance-value" class:negative={balance < 0}>{formatMoney(balance, locale)}</span>
					</div>
				{/if}
				<button type="button" class="close" onclick={() => billingConversion.close()} aria-label={m.common_close({}, { locale })}>
					<X class="icon" aria-hidden="true" />
				</button>
			</header>
			<div class="body">
				<PurchasePanel {flow} {locale} signedIn {focus} density="sheet" onbuy={buy} />
			</div>
		</div>
	</Sheet>
{/if}

<style>
	.strip {
		position: fixed;
		z-index: 55;
		inset-inline: 12px;
		bottom: calc(12px + env(safe-area-inset-bottom));
		display: flex;
		align-items: center;
		gap: 12px;
		padding: 10px 10px 10px 14px;
		border-radius: 10px;
		border: 1px solid var(--border-subtle);
		background: var(--bg-elevated);
		box-shadow: 0 8px 24px oklch(0% 0 0 / 0.18);
		animation: rise 220ms var(--ease-out);
	}
	@media (min-width: 640px) {
		.strip {
			inset-inline: auto 16px;
			bottom: 16px;
			max-width: 420px;
		}
	}
	@keyframes rise {
		from {
			opacity: 0;
			transform: translateY(6px);
		}
	}
	@media (prefers-reduced-motion: reduce) {
		.strip {
			animation: none;
		}
	}
	.strip-text {
		flex: 1;
		min-width: 0;
		display: flex;
		flex-direction: column;
		gap: 1px;
	}
	.strip-title {
		font-size: 13px;
		font-weight: 600;
		color: var(--text-primary);
	}
	.strip-balance {
		font-size: 11px;
		color: var(--text-tertiary);
		font-variant-numeric: tabular-nums;
	}
	.strip-cta {
		flex-shrink: 0;
		min-height: 34px;
		padding: 0 12px;
		font-size: 12px;
		font-weight: 600;
	}
	.strip-close,
	.close {
		display: inline-flex;
		flex-shrink: 0;
		padding: 6px;
		border-radius: 5px;
		color: var(--text-tertiary);
		cursor: pointer;
	}
	.strip-close:hover,
	.close:hover {
		background: var(--bg-hover);
		color: var(--text-primary);
	}

	.sheet {
		display: flex;
		flex-direction: column;
		max-height: 88vh;
	}
	.head {
		display: flex;
		align-items: flex-start;
		gap: 16px;
		padding: 18px 20px 14px;
		border-bottom: 1px solid var(--border-subtle);
	}
	.head-text {
		flex: 1;
		min-width: 0;
	}
	.title {
		font-size: 17px;
		font-weight: 600;
		letter-spacing: -0.015em;
		color: var(--text-primary);
	}
	.lede {
		margin: 4px 0 0;
		font-size: 12.5px;
		line-height: 18px;
		color: var(--text-tertiary);
		text-wrap: pretty;
	}
	.balance {
		display: none;
		flex-direction: column;
		align-items: flex-end;
		gap: 2px;
		padding-top: 2px;
	}
	@media (min-width: 640px) {
		.balance {
			display: flex;
		}
	}
	.balance-label {
		font-size: 10.5px;
		letter-spacing: 0.06em;
		text-transform: uppercase;
		color: var(--text-tertiary);
	}
	.balance-value {
		font-family: var(--font-mono);
		font-size: 14px;
		color: var(--text-primary);
	}
	.negative {
		color: var(--color-error);
	}
	.body {
		min-height: 0;
		flex: 1;
		overflow-y: auto;
		padding: 20px 20px calc(16px + env(safe-area-inset-bottom));
	}
	:global(.strip .icon),
	:global(.sheet .icon) {
		width: 15px;
		height: 15px;
	}
</style>
