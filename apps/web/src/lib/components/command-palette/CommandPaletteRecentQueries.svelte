<script lang="ts">
import { History } from "lucide-svelte";
import { commandLensLabel } from "$lib/command-palette/lens-copy";
import type { RecentQuery } from "$lib/command-palette/recent-queries";
import FilterBar from "$lib/components/list-page/FilterBar.svelte";
import FilterChip from "$lib/components/list-page/FilterChip.svelte";
import { getLocale } from "$lib/i18n/locale.svelte";
import { m } from "$lib/paraglide/messages.js";

const {
	queries,
	onPick,
	onClear,
}: {
	queries: readonly RecentQuery[];
	onPick: (entry: RecentQuery) => void;
	onClear: () => void;
} = $props();

const locale = $derived(getLocale());
</script>

{#snippet icon()}
	<span class="flex h-8 w-6 items-center justify-center text-text-placeholder lg:h-7" title={m.command_recent_searches({}, { locale })}>
		<History class="h-3.5 w-3.5" />
	</span>
{/snippet}

{#snippet clear()}
	<FilterChip kind="action" label={m.command_clear_recent({}, { locale })} onclick={onClear} />
{/snippet}

<FilterBar label={m.command_recent_searches({}, { locale })} leading={icon} trailing={clear}>
	{#each queries as entry (`${entry.lens}:${entry.query}`)}
		<FilterChip
			kind="action"
			label={entry.query}
			title={entry.lens === "all" ? entry.query : `${commandLensLabel(entry.lens, locale)} · ${entry.query}`}
			onclick={() => onPick(entry)}
		/>
	{/each}
</FilterBar>
