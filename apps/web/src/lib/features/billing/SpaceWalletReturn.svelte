<script lang="ts">
import { CheckCircle2, Loader2, X, XCircle } from "lucide-svelte";
import { onMount } from "svelte";
import { replaceState } from "$app/navigation";
import { getLocale } from "$lib/i18n/locale.svelte";
import { m } from "$lib/paraglide/messages.js";
import { sdk } from "$lib/sdk";
import { authStore } from "$lib/stores/auth.svelte";
import { clearCheckoutOrder, WALLET_RETURN_PARAMS } from "./space-fund";

const POLLS = 4;
const POLL_DELAY_MS = 1_500;

const locale = $derived(getLocale());
let state = $state<"confirming" | "settled" | "pending" | "failed" | null>(
	null,
);

onMount(() => {
	const url = new URL(window.location.href);
	const orderId = url.searchParams.get("wallet_order");
	const spaceId = url.searchParams.get("wallet_space");
	if (!orderId || !spaceId) return;
	for (const param of WALLET_RETURN_PARAMS) url.searchParams.delete(param);
	replaceState(url, history.state);
	state = "confirming";
	let disposed = false;
	void (async () => {
		await authStore.ensureLoaded();
		const api = sdk.space(spaceId).wallet;
		for (let attempt = 0; attempt < POLLS && !disposed; attempt++) {
			if (attempt > 0)
				await new Promise((resolve) => setTimeout(resolve, POLL_DELAY_MS));
			const result = await api.confirmOrder(orderId).catch(() => null);
			if (!result) continue;
			if (result.settled || !result.pending) {
				clearCheckoutOrder(spaceId, orderId);
				state = result.settled ? "settled" : "failed";
				return;
			}
		}
		if (!disposed) state = "pending";
	})();
	return () => {
		disposed = true;
	};
});
</script>

{#if state}
	<div class="toast-surface fixed inset-x-3 top-3 z-[var(--z-workspace-popover)] flex items-start gap-2.5 p-3 pl-3.5 sm:inset-x-auto sm:top-auto sm:right-4 sm:bottom-4 sm:w-[360px]" role="status">
		{#if state === "confirming"}
			<Loader2 class="mt-px h-4 w-4 shrink-0 animate-spin text-text-tertiary motion-reduce:animate-none" aria-hidden="true" />
		{:else if state === "settled"}
			<CheckCircle2 class="mt-px h-4 w-4 shrink-0 text-success" aria-hidden="true" />
		{:else}
			<XCircle class="mt-px h-4 w-4 shrink-0 text-warning" aria-hidden="true" />
		{/if}
		<p class="min-w-0 flex-1 text-[13px] leading-5">
			{state === "confirming"
				? m.wallet_return_confirming({}, { locale })
				: state === "settled"
					? m.wallet_return_success({}, { locale })
					: state === "pending"
						? m.wallet_payment_pending({}, { locale })
						: m.purchase_return_failed({}, { locale })}
		</p>
		{#if state !== "confirming"}
			<button type="button" class="inline-flex rounded p-1 text-text-tertiary hover:bg-bg-hover hover:text-text-primary" onclick={() => (state = null)} aria-label={m.common_close({}, { locale })}>
				<X class="h-3.5 w-3.5" aria-hidden="true" />
			</button>
		{/if}
	</div>
{/if}
