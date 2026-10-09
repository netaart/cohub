<script lang="ts">
import type { UserSessionSourceKey } from "@neta-art/cohub";
import { Check, ListFilter } from "lucide-svelte";
import AdaptivePopover from "$lib/components/list-page/AdaptivePopover.svelte";
import HeaderAction from "$lib/components/list-page/HeaderAction.svelte";
import { getLocale } from "$lib/i18n/locale.svelte";
import { m } from "$lib/paraglide/messages.js";
import {
	CHATS_SOURCE_GROUPS,
	type ChatsSourceGroup,
	chatsSourceName,
	DEFAULT_CHATS_FILTER,
} from "$lib/stores/chats-filter";

const {
	value,
	onChange,
}: {
	value: UserSessionSourceKey | null;
	onChange: (source: UserSessionSourceKey | null) => void;
} = $props();

const locale = $derived(getLocale());
let open = $state(false);
let anchor = $state<HTMLElement | null>(null);

function sourceName(source: UserSessionSourceKey | null) {
	return chatsSourceName(source, locale);
}

function groupName(group: ChatsSourceGroup) {
	switch (group) {
		case "clients":
			return m.chats_source_group_clients({}, { locale });
		case "channels":
			return m.chats_source_group_channels({}, { locale });
		case "automations":
			return m.chats_source_group_automations({}, { locale });
		case "other":
			return null;
	}
}

function pick(source: UserSessionSourceKey | null) {
	open = false;
	onChange(source);
}
</script>

{#snippet option(source: UserSessionSourceKey | null)}
	{@const selected = value === source}
	<button
		type="button"
		role="menuitemradio"
		aria-checked={selected}
		class="source-option {selected ? 'text-text-primary' : 'text-text-secondary'}"
		onclick={() => pick(source)}
	>
		<span class="min-w-0 flex-1 truncate">{sourceName(source)}</span>
		<Check class="h-3.5 w-3.5 shrink-0 text-brand {selected ? 'opacity-100' : 'opacity-0'}" />
	</button>
{/snippet}

<HeaderAction
	bind:ref={anchor}
	label={m.chats_source_current({ source: sourceName(value) }, { locale })}
	icon={ListFilter}
	expanded={open}
	indicator={value !== DEFAULT_CHATS_FILTER.source}
	onclick={() => {
		open = !open;
	}}
/>

<AdaptivePopover {open} {anchor} label={m.chats_source_label({}, { locale })} width={220} onClose={() => (open = false)}>
	<div role="menu" aria-label={m.chats_source_label({}, { locale })}>
		{@render option(null)}
		{#each CHATS_SOURCE_GROUPS as group (group.id)}
			{@const heading = groupName(group.id)}
			<div class="my-1 h-px bg-border-subtle" role="separator"></div>
			{#if heading}
				<div class="px-2 pb-0.5 pt-1 text-[11px] text-text-placeholder">{heading}</div>
			{/if}
			{#each group.sources as source (source)}
				{@render option(source)}
			{/each}
		{/each}
	</div>
</AdaptivePopover>

<style>
	.source-option {
		display: flex;
		min-height: 40px;
		width: 100%;
		align-items: center;
		gap: 8px;
		border-radius: 6px;
		padding: 0 8px;
		text-align: left;
		font-size: 13px;
		transition: background-color 90ms, color 90ms;
	}

	.source-option:hover {
		background: var(--bg-hover);
		color: var(--text-primary);
	}

	@media (min-width: 960px) {
		.source-option {
			min-height: 28px;
			font-size: 12px;
		}
	}
</style>
