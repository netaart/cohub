<script lang="ts">
import ListRow from "$lib/components/list-page/ListRow.svelte";
import type { FixedListRowDensity } from "$lib/components/list-page/list-row";

const {
	density,
	rows = 7,
	avatar = true,
	label,
}: {
	density: FixedListRowDensity;
	rows?: number;
	avatar?: boolean;
	label: string;
} = $props();
</script>

{#snippet avatarBlock()}
	<span class="aspect-square w-full rounded-[28%] bg-bg-surface"></span>
{/snippet}

<div aria-busy="true" aria-label={label}>
	{#each { length: rows } as _, index (index)}
		<ListRow {density} aria-hidden="true" leading={avatar ? avatarBlock : undefined}>
			<span class="flex min-w-0 flex-1 flex-col gap-2">
				<span class="h-3 rounded-[3px] bg-bg-surface" style:width={`${42 + ((index * 23) % 40)}%`}></span>
				<span class="h-2.5 w-2/3 rounded-[3px] bg-bg-surface/70"></span>
			</span>
		</ListRow>
	{/each}
</div>
