<script lang="ts">
import { Loader2, Settings } from "lucide-svelte";
import ModelSelector from "#lib/components/ModelSelector.svelte";
import { getLocale } from "#lib/i18n/locale.svelte.ts";
import {
	getModelDisplayName,
	type ModelThinkingLevel,
} from "#lib/model-catalog.ts";
import { m } from "#lib/paraglide/messages.js";
import { modelsCatalogStore } from "#lib/stores/models-catalog.svelte.ts";

type ModelRef = {
	provider: string;
	id: string;
	thinkingLevel?: ModelThinkingLevel | null;
};

type Props = {
	model: ModelRef | null;
	disabled?: boolean;
	saving?: boolean;
	onSelect: (model: ModelRef | null) => void;
};

const { model, disabled = false, saving = false, onSelect }: Props = $props();

const locale = $derived(getLocale());

let selectorOpen = $state(false);

const modelsCatalog = $derived(modelsCatalogStore.items);

function label(): string {
	if (!model) return m.model_default({}, { locale });
	return (
		getModelDisplayName(modelsCatalog, {
			provider: model.provider,
			model: model.id,
		}) || model.id
	);
}

function openSelector() {
	if (disabled || saving) return;
	modelsCatalogStore.load().catch((error) => {
		console.error("Failed to load models catalog:", error);
	});
	selectorOpen = true;
}

function handleSelect(next: {
	provider: string;
	id: string;
	thinkingLevel?: ModelThinkingLevel;
}) {
	selectorOpen = false;
	onSelect(next);
}

function clearModel() {
	if (disabled) return;
	onSelect(null);
}
</script>

<div class="space-y-1.5">
	<button
		type="button"
		class="flex min-h-9 w-full items-center justify-between gap-3 rounded-[6px] border border-border-subtle bg-bg-input px-3 py-1.5 text-left transition-colors hover:bg-bg-hover focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand/40 disabled:cursor-not-allowed disabled:opacity-60"
		onclick={openSelector}
		disabled={disabled || saving}
		title={m.model_choose({}, { locale })}
	>
		<span
			class="min-w-0 truncate text-[12px] {model
				? 'text-text-primary'
				: 'text-text-tertiary'}"
		>
			{label()}
		</span>
		{#if saving}
			<Loader2 class="h-3.5 w-3.5 shrink-0 animate-spin text-text-placeholder" />
		{:else}
			<Settings class="h-3.5 w-3.5 shrink-0 text-text-placeholder" />
		{/if}
	</button>
	{#if model && !disabled}
		<button
			type="button"
			class="text-[11px] text-text-placeholder transition-colors hover:text-text-secondary"
			onclick={clearModel}
		>
			{m.cron_use_default_model({}, { locale })}
		</button>
	{/if}
</div>

<ModelSelector
	open={selectorOpen}
	onClose={() => {
		selectorOpen = false;
	}}
	onSelect={handleSelect}
	models={modelsCatalog ?? []}
	currentModel={model}
	currentThinkingLevel={model?.thinkingLevel ?? null}
/>
