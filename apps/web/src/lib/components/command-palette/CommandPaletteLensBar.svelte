<script lang="ts">
import {
	COMMAND_PALETTE_LENSES,
	type CommandPaletteLens,
} from "$lib/command-palette/lens";
import { commandLensLabel } from "$lib/command-palette/lens-copy";
import FilterBar from "$lib/components/list-page/FilterBar.svelte";
import FilterChip from "$lib/components/list-page/FilterChip.svelte";
import { getLocale } from "$lib/i18n/locale.svelte";
import { m } from "$lib/paraglide/messages.js";

const {
	lens,
	onSelect,
}: {
	lens: CommandPaletteLens | null;
	onSelect: (lens: CommandPaletteLens) => void;
} = $props();

const locale = $derived(getLocale());
</script>

<FilterBar label={m.command_lens_bar({}, { locale })} role="tablist" activeKey={lens}>
	{#each COMMAND_PALETTE_LENSES as key (key)}
		<FilterChip
			kind="tab"
			label={commandLensLabel(key, locale)}
			active={lens === key}
			onclick={() => onSelect(key)}
		/>
	{/each}
</FilterBar>
