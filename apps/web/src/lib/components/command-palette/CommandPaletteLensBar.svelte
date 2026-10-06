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
	position = null,
	onSelect,
}: {
	lens: CommandPaletteLens | null;
	position?: number | null;
	onSelect: (lens: CommandPaletteLens) => void;
} = $props();

const locale = $derived(getLocale());
const shown = $derived(
	position === null
		? lens
		: (COMMAND_PALETTE_LENSES[Math.round(position)] ?? lens),
);
</script>

<FilterBar label={m.command_lens_bar({}, { locale })} role="tablist" activeKey={shown} {position}>
	{#each COMMAND_PALETTE_LENSES as key (key)}
		<FilterChip
			kind="tab"
			label={commandLensLabel(key, locale)}
			active={shown === key}
			onclick={() => onSelect(key)}
		/>
	{/each}
</FilterBar>
