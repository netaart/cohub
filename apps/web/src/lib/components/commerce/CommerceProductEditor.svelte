<script lang="ts">
import type { SpaceCommerceProduct } from "@neta-art/cohub";
import { Loader2, Wallet } from "lucide-svelte";
import { untrack } from "svelte";
import { getLocale } from "#lib/i18n/locale.svelte.ts";
import { m } from "#lib/paraglide/messages.js";

const locale = $derived(getLocale());

const {
	product,
	onSubmit,
	onCancel,
	busy = false,
}: {
	product?: SpaceCommerceProduct | null;
	onSubmit: (input: {
		name: string;
		description?: string;
		amountUsd: number;
		cohubBalanceUsd?: number;
		status: "draft" | "active";
	}) => Promise<void>;
	onCancel: () => void;
	busy?: boolean;
} = $props();

const isEdit = $derived(Boolean(product));
const MIN_PRODUCT_AMOUNT_USD = 0.5;

// Snapshot the seed once: form fields are editable copies, not reactive mirrors.
const seed = untrack(() => ({
	key: product?.key ?? "",
	name: product?.name ?? "",
	description: product?.description ?? "",
	amountUsd: product ? product.pricing.amountUsd.toFixed(2) : "9.99",
	cohubBalanceUsd: product?.cohubBalance?.amountUsd
		? String(product.cohubBalance.amountUsd)
		: "",
	status: (product?.status === "draft" ? "draft" : "active") as
		| "draft"
		| "active",
}));

const systemKey = seed.key;
let name = $state(seed.name);
let description = $state(seed.description);
let amountUsd = $state(seed.amountUsd);
let includeCohubBalance = $state(Boolean(seed.cohubBalanceUsd));
let cohubBalanceUsd = $state(seed.cohubBalanceUsd || "1");
let status = $state<"draft" | "active">(seed.status);
let error = $state("");

const nameInvalid = $derived(!name.trim());
const amountInvalid = $derived(
	!Number.isFinite(Number(amountUsd)) ||
		Number(amountUsd) < MIN_PRODUCT_AMOUNT_USD,
);
const parsedCohubBalanceUsd = $derived(Number(cohubBalanceUsd));
const cohubBalanceInvalid = $derived(
	includeCohubBalance &&
		(!Number.isSafeInteger(parsedCohubBalanceUsd) ||
			parsedCohubBalanceUsd < 1 ||
			parsedCohubBalanceUsd > Number(amountUsd)),
);
const formInvalid = $derived(
	nameInvalid || amountInvalid || cohubBalanceInvalid,
);

async function submit() {
	error = "";
	if (formInvalid) return;
	try {
		await onSubmit({
			name: name.trim(),
			description: description.trim() || undefined,
			amountUsd: Number(amountUsd),
			cohubBalanceUsd:
				!isEdit && includeCohubBalance ? parsedCohubBalanceUsd : undefined,
			status,
		});
	} catch (err) {
		error =
			err instanceof Error
				? err.message
				: m.product_editor_save_failed({}, { locale });
	}
}

const inputClass =
	"h-11 w-full rounded-[6px] border border-border-subtle bg-bg-input px-3 text-[13px] text-text-primary placeholder:text-text-placeholder transition-colors focus:border-brand/50 focus:outline-none disabled:opacity-60 sm:h-9";
const labelClass =
	"text-[11px] font-medium uppercase tracking-wide text-text-tertiary";
const readonlyClass =
	"flex h-9 w-full items-center rounded-[6px] border border-border-subtle bg-bg-input px-3 font-mono text-[13px] text-text-tertiary";
</script>

