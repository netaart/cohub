<script lang="ts">
import { Check } from "lucide-svelte";
import { onMount, tick } from "svelte";
import {
	MENU_SEPARATOR,
	type MenuEntries,
	type MenuItem,
	normalizeMenu,
} from "#lib/context-menu/menu.ts";

const {
	items,
	label,
	focusFirst = true,
	onSelect,
}: {
	items: MenuEntries;
	label: string;
	focusFirst?: boolean;
	onSelect: (item: MenuItem) => void;
} = $props();

const entries = $derived(normalizeMenu(items));
let root = $state<HTMLElement | null>(null);

function options() {
	return Array.from(
		root?.querySelectorAll<HTMLElement>('[role^="menuitem"]:not(:disabled)') ??
			[],
	);
}

// After the panel is portaled, which would otherwise drop the focus.
onMount(() => {
	void tick().then(() =>
		(focusFirst ? options()[0] : root)?.focus({ preventScroll: true }),
	);
});

function onKeydown(event: KeyboardEvent) {
	const list = options();
	if (list.length === 0) return;
	const index = list.indexOf(document.activeElement as HTMLElement);
	const next =
		event.key === "ArrowDown"
			? (index + 1) % list.length
			: event.key === "ArrowUp"
				? (Math.max(index, 0) - 1 + list.length) % list.length
				: event.key === "Home"
					? 0
					: event.key === "End"
						? list.length - 1
						: null;
	if (next === null) return;
	event.preventDefault();
	list[next]?.focus();
}
</script>

{#snippet body(item: MenuItem)}
	{#if item.icon}
		<item.icon class={item.warning ? "text-error" : undefined} aria-hidden="true" />
	{/if}
	<span class="min-w-0 flex-1 truncate">{item.label}</span>
	{#if item.checked}<Check class="text-brand" aria-hidden="true" />{/if}
{/snippet}

<div bind:this={root} class="flex flex-col outline-none" role="menu" aria-label={label} tabindex="-1" data-menu-list onkeydown={onKeydown}>
	{#each entries as entry, index (entry === MENU_SEPARATOR ? `separator:${index}` : entry.id)}
		{#if entry === MENU_SEPARATOR}
			<div class="menu-separator" role="separator"></div>
		{:else}
			<button
				type="button"
				class="menu-item"
				role={entry.checked === undefined ? "menuitem" : "menuitemcheckbox"}
				aria-checked={entry.checked}
				disabled={entry.disabled}
				data-tone={entry.danger ? "danger" : undefined}
				onclick={() => onSelect(entry)}
			>
				{@render body(entry)}
			</button>
		{/if}
	{/each}
</div>
