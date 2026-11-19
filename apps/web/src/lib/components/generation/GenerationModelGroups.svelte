<script lang="ts" generics="T extends { model: string; category?: string }">
import { groupGenerationModelsByCategory } from "@cohub/protocol/generation";
import type { Snippet } from "svelte";
import type { GenerationCategoryKey } from "#lib/generation-model-catalog.ts";
import { getLocale } from "#lib/i18n/locale.svelte.ts";
import GenerationCategoryIcon from "./GenerationCategoryIcon.svelte";
import { generationCategoryLabel } from "./generation-labels.ts";

const {
	models,
	grouped,
	headerClass = "px-3",
	row,
	headerAction,
}: {
	models: readonly T[];
	grouped: boolean;
	headerClass?: string;
	row: Snippet<[T]>;
	headerAction?: Snippet<[GenerationCategoryKey, readonly T[]]>;
} = $props();

const locale = $derived(getLocale());

const groups = $derived<
	Array<{ category: GenerationCategoryKey | null; models: readonly T[] }>
>(
	grouped
		? groupGenerationModelsByCategory(models).map((group) => ({
				category: group.category ?? "other",
				models: group.models,
			}))
		: [{ category: null, models }],
);
</script>

{#each groups as group (group.category ?? "")}
	{#if group.category}
		<div
			class={`flex h-8 items-center gap-1.5 text-[11px] font-medium text-text-tertiary ${headerClass}`}
		>
			{#if headerAction}
				<span class="mr-1 flex items-center">{@render headerAction(group.category, group.models)}</span>
			{/if}
			<GenerationCategoryIcon category={group.category} class="h-3 w-3" />
			<span>{generationCategoryLabel(group.category, locale)}</span>
			<span class="tabular-nums text-text-placeholder">{group.models.length}</span>
		</div>
	{/if}
	{#each group.models as model (model.model)}
		{@render row(model)}
	{/each}
{/each}
