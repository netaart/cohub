<script lang="ts" module>
import type { SpaceWalletFunding } from "@neta-art/cohub";
import { getCacheUserKey } from "$lib/cache/keys";

const fundingCache = new Map<string, SpaceWalletFunding>();
const cacheKey = (spaceId: string) => `${getCacheUserKey()}:${spaceId}`;
</script>

<script lang="ts">
import {
	HttpError,
	type SpaceWalletFundingTier,
	type SpaceWalletTransferStatus,
} from "@neta-art/cohub";
import { CheckCircle2, Loader2 } from "lucide-svelte";
import { onMount, untrack } from "svelte";
import { ensureAuth } from "$lib/auth";
import { getCurrentRedirectPath } from "$lib/auth-redirect";
import SpaceAvatar from "$lib/components/SpaceAvatar.svelte";
import { formatCurrency } from "$lib/i18n/format";
import { getLocale } from "$lib/i18n/locale.svelte";
import { m } from "$lib/paraglide/messages.js";
import { sdk } from "$lib/sdk";
import { authStore } from "$lib/stores/auth.svelte";
import {
	clearRequestId,
	currentReturnPath,
	takeRequestId,
} from "./space-fund";

const {
	spaceId,
	identity = "row",
	signInPath,
	onFunded,
}: {
	spaceId: string;
	identity?: "row" | "heading" | "none";
	signInPath?: string;
	onFunded?: () => void;
} = $props();

const locale = $derived(getLocale());
const api = untrack(() => sdk.space(spaceId).wallet);
let funding = $state.raw<SpaceWalletFunding | null>(
	untrack(() => fundingCache.get(cacheKey(spaceId)) ?? null),
);
let loadState = $state<"ready" | "loading" | "denied" | "error">(
	untrack(() => (funding ? "ready" : "loading")),
);
let selectedKey = $state<string | null>(null);
let customOpen = $state(false);
let customValue = $state("");
let preferCheckout = $state(false);
let busy = $state(false);
let notice = $state<string | null>(null);
let result = $state.raw<SpaceWalletTransferStatus | null>(null);
let customInput = $state<HTMLInputElement | null>(null);
let disposed = false;

const signedIn = $derived(authStore.isAuthenticated);
const tiers = $derived(funding?.tiers ?? []);
const transfer = $derived(funding?.transfer ?? null);
const custom = $derived(customOpen || tiers.length === 0);
const tier = $derived<SpaceWalletFundingTier | null>(
	custom
		? null
		: (tiers.find((item) => item.productKey === selectedKey) ??
				tiers[0] ??
				null),
);
const customAmount = $derived.by(() => {
	const value = Number(customValue);
	return customValue.trim() && Number.isInteger(value) ? value : null;
});
const amount = $derived(tier ? tier.amountUsd : customAmount);
const coversBalance = (value: number | null) =>
	value !== null && !!transfer && value <= transfer.allowanceUsd;
const customError = $derived.by(() => {
	if (!custom || !transfer || !customValue.trim()) return null;
	if (
		customAmount === null ||
		customAmount < transfer.minUsd ||
		customAmount > transfer.maxUsd
	)
		return m.wallet_fund_invalid_amount(
			{ min: money(transfer.minUsd), max: money(transfer.maxUsd) },
			{ locale },
		);
	if (!coversBalance(customAmount))
		return m.wallet_fund_insufficient(
			{ amount: money(transfer.allowanceUsd, 2) },
			{ locale },
		);
	return null;
});
const method = $derived.by<"balance" | "checkout" | null>(() => {
	if (!signedIn) return null;
	if (!tier) return customError || customAmount === null ? null : "balance";
	const balance = coversBalance(tier.amountUsd);
	if (funding?.checkout && (preferCheckout || !balance)) return "checkout";
	return balance ? "balance" : null;
});
const alternate = $derived.by<"balance" | "checkout" | null>(() => {
	if (!tier) return null;
	if (method === "balance" && funding?.checkout) return "checkout";
	if (method === "checkout" && coversBalance(tier.amountUsd))
		return "balance";
	return null;
});
const available = $derived(tiers.length > 0 || !!transfer);

function money(value: number, digits = 0) {
	return formatCurrency(value, "USD", {
		locale,
		minimumFractionDigits: digits,
		maximumFractionDigits: digits,
	});
}

