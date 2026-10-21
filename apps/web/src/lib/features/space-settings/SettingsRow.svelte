<script lang="ts" module>
export const SETTINGS_SELECT =
	"h-9 max-w-full rounded-[6px] border border-border-subtle bg-bg-input px-2.5 text-[12px] text-text-primary focus:border-brand/40 focus:outline-none disabled:opacity-60 lg:h-8";
</script>

<script lang="ts">
import type { Snippet } from "svelte";

const {
	label,
	hint,
	for: htmlFor,
	meta,
	control,
	children,
}: {
	label: string;
	hint?: string;
	for?: string;
	meta?: Snippet;
	control?: Snippet;
	children?: Snippet;
} = $props();
</script>

<div class="py-4">
	<div class="flex flex-wrap items-center justify-between gap-x-6 gap-y-3">
		<div class="min-w-[min(100%,10rem)] flex-1">
			{#if htmlFor}
				<label for={htmlFor} class="text-[13px] text-text-primary">{label}</label>
			{:else}
				<div class="text-[13px] text-text-primary">{label}</div>
			{/if}
			{#if hint}<p class="mt-0.5 text-[12px] leading-5 text-text-tertiary">{hint}</p>{/if}
			{@render meta?.()}
		</div>
		{#if control}
			<div class="flex max-w-full shrink-0 items-center gap-2">{@render control()}</div>
		{/if}
	</div>
	{@render children?.()}
</div>
