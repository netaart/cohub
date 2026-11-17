<script lang="ts">
import type { LabelAssignmentListItem } from "@neta-art/cohub";
import {
	File as FileIcon,
	History,
	Link2Off,
	MessageSquare,
} from "lucide-svelte";
import SidebarActionButton from "#lib/components/sidebar/SidebarActionButton.svelte";
import { getLocale } from "#lib/i18n/locale.svelte.ts";
import { m } from "#lib/paraglide/messages.js";

const {
	item,
	active = false,
	removeLabelTitle,
	removeLabelDisabled = false,
	onNavigate,
	onRemoveLabel,
}: {
	item: LabelAssignmentListItem;
	active?: boolean;
	removeLabelTitle?: string;
	removeLabelDisabled?: boolean;
	onNavigate: (href: string) => void;
	onRemoveLabel?: () => void;
} = $props();

const locale = $derived(getLocale());
const title = $derived(item.resource?.title ?? item.resourceRef);
const subtitle = $derived(item.resource?.subtitle ?? item.resourceRef);
const Icon = $derived.by(() => {
	if (item.resourceType === "session") return MessageSquare;
	if (item.resourceType === "checkpoint") return History;
	return FileIcon;
});
</script>

<a
	href={item.href}
	class="sidebar-flyout-item group/resource relative flex items-center gap-2 overflow-hidden rounded-[var(--sidebar-item-radius)] px-1.5 py-1.5 pr-4 text-[13px] transition-colors duration-100 {onRemoveLabel ? 'hover:pr-12 focus-within:pr-12' : ''} {active ? 'bg-[var(--sidebar-item-active-bg)] font-medium text-[var(--sidebar-item-active-fg)]' : 'text-text-tertiary hover:bg-[var(--sidebar-item-hover-bg)] hover:text-text-secondary'}"
	onclick={(event) => {
		event.preventDefault();
		onNavigate(item.href);
	}}
	title={subtitle}
>
	<Icon class="h-3.5 w-3.5 shrink-0 text-text-placeholder" />
	<span class="min-w-0 flex-1 truncate">{title}</span>
	{#if onRemoveLabel}
		<span class="absolute right-1 top-1/2 inline-flex -translate-y-1/2 items-center gap-0.5 opacity-0 pointer-events-none transition-opacity group-hover/resource:opacity-100 group-hover/resource:pointer-events-auto group-focus-within/resource:opacity-100 group-focus-within/resource:pointer-events-auto">
			<SidebarActionButton icon={Link2Off} title={removeLabelTitle ?? m.sidebar_remove_from_label_generic({}, { locale })} disabled={removeLabelDisabled} tone="danger" onClick={onRemoveLabel} />
		</span>
	{/if}
</a>