async function load() {
	try {
		const next = await api.funding();
		if (disposed) return;
		funding = next;
		fundingCache.set(cacheKey(spaceId), next);
		loadState = "ready";
	} catch (error) {
		if (disposed || funding) return;
		loadState =
			error instanceof HttpError && (error.status === 401 || error.status === 403)
				? "denied"
				: "error";
	}
}

function selectTier(item: SpaceWalletFundingTier) {
	selectedKey = item.productKey;
	customOpen = false;
	preferCheckout = false;
	notice = null;
}

function openCustom() {
	customOpen = true;
	notice = null;
	queueMicrotask(() => customInput?.focus());
}

function spendAllowance(value: number) {
	if (!funding?.transfer) return;
	funding = {
		...funding,
		transfer: {
			...funding.transfer,
			allowanceUsd: Math.max(0, funding.transfer.allowanceUsd - value),
		},
	};
	fundingCache.set(cacheKey(spaceId), funding);
}

async function payFromBalance(value: number) {
	const ref = String(value);
	const id = takeRequestId("transfer", spaceId, ref);
	try {
		const status = await api.transfer({ id, amountUsd: value });
		if (status.state !== "processing")
			clearRequestId("transfer", spaceId, ref);
		result = status;
		if (status.creditedUsd > 0 || status.state === "processing")
			spendAllowance(value - status.refundedUsd);
		if (status.state === "completed") onFunded?.();
		if (status.state === "processing") void watch(id, value);
	} catch (error) {
		const code = error instanceof HttpError ? error.code : null;
		if (code === "transfer_insufficient" || code === "transfer_amount_invalid")
			clearRequestId("transfer", spaceId, ref);
		notice =
			code === "transfer_busy"
				? m.wallet_fund_busy({}, { locale })
				: code === "transfer_insufficient"
					? m.wallet_fund_insufficient(
							{ amount: money(transfer?.allowanceUsd ?? 0, 2) },
							{ locale },
						)
					: code === "transfer_unavailable"
						? m.wallet_recharge_unavailable({}, { locale })
						: m.wallet_fund_failed({}, { locale });
		void load();
	}
}

async function watch(id: string, value: number) {
	const polls = 12;
	for (let attempt = 1; attempt <= polls && !disposed; attempt++) {
		await new Promise((resolve) => setTimeout(resolve, 5_000));
		const status = await api.getTransfer(id).catch(() => null);
		if (!status || status.state === "processing" || disposed) continue;
		if (status.state === "none" && attempt < polls) continue;
		// Keep the ID when nothing was charged yet: retrying it can never debit twice.
		if (status.state !== "none") clearRequestId("transfer", spaceId, String(value));
		result = status;
		if (status.state === "none") notice = m.wallet_fund_not_charged({}, { locale });
		if (status.state === "completed") onFunded?.();
		void load();
		return;
	}
}

async function payOnline(item: SpaceWalletFundingTier) {
	let id = takeRequestId("checkout", spaceId, item.productKey);
	const previous = await api.confirmOrder(id).catch(() => null);
	if (previous && (previous.settled || !previous.pending)) {
		clearRequestId("checkout", spaceId, item.productKey);
		id = takeRequestId("checkout", spaceId, item.productKey);
	}
	try {
		const { checkout } = await api.createOrder({
			id,
			productKey: item.productKey,
			returnPath: currentReturnPath(),
		});
		const url = checkout.checkoutUsable && checkout.checkoutUrl
			? new URL(checkout.checkoutUrl)
			: null;
		if (!url || (url.protocol !== "https:" && url.protocol !== "http:")) {
			if (checkout.orderId) clearRequestId("checkout", spaceId, item.productKey);
			throw new Error("Checkout unavailable");
		}
		window.location.assign(url.toString());
	} catch {
		notice = m.wallet_checkout_failed({}, { locale });
	}
}

async function submit() {
	if (busy) return;
	if (!signedIn) {
		await ensureAuth({ redirectPath: signInPath ?? getCurrentRedirectPath() });
		return;
	}
	if (!method || amount === null) return;
	busy = true;
	notice = null;
	try {
		if (method === "balance") await payFromBalance(amount);
		else if (tier) await payOnline(tier);
	} finally {
		busy = false;
	}
}

