<script lang="ts">
import type { PublicGenerationDeclaration } from "@cohub/protocol/generation";
import { Check, LoaderCircle, RotateCcw, Search } from "lucide-svelte";
import { untrack } from "svelte";
import Dialog from "#lib/components/Dialog.svelte";
import GenerationCategoryIcon from "#lib/components/generation/GenerationCategoryIcon.svelte";
import GenerationCategoryTabs from "#lib/components/generation/GenerationCategoryTabs.svelte";
import GenerationModelGroups from "#lib/components/generation/GenerationModelGroups.svelte";
import { generationInputSummary } from "#lib/components/generation/generation-labels.ts";
import OfferBadge from "#lib/components/pricing/OfferBadge.svelte";
import {
	browseGenerationModels,
	type GenerationCategoryFilter,
	generationCategoryKey,
} from "#lib/generation-model-catalog.ts";
import { getLocale } from "#lib/i18n/locale.svelte.ts";
import {
	formatGenerationPrice,
	formatQuotaAmount,
	liveOffer,
	offerDeadline,
} from "#lib/model-pricing.ts";
import { m } from "#lib/paraglide/messages.js";
import { billingQuotasStore } from "#lib/stores/billing-quotas.svelte.ts";

const {
	open,
	models,
	currentModelId = null,
	loading = false,
	loaded = false,
	error = null,
	onClose,
	onSelect,
	onRetry,
}: {
	open: boolean;
	models: PublicGenerationDeclaration[];
	currentModelId?: string | null;
	loading?: boolean;
	loaded?: boolean;
	error?: string | null;
	onClose: () => void;
	onSelect: (modelId: string) => void;
	onRetry: () => void;
} = $props();

const locale = $derived(getLocale());

let query = $state("");
let filter = $state<GenerationCategoryFilter>("all");

const view = $derived(
	browseGenerationModels(models, {
		query,
		filter,
		selectedModelIds: currentModelId ? [currentModelId] : [],
	}),
);

function quotaLeft(model: PublicGenerationDeclaration): string {
	const balance = billingQuotasStore.balance(model.quota?.tokenType);
	return balance
		? m.pricing_quota_left(
				{ amount: formatQuotaAmount(balance, model.quota?.parameter, locale) },
				{ locale },
			)
		: "";
}

$effect(() => {
	if (!open) return;
	untrack(() => {
		billingQuotasStore.refresh();
		query = "";
		const current = models.find((model) => model.model === currentModelId);
		filter = current ? generationCategoryKey(current) : "all";
	});
});

function select(modelId: string) {
	onSelect(modelId);
	onClose();
}

function handleKeydown(event: KeyboardEvent) {
	if (!open || event.key !== "Escape") return;
	event.preventDefault();
	onClose();
}
</script>

<svelte:window onkeydown={handleKeydown} />

<Dialog {open} {onClose} title={m.create_model_title({}, { locale })} maxWidth="440px">
	<div class="space-y-2 border-b border-border-subtle/70 p-3">
		<label class="flex h-9 items-center gap-2 rounded-md bg-bg-input px-3 ring-1 ring-border-subtle focus-within:ring-brand/45">
			<Search class="h-3.5 w-3.5 shrink-0 text-text-placeholder" />
			<input
				type="text"
				bind:value={query}
				placeholder={m.model_selector_search_placeholder({}, { locale })}
				aria-label={m.create_model_search_aria({}, { locale })}
				class="min-w-0 flex-1 bg-transparent text-[13px] text-text-primary outline-none placeholder:text-text-placeholder"
			/>
		</label>
		<GenerationCategoryTabs categories={view.categories} value={view.filter} onchange={(next) => (filter = next)} />
	</div>

	<div class="py-1">
		{#if view.models.length === 0}
			{#if loading || (!loaded && !error)}
				<div class="flex items-center justify-center gap-2 px-4 py-8 text-[13px] text-text-tertiary" role="status">
					<LoaderCircle class="h-3.5 w-3.5 animate-spin" />
					<span>{m.create_model_loading({}, { locale })}</span>
				</div>
			{:else if error}
				<div class="flex flex-col items-center gap-3 px-4 py-8 text-center">
					<p class="text-[13px] text-error-soft">{error}</p>
					<button
						type="button"
						class="flex h-8 items-center gap-1.5 rounded-md border border-border-subtle px-2.5 text-[11px] text-text-secondary transition-colors hover:bg-bg-hover hover:text-text-primary"
						onclick={onRetry}
					>
						<RotateCcw class="h-3 w-3" />
						{m.common_retry({}, { locale })}
					</button>
				</div>
			{:else}
				<div class="flex flex-col items-center gap-2 px-4 py-8 text-center text-[13px] text-text-tertiary">
					{query
						? m.model_selector_no_matching({}, { locale })
						: m.create_model_no_models({}, { locale })}
					{#if view.outsideMatches > 0}
						<button type="button" class="text-[12px] text-brand hover:underline" onclick={() => (filter = "all")}>
							{m.generation_category_outside_matches({ count: view.outsideMatches }, { locale })}
						</button>
					{/if}
				</div>
			{/if}
		{:else}
			<GenerationModelGroups
				models={view.models}
				grouped={!query.trim() && view.filter === "all" && view.categories.length > 1}
				headerClass="px-4"
			>
				{#snippet row(model)}
					{@const selected = model.model === currentModelId}
					{@const offer = liveOffer(model.offer)}
					{@const listPrice = offer ? formatGenerationPrice(model.pricing, locale) : ""}
					{@const offerPrice = offer ? formatGenerationPrice(model.pricing, locale, offer.multiplier) : ""}
					{@const extras = [offer ? offerDeadline(offer, locale) : "", quotaLeft(model)].filter(Boolean)}
					<button
						type="button"
						class={`group relative flex min-h-12 w-full items-center gap-3 px-4 py-2 text-left transition-colors hover:bg-bg-hover ${selected ? "bg-bg-hover/70" : ""}`}
						aria-pressed={selected}
						onclick={() => select(model.model)}
					>
						{#if selected}<span class="absolute left-0 h-5 w-0.5 rounded-r bg-brand"></span>{/if}
						<span class="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-bg-subtle text-text-tertiary group-hover:text-text-secondary">
							<GenerationCategoryIcon category={generationCategoryKey(model)} />
						</span>
						<span class="min-w-0 flex-1">
							<span class="flex min-w-0 items-center gap-1.5">
								<span class="truncate text-[13px] font-medium text-text-primary">{model.title?.trim() || model.model}</span>
								{#if offer}<OfferBadge {offer} />{/if}
							</span>
							<span class="block truncate text-[10px] tabular-nums text-text-tertiary">
								{generationInputSummary(model, locale)}
								{#if listPrice}
									· <s class="text-text-placeholder" aria-label={m.pricing_original_price({ price: listPrice }, { locale })}>{offerPrice ? listPrice.split(" / ")[0] : listPrice}</s>
									{#if offerPrice}<span class="text-text-secondary">{offerPrice}</span>{/if}
								{:else}
									· {model.model}
								{/if}
								{#if extras.length > 0}· {extras.join(" · ")}{/if}
							</span>
						</span>
						<span class="flex h-5 w-5 shrink-0 items-center justify-center text-brand">
							{#if selected}<Check class="h-4 w-4" />{/if}
						</span>
					</button>
				{/snippet}
			</GenerationModelGroups>
		{/if}
	</div>
</Dialog>
