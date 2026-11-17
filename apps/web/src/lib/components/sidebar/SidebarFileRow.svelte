<script lang="ts">
import { File as FileIcon, Link2Off, TextCursorInput } from "lucide-svelte";
import SidebarActionButton from "#lib/components/sidebar/SidebarActionButton.svelte";
import { getLocale } from "#lib/i18n/locale.svelte.ts";
import { m } from "#lib/paraglide/messages.js";

const {
	path,
	title,
	subtitle = null,
	href,
	active = false,
	isMobile = false,
	removeLabelTitle,
	removeLabelDisabled = false,
	onNavigate,
	onInsert,
	onRemoveLabel,
}: {
	path: string;
	title: string;
	subtitle?: string | null;
	href: string;
	active?: boolean;
	isMobile?: boolean;
	removeLabelTitle?: string;
	removeLabelDisabled?: boolean;
	onNavigate: (path: string) => void;
	onInsert?: (path: string) => void;
	onRemoveLabel?: () => void;
} = $props();

const locale = $derived(getLocale());
const actionCount = $derived((onInsert ? 1 : 0) + (onRemoveLabel ? 1 : 0));
const hoverPaddingClass = $derived(
	!isMobile && actionCount > 0
		? actionCount > 1
			? "hover:pr-16 focus-within:pr-16"
			: "hover:pr-12 focus-within:pr-12"
		: "",
);
</script>

<a
	{href}
	class="sidebar-flyout-item group/file relative flex items-center gap-2 overflow-hidden rounded-[var(--sidebar-item-radius)] px-1.5 py-1.5 pr-4 text-[13px] transition-colors duration-100 {hoverPaddingClass} {active ? 'bg-[var(--sidebar-item-active-bg)] font-medium text-[var(--sidebar-item-active-fg)]' : 'text-text-tertiary hover:bg-[var(--sidebar-item-hover-bg)] hover:text-text-secondary'}"
	onclick={(event) => {
		event.preventDefault();
		onNavigate(path);
	}}
	title={subtitle ?? path}
>
	<FileIcon class="h-3.5 w-3.5 shrink-0 text-text-placeholder" />
	<span class="min-w-0 flex-1 truncate leading-tight">{title}</span>
	{#if !isMobile && actionCount > 0}
		<span class="absolute right-1 top-1/2 inline-flex -translate-y-1/2 items-center gap-0.5 opacity-0 pointer-events-none transition-opacity group-hover/file:opacity-100 group-hover/file:pointer-events-auto group-focus-within/file:opacity-100 group-focus-within/file:pointer-events-auto">
			{#if onInsert}
				<SidebarActionButton icon={TextCursorInput} title={m.common_insert({}, { locale })} onClick={() => onInsert(path)} />
			{/if}
			{#if onRemoveLabel}
				<SidebarActionButton icon={Link2Off} title={removeLabelTitle ?? m.sidebar_remove_from_label_generic({}, { locale })} disabled={removeLabelDisabled} tone="danger" onClick={onRemoveLabel} />
			{/if}
		</span>
	{/if}
</a>
