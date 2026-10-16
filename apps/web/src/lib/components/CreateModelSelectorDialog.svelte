<script lang="ts">
import type { PublicGenerationDeclaration } from "@cohub/protocol/generation";
import {
	Check,
	Image,
	LoaderCircle,
	Music2,
	RotateCcw,
	Search,
	Video,
} from "lucide-svelte";
import Dialog from "$lib/components/Dialog.svelte";
import {
	generationModelKind,
	getGenerationModelPickerItems,
} from "$lib/generation-model-catalog";
import { getLocale } from "$lib/i18n/locale.svelte";
import { m } from "$lib/paraglide/messages.js";

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

const visibleModels = $derived(
	getGenerationModelPickerItems(models, {
		query,
		selectedModelIds: currentModelId ? [currentModelId] : [],
	}),
);

$effect(() => {
	if (open) query = "";
});

function title(model: PublicGenerationDeclaration) {
	return model.title?.trim() || model.model;
}

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
	<div class="border-b border-border-subtle/70 p-3">
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
	</div>

	<div class="py-1">
		{#if visibleModels.length === 0}
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
				<div class="px-4 py-8 text-center text-[13px] text-text-tertiary">
					{query
						? m.model_selector_no_matching({}, { locale })
						: m.create_model_no_models({}, { locale })}
				</div>
			{/if}
		{:else}
			{#each visibleModels as model (model.model)}
				{@const selected = model.model === currentModelId}
				{@const modelKind = generationModelKind(model, locale)}
				<button
					type="button"
					class={`group relative flex min-h-12 w-full items-center gap-3 px-4 py-2 text-left transition-colors hover:bg-bg-hover ${selected ? "bg-bg-hover/70" : ""}`}
					aria-pressed={selected}
					onclick={() => select(model.model)}
				>
					{#if selected}<span class="absolute left-0 h-5 w-0.5 rounded-r bg-brand"></span>{/if}
					<span class="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-bg-subtle text-text-tertiary group-hover:text-text-secondary">
						{#if modelKind === "Video"}
							<Video class="h-3.5 w-3.5" />
						{:else if modelKind === "Audio"}
							<Music2 class="h-3.5 w-3.5" />
						{:else}
							<Image class="h-3.5 w-3.5" />
						{/if}
					</span>
					<span class="min-w-0 flex-1">
						<span class="block truncate text-[13px] font-medium text-text-primary">{title(model)}</span>
						<span class="block truncate text-[10px] text-text-tertiary">{modelKind} · {model.model}</span>
					</span>
					<span class="flex h-5 w-5 shrink-0 items-center justify-center text-brand">
						{#if selected}<Check class="h-4 w-4" />{/if}
					</span>
				</button>
			{/each}
		{/if}
	</div>
</Dialog>
