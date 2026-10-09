<script lang="ts">
import { ChevronDown } from "lucide-svelte";
import type { Snippet } from "svelte";

type Props = {
	title: string;
	count?: number | string | null;
	collapsed: boolean;
	onToggle: () => void;
	meta?: Snippet;
	children: Snippet;
};

const {
	title,
	count = null,
	collapsed,
	onToggle,
	meta,
	children,
}: Props = $props();

const bodyId = $props.id();
</script>

<section class="min-w-0">
	<div class="flex h-8 items-center gap-1 pr-1">
		<button
			type="button"
			class="flex min-w-0 flex-1 items-center gap-1.5 rounded-[5px] px-1.5 py-1 text-left transition-colors hover:bg-bg-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/35"
			aria-expanded={!collapsed}
			aria-controls={collapsed ? undefined : bodyId}
			onclick={onToggle}
		>
			<ChevronDown
				class="h-3 w-3 shrink-0 text-text-tertiary transition-transform duration-150 {collapsed ? '-rotate-90' : ''}"
			/>
			<span class="truncate text-[11px] font-medium text-text-tertiary">{title}</span>
			{#if count !== null && count !== 0}
				<span class="text-[11px] tabular-nums text-text-placeholder">{count}</span>
			{/if}
		</button>
		{#if meta}
			<div class="flex shrink-0 items-center gap-0.5">{@render meta()}</div>
		{/if}
	</div>
	{#if !collapsed}
		<div id={bodyId}>{@render children()}</div>
	{/if}
</section>
