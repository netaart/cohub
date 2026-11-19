<script lang="ts">
import type { Snippet } from "svelte";
import MenuList from "#lib/components/context-menu/MenuList.svelte";
import AdaptivePopover from "#lib/components/list-page/AdaptivePopover.svelte";
import type { MenuEntries, MenuItem } from "#lib/context-menu/menu.ts";
import { getLocale } from "#lib/i18n/locale.svelte.ts";
import { useCompactShell } from "#lib/layout/compact-shell.svelte.ts";
import { m } from "#lib/paraglide/messages.js";

const {
	open,
	anchor = null,
	point = null,
	sheet,
	title,
	items,
	header,
	onClose,
}: {
	open: boolean;
	anchor?: HTMLElement | null;
	point?: { x: number; y: number } | null;
	sheet?: boolean;
	title?: string;
	items: MenuEntries;
	header?: Snippet;
	onClose: () => void;
} = $props();

const asSheet = $derived(sheet ?? useCompactShell());
const label = $derived(
	title || m.inline_more_actions({}, { locale: getLocale() }),
);

$effect.pre(() => {
	if (!open) return;
	const returnTo = document.activeElement;
	return () => {
		const focused = document.activeElement;
		if (focused !== document.body && !focused?.closest("[data-menu-list]"))
			return;
		if (returnTo instanceof HTMLElement && returnTo.isConnected)
			returnTo.focus({ preventScroll: true });
	};
});

function select(item: MenuItem) {
	if (item.disabled) return;
	onClose();
	item.run();
}
</script>

<AdaptivePopover {open} {anchor} {point} sheet={asSheet} {label} {onClose} width={null} placement="bottom-end">
	{#if asSheet && title}
		<p class="truncate px-3 pb-2 pt-0.5 text-[12px] text-text-tertiary">{title}</p>
	{/if}
	{@render header?.()}
	<MenuList {items} {label} focusFirst={!point} onSelect={select} />
</AdaptivePopover>