<div class="flex flex-col gap-4 p-4 sm:p-5">
	<!-- Billing type selector (extensibility scaffold: only One-time is active) -->
	<div class="flex flex-col gap-1.5">
		<span class={labelClass}>{m.product_editor_billing_type({}, { locale })}</span>
		<div class="inline-flex w-fit rounded-[6px] border border-border-subtle bg-bg-subtle p-0.5 text-[12px]">
			<span class="rounded-[5px] bg-bg-input px-3 py-1.5 font-medium text-text-primary shadow-sm">{m.product_editor_one_time({}, { locale })}</span>
			<span class="rounded-[5px] px-3 py-1.5 text-text-tertiary">{m.product_editor_recurring_soon({}, { locale })}</span>
		</div>
		<span class="text-[11px] text-text-tertiary">{m.product_editor_one_time_hint({}, { locale })}</span>
	</div>

	{#if isEdit}
		<div class="grid gap-4 sm:grid-cols-2">
			<div class="flex flex-col gap-1.5">
				<label class={labelClass} for="product-name">{m.product_editor_name({}, { locale })}</label>
				<input
					id="product-name"
					class={inputClass}
					bind:value={name}
					disabled={busy}
					placeholder={m.product_editor_name_placeholder({}, { locale })}
					autocomplete="off"
				/>
			</div>
			<div class="flex flex-col gap-1.5">
				<span class={labelClass}>{m.product_editor_system_key({}, { locale })}</span>
				<div class={readonlyClass}>{systemKey}</div>
				<span class="text-[11px] text-text-tertiary">{m.product_editor_system_key_hint({}, { locale })}</span>
			</div>
		</div>
	{:else}
		<div class="flex flex-col gap-1.5">
			<label class={labelClass} for="product-name">{m.product_editor_name({}, { locale })}</label>
			<input
				id="product-name"
				class={inputClass}
				bind:value={name}
				disabled={busy}
				placeholder={m.product_editor_name_placeholder({}, { locale })}
				autocomplete="off"
			/>
			<span class="text-[11px] text-text-tertiary">{m.product_editor_key_hint({}, { locale })}</span>
		</div>
	{/if}

	<div class="grid gap-4 sm:grid-cols-2">
		<div class="flex flex-col gap-1.5">
			<label class={labelClass} for="product-price">{m.product_editor_price({}, { locale })}</label>
			<div class="relative">
				<span class="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-[13px] text-text-tertiary">$</span>
				<input
					id="product-price"
					class={inputClass + " pl-7 font-mono"}
					class:opacity-60={isEdit}
					type="number"
					step="0.01"
					min={MIN_PRODUCT_AMOUNT_USD}
					bind:value={amountUsd}
					disabled={isEdit || busy}
					placeholder="9.99"
				/>
			</div>
			<span class="text-[11px] text-text-tertiary">{isEdit ? m.product_editor_price_hint_edit({}, { locale }) : m.product_editor_price_hint_create({}, { locale })}</span>
		</div>

		<div class="flex flex-col gap-1.5">
			<label class={labelClass} for="product-status">{m.product_editor_status({}, { locale })}</label>
			<select
				id="product-status"
				class={inputClass}
				bind:value={status}
				disabled={busy}
			>
				<option value="active">{m.product_editor_status_active({}, { locale })}</option>
				<option value="draft">{m.product_editor_status_draft({}, { locale })}</option>
			</select>
			<span class="text-[11px] text-text-tertiary">{m.product_editor_status_hint({}, { locale })}</span>
		</div>
	</div>

	<div class="border-y border-border-subtle py-3">
		{#if isEdit}
			<div class="flex min-h-11 items-center justify-between gap-4">
				<div class="flex min-w-0 items-center gap-2.5">
					<Wallet class="h-4 w-4 shrink-0 text-text-tertiary" />
					<div class="min-w-0">
						<div class="text-[12px] font-medium text-text-primary">{m.product_editor_cohub_balance({}, { locale })}</div>
						<div class="text-[11px] text-text-tertiary">{m.product_editor_balance_immutable({}, { locale })}</div>
					</div>
				</div>
				<div class="shrink-0 font-mono text-[13px] text-text-secondary">
					{product?.cohubBalance ? `${product.cohubBalance.amountUsd}` : m.product_editor_not_included({}, { locale })}
				</div>
			</div>
		{:else}
			<label class="flex min-h-11 cursor-pointer items-center justify-between gap-4" for="include-cohub-balance">
				<div class="flex min-w-0 items-center gap-2.5">
					<Wallet class="h-4 w-4 shrink-0 text-text-tertiary" />
					<div class="min-w-0">
						<div class="text-[12px] font-medium text-text-primary">{m.product_editor_include_balance({}, { locale })}</div>
						<div class="text-[11px] text-text-tertiary">{m.product_editor_include_balance_hint({}, { locale })}</div>
					</div>
				</div>
				<input
					id="include-cohub-balance"
					type="checkbox"
					class="h-4 w-4 shrink-0"
					bind:checked={includeCohubBalance}
					disabled={busy}
				/>
			</label>
			{#if includeCohubBalance}
				<div class="mt-3 flex flex-col gap-1.5 sm:max-w-52">
					<label class={labelClass} for="cohub-balance-amount">{m.product_editor_balance({}, { locale })}</label>
					<div class="relative">
						<span class="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-[13px] text-text-tertiary">$</span>
						<input
							id="cohub-balance-amount"
							class={inputClass + " pl-7 font-mono"}
							type="number"
							min="1"
							step="1"
							bind:value={cohubBalanceUsd}
							disabled={busy}
						/>
					</div>
					<span class="text-[11px] {cohubBalanceInvalid ? 'text-error-soft' : 'text-text-tertiary'}">
						{cohubBalanceInvalid ? m.product_editor_balance_invalid({}, { locale }) : m.product_editor_balance_hint({}, { locale })}
					</span>
				</div>
			{/if}
		{/if}
	</div>

	<div class="flex flex-col gap-1.5">
		<label class={labelClass} for="product-description">{m.product_editor_description({}, { locale })}</label>
		<textarea
			id="product-description"
			class="min-h-16 w-full resize-y rounded-[6px] border border-border-subtle bg-bg-input px-3 py-2 text-[13px] leading-5 text-text-primary placeholder:text-text-placeholder transition-colors focus:border-brand/50 focus:outline-none disabled:opacity-60"
			bind:value={description}
			disabled={busy}
			rows={2}
			maxlength="2048"
			placeholder={m.product_editor_desc_placeholder({}, { locale })}
		></textarea>
	</div>

	{#if error}
		<div class="rounded-[6px] border border-error-soft/30 bg-error-bg px-3 py-2 text-[12px] text-error-soft">{error}</div>
	{/if}

	<div class="flex items-center justify-end gap-2 pt-1">
		<button
			type="button"
			class="inline-flex min-h-11 items-center justify-center rounded-[6px] px-3 text-[12px] text-text-tertiary transition-colors hover:bg-bg-hover hover:text-text-primary disabled:opacity-50 sm:min-h-9"
			onclick={onCancel}
			disabled={busy}
		>
			{m.product_editor_cancel({}, { locale })}
		</button>
		<button
			type="button"
			class="inline-flex min-h-11 items-center justify-center gap-1.5 rounded-[6px] bg-brand-soft px-3 text-[12px] font-medium text-brand-contrast-fg transition-opacity hover:opacity-90 disabled:opacity-50 sm:min-h-9"
			onclick={() => void submit()}
			disabled={busy || formInvalid}
		>
			{#if busy}<Loader2 class="h-3.5 w-3.5 animate-spin" />{/if}
			{isEdit ? m.product_editor_save({}, { locale }) : m.product_editor_create({}, { locale })}
		</button>
	</div>
</div>
