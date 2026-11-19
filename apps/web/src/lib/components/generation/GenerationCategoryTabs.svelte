<script lang="ts">
import type {
	GenerationCategoryFilter,
	GenerationCategoryKey,
} from "#lib/generation-model-catalog.ts";
import { getLocale } from "#lib/i18n/locale.svelte.ts";
import { m } from "#lib/paraglide/messages.js";
import { generationCategoryLabel } from "./generation-labels.ts";

const {
	categories,
	value,
	onchange,
	class: className = "",
}: {
	categories: readonly GenerationCategoryKey[];
	value: GenerationCategoryFilter;
	onchange: (value: GenerationCategoryFilter) => void;
	class?: string;
} = $props();

const locale = $derived(getLocale());
const options = $derived<GenerationCategoryFilter[]>(["all", ...categories]);
</script>

{#if categories.length > 1}
	<div
		class={`flex items-center gap-0.5 overflow-x-auto [scrollbar-width:none] [--tab-key-selected-bg:var(--bg-hover-strong)] ${className}`}
		role="radiogroup"
		aria-label={m.generation_category_filter({}, { locale })}
	>
		{#each options as option (option)}
			<button
				type="button"
				role="radio"
				aria-checked={value === option}
				class="tab-key h-8 sm:h-6"
				onclick={() => onchange(option)}
			>
				{generationCategoryLabel(option, locale)}
			</button>
		{/each}
	</div>
{/if}
