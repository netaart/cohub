<script lang="ts">
/**
 * Mounted once in the app shell. When the payment page sends the user back,
 * the outcome is only trusted after the provider confirms the order or
 * subscription actually settled — a forged `?cohub_billing=success` URL cannot
 * produce a success state. The round-trip parameters are then scrubbed so a
 * reload does not replay the toast.
 */
import { CheckCircle2, Loader2, X, XCircle } from "lucide-svelte";
import { onMount } from "svelte";
import { replaceState } from "$app/navigation";
import { getLocale } from "$lib/i18n/locale.svelte";
import { m } from "$lib/paraglide/messages.js";
import { sdk } from "$lib/sdk";
import { authStore } from "$lib/stores/auth.svelte";
import { billingCatalogStore } from "$lib/stores/billing-catalog.svelte";
import { billingConversion } from "$lib/stores/billing-conversion.svelte";
import { finishCheckoutContext, readCheckoutContext } from "./checkout-context";
import {
	type CheckoutReturn,
	readCheckoutReturn,
	stripCheckoutReturn,
} from "./checkout-return";
import { trackPurchase } from "./funnel";

/** Grace for the provider webhook to land after the redirect. */
const SETTLE_POLLS = 3;
const SETTLE_DELAY_MS = 1_500;

const locale = $derived(getLocale());
let result = $state<CheckoutReturn | null>(null);
let confirming = $state(false);
let settled = $state(false);
let confirmationState = $state<"pending" | "settled" | "failed">("pending");
let productName = $state<string | null>(null);

const showPending = $derived(confirming || confirmationState === "pending");
const showSuccess = $derived(confirmationState === "settled");

function dismiss() {
	result = null;
	settled = false;
	confirmationState = "pending";
	confirming = false;
}

function reopenPurchase() {
	dismiss();
	billingConversion.openReminder();
	if (billingConversion.level === "soft") {
		billingConversion.showHard({
			level: "hard",
			reason: "balance_not_positive",
			audience: "unknown",
			preferredOfferKind: "mixed",
			title: m.purchase_add_balance_title({}, { locale }),
			message: m.purchase_add_balance_message({}, { locale }),
			primaryAction: {
				label: m.purchase_cta_add_balance({}, { locale }),
				action: "open_billing_conversion",
			},
			source: "checkout_return",
		});
	}
}

function startOrAdopt(name: string | null) {
	if (name) productName = name;
}

/** Polls until the provider reports the purchase as settled, within a grace window. */
async function waitForSettlement(productKey: string, checkoutId: string) {
	for (let attempt = 0; attempt < SETTLE_POLLS; attempt += 1) {
		if (attempt > 0)
			await new Promise((resolve) => setTimeout(resolve, SETTLE_DELAY_MS));
		try {
			const { confirmation } = await sdk.billing.confirmCheckout(
				productKey,
				checkoutId,
			);
			if (confirmation.settled) {
				settled = true;
				confirmationState = "settled";
				startOrAdopt(confirmation.productName);
				return true;
			}
			if (!confirmation.pending) {
				// Provider already knows it did not go through (failed/canceled).
				confirmationState = "failed";
				return false;
			}
		} catch {
			// Transient read failure — keep the result pending after the grace window.
		}
	}
	return false;
}

onMount(() => {
	const refresh = () => {
		void billingCatalogStore
			.refresh()
			.catch((error) => console.warn("[billing] Refresh failed", error));
		window.dispatchEvent(new Event("cohub:billing-refresh"));
	};
	const visible = () => {
		if (document.visibilityState === "visible") refresh();
	};
	window.addEventListener("focus", refresh);
	window.addEventListener("pageshow", refresh);
	document.addEventListener("visibilitychange", visible);
	const url = new URL(window.location.href);
	const found = url.searchParams.has("wallet_order")
		? null
		: readCheckoutReturn(url);
	if (found) {
		result = found;
		replaceState(stripCheckoutReturn(url), history.state);
		trackPurchase({
			name: "purchase_checkout_return",
			outcome: found.outcome,
			productKey: found.productKey,
		});
		confirming = true;
		void (async () => {
			await authStore.ensureLoaded();
			const userId = authStore.userUuid;
			const context =
				userId && found.purchaseId
					? readCheckoutContext(userId, found.purchaseId)
					: null;
			if (context?.checkoutId && context.productKey === found.productKey) {
				await waitForSettlement(context.productKey, context.checkoutId);
				if (settled) {
					finishCheckoutContext(context);
					billingConversion.clear();
				}
			}
			confirming = false;
			refresh();
		})();
	}
	return () => {
		window.removeEventListener("focus", refresh);
		window.removeEventListener("pageshow", refresh);
		document.removeEventListener("visibilitychange", visible);
	};
});
</script>