function reset() {
	result = null;
	notice = null;
	customValue = "";
}

onMount(() => {
	void authStore.ensureLoaded().then(load);
	return () => {
		disposed = true;
	};
});
</script>

<div class="fund-panel">
	{#if identity === "heading"}
		<div class="flex items-center gap-3">
			<SpaceAvatar name={funding?.space.name} avatarUrl={funding?.space.avatarUrl} seed={spaceId} size="lg" loading="eager" class="shrink-0" />
			<h1 class="min-w-0 text-[22px] leading-tight font-semibold tracking-tight break-words text-text-primary">
				{funding ? m.wallet_fund_title({ space: funding.space.name }, { locale }) : m.wallet_fund({}, { locale })}
			</h1>
		</div>
	{:else if identity === "row"}
		<div class="flex min-h-6 min-w-0 items-center gap-2.5">
			<SpaceAvatar name={funding?.space.name} avatarUrl={funding?.space.avatarUrl} seed={spaceId} size="xs" />
			<span class="min-w-0 truncate text-[14px] font-medium text-text-primary">{funding?.space.name ?? ""}</span>
		</div>
	{/if}
	<p class="text-[12px] leading-5 text-text-tertiary">{m.wallet_fund_note({}, { locale })}</p>

	{#if result && result.state !== "none"}
		<div class="flex flex-col items-start gap-3 py-2" role="status">
			{#if result.state === "completed"}
				<div class="flex items-center gap-2 text-[14px] font-medium text-text-primary">
					<CheckCircle2 class="h-4 w-4 text-success" aria-hidden="true" />
					{m.wallet_fund_done({ amount: money(result.creditedUsd), space: funding?.space.name ?? "Space" }, { locale })}
				</div>
			{:else if result.state === "processing"}
				<div class="flex items-start gap-2 text-[13px] leading-5 text-text-secondary">
					<Loader2 class="mt-0.5 h-4 w-4 shrink-0 animate-spin text-text-tertiary motion-reduce:animate-none" aria-hidden="true" />
					{m.wallet_fund_processing({}, { locale })}
				</div>
			{:else}
				<p class="text-[13px] leading-5 text-text-secondary">{m.wallet_fund_refunded({ amount: money(result.refundedUsd, 2) }, { locale })}</p>
			{/if}
			{#if result.state !== "processing"}
				<button type="button" class="secondary-key h-8 px-3 text-[12px]" onclick={reset}>{m.wallet_fund_again({}, { locale })}</button>
			{/if}
		</div>
	{:else if loadState === "loading"}
		<div class="grid grid-cols-2 gap-2 sm:grid-cols-4" aria-busy="true">
			{#each [0, 1, 2, 3] as index (index)}<div class="h-[60px] rounded-[6px] bg-bg-hover-strong"></div>{/each}
		</div>
		<div class="h-10 rounded-[6px] bg-bg-hover-strong"></div>
	{:else if loadState === "denied" && !signedIn}
		<button type="button" class="primary-key h-10 w-full text-[13px]" onclick={submit}>{m.wallet_fund_sign_in({}, { locale })}</button>
	{:else if loadState !== "ready" || !available}
		<p class="text-[13px] text-text-tertiary">
			{loadState === "error" ? m.billing_load_failed({}, { locale }) : m.wallet_recharge_unavailable({}, { locale })}
		</p>
		{#if loadState === "error"}<button type="button" class="secondary-key h-8 self-start px-3 text-[12px]" onclick={load}>{m.common_retry({}, { locale })}</button>{/if}
	{:else}
		{#if tiers.length > 0}
			<div class="grid grid-cols-2 gap-2 sm:grid-cols-4" role="group">
				{#each tiers as item (item.productKey)}
					<button
						type="button"
						class="tier"
						aria-pressed={tier?.productKey === item.productKey}
						onclick={() => selectTier(item)}
					>
						<span class="font-mono text-[15px] font-medium tabular-nums text-text-primary">{money(item.amountUsd)}</span>
						{#if signedIn && (coversBalance(item.amountUsd) || funding?.checkout)}
							<span class="text-[11px] text-text-tertiary">{coversBalance(item.amountUsd) ? m.wallet_fund_via_balance({}, { locale }) : m.wallet_fund_via_checkout({}, { locale })}</span>
						{/if}
					</button>
				{/each}
			</div>
		{/if}

		{#if transfer}
			{#if custom}
				<div>
					<label class="custom" class:invalid={!!customError}>
						<span class="text-[14px] text-text-tertiary">$</span>
						<input
							bind:this={customInput}
							bind:value={customValue}
							type="text"
							inputmode="numeric"
							pattern="[0-9]*"
							autocomplete="off"
							placeholder={String(transfer.minUsd)}
							aria-label={m.wallet_fund_other({}, { locale })}
							class="min-w-0 flex-1 bg-transparent font-mono text-[15px] tabular-nums text-text-primary outline-none placeholder:text-text-placeholder"
							onkeydown={(event) => { if (event.key === "Enter") void submit(); }}
						/>
						<span class="text-[11px] text-text-tertiary">USD</span>
					</label>
					<p class="mt-1.5 text-[11px] leading-4 {customError ? 'text-error-soft' : 'text-text-tertiary'}">
						{customError ?? m.wallet_fund_other_hint({ min: money(transfer.minUsd), max: money(transfer.maxUsd) }, { locale })}
					</p>
				</div>
			{:else}
				<button type="button" class="self-start text-[12px] text-text-tertiary underline-offset-2 hover:text-text-secondary hover:underline" onclick={openCustom}>{m.wallet_fund_other({}, { locale })}</button>
			{/if}
		{/if}

		<div class="flex flex-col gap-2">
			<button type="button" class="primary-key h-10 w-full text-[13px] tabular-nums" disabled={busy || (signedIn && (!method || amount === null))} onclick={submit}>
				{#if busy}<Loader2 class="h-3.5 w-3.5 animate-spin motion-reduce:animate-none" aria-hidden="true" />{/if}
				{#if !signedIn}
					{m.wallet_fund_sign_in({}, { locale })}
				{:else if method === "checkout" && tier}
					{m.wallet_fund_pay_checkout({ amount: money(tier.priceUsd) }, { locale })}
				{:else}
					{m.wallet_fund_pay_balance({ amount: amount === null ? "—" : money(amount) }, { locale })}
				{/if}
			</button>
			{#if notice}<p class="text-[12px] text-error-soft" role="alert">{notice}</p>{/if}
			<div class="flex min-h-5 flex-wrap items-center justify-between gap-x-3 gap-y-1 text-[11px] text-text-tertiary">
				{#if transfer}
					<span class="leading-4">
						<span class="tabular-nums">{m.wallet_fund_allowance({ amount: money(transfer.allowanceUsd, 2) }, { locale })}</span>
						· {m.wallet_fund_allowance_note({}, { locale })}
					</span>
				{:else}<span></span>{/if}
				{#if alternate}
					<button type="button" class="text-text-secondary hover:text-text-primary hover:underline underline-offset-2" onclick={() => { preferCheckout = alternate === "checkout"; notice = null; }}>
						{alternate === "checkout" ? m.wallet_fund_checkout_instead({}, { locale }) : m.wallet_fund_balance_instead({}, { locale })}
					</button>
				{/if}
			</div>
		</div>
	{/if}
</div>

<style>
	.fund-panel {
		display: flex;
		flex-direction: column;
		gap: 14px;
	}
	.tier {
		display: flex;
		flex-direction: column;
		align-items: flex-start;
		gap: 2px;
		min-height: 60px;
		padding: 10px 12px;
		border: 1px solid var(--border-subtle);
		border-radius: 6px;
		background: var(--bg-input);
		cursor: pointer;
		transition:
			border-color 120ms ease,
			background-color 120ms ease;
	}
	.tier:hover {
		background: var(--bg-hover);
	}
	.tier[aria-pressed="true"] {
		border-color: var(--brand-border);
		background: var(--brand-muted);
	}
	.tier:focus-visible {
		outline: 2px solid var(--brand-ring);
		outline-offset: 2px;
	}
	.custom {
		display: flex;
		align-items: center;
		gap: 8px;
		height: 40px;
		padding: 0 12px;
		border: 1px solid var(--border-subtle);
		border-radius: 6px;
		background: var(--bg-input);
		transition: border-color 120ms ease;
	}
	.custom:focus-within {
		border-color: var(--brand-border);
	}
	.custom.invalid {
		border-color: color-mix(in srgb, var(--error-700) 50%, transparent);
	}
</style>
