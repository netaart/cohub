<script lang="ts">
import { Check } from "lucide-svelte";
import PreviewControl from "../PreviewControl.svelte";
import type { PreviewIcon, PreviewOption } from "../preview-header.ts";
import PreviewGroup from "./PreviewGroup.svelte";
import PreviewIconButton from "./PreviewIconButton.svelte";

let {
	value = $bindable(),
	options,
	triggerIcon,
	triggerLabel,
}: {
	value: string;
	options: PreviewOption[];
	triggerIcon: PreviewIcon;
	triggerLabel: string;
} = $props();
</script>

<PreviewControl icon={triggerIcon} label={triggerLabel}>
	{#snippet inline()}
		<PreviewGroup label={triggerLabel}>
			{#each options as option (option.value)}
				<PreviewIconButton
					icon={option.icon}
					label={option.title ?? option.label}
					active={option.value === value}
					onclick={() => (value = option.value)}
				/>
			{/each}
		</PreviewGroup>
	{/snippet}
	{#snippet menu({ close }: { close: () => void })}
		{#each options as option (option.value)}
			<button
				type="button"
				class="menu-item"
				role="menuitemradio"
				aria-checked={option.value === value}
				onclick={() => {
					value = option.value;
					close();
				}}
			>
				<option.icon class="h-3.5 w-3.5" />
				<span>{option.label}</span>
				{#if option.value === value}
					<Check class="ml-auto h-3.5 w-3.5" />
				{/if}
			</button>
		{/each}
	{/snippet}
</PreviewControl>
