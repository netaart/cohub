<script lang="ts">
import type { CheckpointRecord } from "@neta-art/cohub";
import { Link2Off } from "lucide-svelte";
import SidebarActionButton from "#lib/components/sidebar/SidebarActionButton.svelte";
import { getLocale } from "#lib/i18n/locale.svelte.ts";
import { m } from "#lib/paraglide/messages.js";
import { formatCompactAbsoluteTime } from "#lib/time-format.ts";

const {
	checkpoint,
	href,
	active = false,
	removeLabelTitle,
	removeLabelDisabled = false,
	onNavigate,
	onRemoveLabel,
}: {
	checkpoint: CheckpointRecord;
	href: string;
	active?: boolean;
	removeLabelTitle?: string;
	removeLabelDisabled?: boolean;
	onNavigate: (checkpoint: CheckpointRecord) => void;
	onRemoveLabel?: () => void;
} = $props();

function compactId(id: string) {
	return id.length > 12 ? id.slice(0, 8) : id;
}

const locale = $derived(getLocale());
const title = $derived(
	checkpoint.description?.trim() ||
		m.sidebar_save_name({ id: compactId(checkpoint.id) }, { locale }),
);
const createdAt = $derived(formatCompactAbsoluteTime(checkpoint.createdAt));
</script>

<a
	{href}
	class="sidebar-flyout-item group/checkpoint relative flex items-center gap-2 overflow-hidden rounded-[var(--sidebar-item-radius)] px-1.5 py-1.5 pr-4 text-[13px] transition-colors duration-100 {onRemoveLabel ? 'hover:pr-12 focus-within:pr-12' : ''} {active ? 'bg-[var(--sidebar-item-active-bg)] font-medium text-[var(--sidebar-item-active-fg)]' : 'text-text-tertiary hover:bg-[var(--sidebar-item-hover-bg)] hover:text-text-secondary'}"
	onclick={(event) => {
		event.preventDefault();
		onNavigate(checkpoint);
	}}
	title={title}
>
	<span class="flex min-w-0 flex-1 items-center gap-2 leading-tight">
		<span class="min-w-0 flex-1 truncate leading-4">{title}</span>
		<span class="shrink-0 tabular-nums text-[9.5px] font-normal leading-4 text-text-placeholder/70 group-hover/checkpoint:hidden group-focus-within/checkpoint:hidden">{createdAt}</span>
	</span>
	{#if onRemoveLabel}
		<span class="absolute right-1 top-1/2 inline-flex -translate-y-1/2 items-center gap-0.5 opacity-0 pointer-events-none transition-opacity group-hover/checkpoint:opacity-100 group-hover/checkpoint:pointer-events-auto group-focus-within/checkpoint:opacity-100 group-focus-within/checkpoint:pointer-events-auto">
			<SidebarActionButton icon={Link2Off} title={removeLabelTitle ?? m.sidebar_remove_from_label_generic({}, { locale })} disabled={removeLabelDisabled} tone="danger" onClick={onRemoveLabel} />
		</span>
	{/if}
</a>
