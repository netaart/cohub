<script lang="ts" module>
export type StatsGroupItem = { key: string; label: string; value: string };
</script>

<script lang="ts">
let {
	title,
	items,
	class: className = "border-t border-border-subtle pt-3",
}: { title: string; items: readonly StatsGroupItem[]; class?: string } =
	$props();
</script>

<section class={className} aria-label={title}>
	<h4 class="mb-2 text-[10px] font-medium uppercase tracking-[0.12em] text-text-placeholder">{title}</h4>
	<dl class="grid grid-cols-1 gap-x-5 gap-y-2 sm:grid-cols-2">
		{#each items as item (item.key)}
			<div class="flex min-w-0 items-baseline justify-between gap-3">
				<dt class="min-w-0 truncate text-text-tertiary">{item.label}</dt>
				<dd class="shrink-0 text-right tabular-nums text-text-primary">{item.value}</dd>
			</div>
		{/each}
	</dl>
</section>