{#if result}
	<div class="toast toast-surface" role="status" class:success={showSuccess} class:confirming={showPending}>
		{#if showPending}
			<Loader2 class="icon is-msg" aria-hidden="true" />
		{:else if showSuccess}
			<CheckCircle2 class="icon is-msg" aria-hidden="true" />
		{:else}
			<XCircle class="icon is-msg" aria-hidden="true" />
		{/if}
		<div class="body">
			<div class="title">
				{#if showPending}
					{m.purchase_return_confirming({}, { locale })}
				{:else if showSuccess}
					{productName
						? m.purchase_return_success_named({ product: productName }, { locale })
						: m.purchase_return_success({}, { locale })}
				{:else if result.outcome === "cancel"}
					{m.purchase_return_cancel({}, { locale })}
				{:else}
					{m.purchase_return_failed({}, { locale })}
				{/if}
			</div>
			<div class="detail">
				{#if showPending}
					{m.purchase_return_confirming_detail({}, { locale })}
				{:else if settled}
					{m.purchase_return_success_detail({}, { locale })}
				{:else}
					<button type="button" class="link" onclick={reopenPurchase}>{m.purchase_return_retry({}, { locale })}</button>
				{/if}
			</div>
		</div>
		<button type="button" class="close" onclick={dismiss} aria-label={m.common_close({}, { locale })}>
			<X class="icon-sm" aria-hidden="true" />
		</button>
	</div>
{/if}

<style>
	.toast {
		position: fixed;
		z-index: var(--z-workspace-popover);
		inset-inline: 12px;
		top: 12px;
		display: flex;
		align-items: flex-start;
		gap: 10px;
		padding: 12px 12px 12px 14px;
		animation: enter 220ms cubic-bezier(0.16, 1, 0.3, 1);
	}
	@media (min-width: 640px) {
		.toast {
			inset-inline: auto 16px;
			top: auto;
			bottom: 16px;
			width: 360px;
		}
	}
	@keyframes enter {
		from {
			opacity: 0;
			transform: translateY(6px);
		}
	}
	@media (prefers-reduced-motion: reduce) {
		.toast {
			animation: none;
		}
	}
	:global(.toast .is-msg) {
		width: 18px;
		height: 18px;
		flex-shrink: 0;
		margin-top: 1px;
	}
	:global(.toast .is-msg) {
		color: var(--color-warning);
	}
	:global(.toast.success .is-msg) {
		color: var(--color-success);
	}
	:global(.toast.confirming .is-msg) {
		color: var(--brand-muted-fg);
		animation: spin 900ms linear infinite;
	}
	@keyframes spin {
		to {
			transform: rotate(360deg);
		}
	}
	@media (prefers-reduced-motion: reduce) {
		:global(.toast.confirming .is-msg) {
			animation: none;
		}
	}
	.body {
		flex: 1;
		min-width: 0;
		display: flex;
		flex-direction: column;
		gap: 2px;
	}
	.title {
		font-size: 13px;
		font-weight: 600;
	}
	.detail {
		font-size: 12px;
		color: var(--text-tertiary);
	}
	.link {
		color: var(--brand-muted-fg);
		cursor: pointer;
	}
	.link:hover {
		text-decoration: underline;
	}
	.close {
		display: inline-flex;
		padding: 4px;
		border-radius: 4px;
		color: var(--text-tertiary);
		cursor: pointer;
	}
	.close:hover {
		background: var(--bg-hover);
		color: var(--text-primary);
	}
	:global(.toast .icon-sm) {
		width: 14px;
		height: 14px;
	}
</style>
