<script lang="ts">
import type { Snippet } from "svelte";

const {
	title,
	description,
	action,
}: { title: string; description: string; action?: Snippet } = $props();
</script>

<div class="flex items-start justify-between gap-3">
	<div class="min-w-0">
		<h2 class="text-[18px] font-semibold tracking-tight text-text-primary">{title}</h2>
		<p class="mt-1 text-[13px] leading-5 text-text-tertiary">{description}</p>
	</div>
	{#if action}<div class="flex shrink-0 items-center gap-2">{@render action()}</div>{/if}
</div>
