<script lang="ts">
import type { Snippet } from "svelte";

const {
	title,
	strong = false,
	tooltip,
	meta,
	subtitle,
	status,
}: {
	title: string;
	strong?: boolean;
	tooltip?: string;
	meta?: Snippet;
	subtitle: Snippet;
	status?: Snippet;
} = $props();
</script>

<span class="flex min-w-0 flex-1 flex-col justify-center gap-0.5 self-stretch overflow-hidden">
	<span class="list-row-title flex min-w-0 items-center gap-2">
		<span class="min-w-0 flex-1 truncate text-text-primary {strong ? 'font-semibold' : 'font-medium'}" title={tooltip}>{title}</span>
		{#if meta}
			<span class="list-row-meta inline-flex shrink-0 items-center gap-1.5 tabular-nums text-text-placeholder">{@render meta()}</span>
		{/if}
	</span>
	<span class="list-row-subtitle flex min-w-0 items-center gap-2">
		<span class="min-w-0 flex-1 truncate text-text-tertiary">{@render subtitle()}</span>
		{#if status}
			<span class="inline-flex max-w-[50%] shrink-0 items-center gap-1.5">{@render status()}</span>
		{/if}
	</span>
</span>

<style>
	.list-row-title {
		font-size: var(--list-title-size);
		line-height: var(--list-title-leading);
	}

	.list-row-meta {
		font-size: var(--list-meta-size);
	}

	.list-row-subtitle {
		height: var(--list-subtitle-leading);
		font-size: var(--list-subtitle-size);
		line-height: var(--list-subtitle-leading);
	}
</style>
