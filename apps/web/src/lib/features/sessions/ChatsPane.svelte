<script lang="ts">
import type { UserSessionSpaceSummary } from "@neta-art/cohub";
import { Plus, Search, X } from "lucide-svelte";
import { onMount, untrack } from "svelte";
import { openAreaSearch } from "$lib/command-palette/open";
import FilterBar from "$lib/components/list-page/FilterBar.svelte";
import FilterChip from "$lib/components/list-page/FilterChip.svelte";
import HeaderAction from "$lib/components/list-page/HeaderAction.svelte";
import ListHeader from "$lib/components/list-page/ListHeader.svelte";
import SwipePager from "$lib/components/list-page/SwipePager.svelte";
import SpaceAvatar from "$lib/components/SpaceAvatar.svelte";
import ChatsList from "$lib/features/sessions/ChatsList.svelte";
import ChatsSourcePicker from "$lib/features/sessions/ChatsSourcePicker.svelte";
import { chatsInbox } from "$lib/features/sessions/chats-inbox.svelte";
import { getLocale } from "$lib/i18n/locale.svelte";
import { onListScrollTop } from "$lib/layout/list-scroll-top";
import { m } from "$lib/paraglide/messages.js";
import { modelsCatalogStore } from "$lib/stores/models-catalog.svelte";

const {
	variant,
	activeSessionId = null,
	onNavigate,
}: {
	variant: "page" | "sidebar";
	activeSessionId?: string | null;
	onNavigate?: () => void;
} = $props();

const ALL_KEY = "all";

const locale = $derived(getLocale());
const inbox = chatsInbox;
const filter = $derived(inbox.filter);
const isPage = $derived(variant === "page");
const pages = $derived<(UserSessionSpaceSummary | null)[]>([
	null,
	...inbox.spaceChips,
]);
const keys = $derived(pages.map((space) => space?.id ?? ALL_KEY));
const pageIndex = $derived(
	Math.max(0, keys.indexOf(filter.space?.id ?? ALL_KEY)),
);
let swipePosition = $state<number | null>(null);
const position = $derived(isPage ? (swipePosition ?? pageIndex) : pageIndex);
const shownIndex = $derived(Math.round(position));
const lists: (ChatsList | undefined)[] = [];

function select(index: number) {
	if (index === 0 && pageIndex === 0) {
		lists[0]?.scrollToTop();
		return;
	}
	inbox.setSpace(index === pageIndex ? null : (pages[index] ?? null));
}

$effect(() => {
	if (!isPage) return;
	const neighbours = [pages[pageIndex - 1], pages[pageIndex + 1]]
		.filter((space) => space !== undefined)
		.map((space) => ({ ...filter, space }));
	untrack(() => inbox.prewarm(neighbours));
});

onMount(() => {
	void modelsCatalogStore.load().catch(() => undefined);
	const stopScrollTop = isPage
		? onListScrollTop(() => lists[pageIndex]?.scrollToTop())
		: undefined;
	const release = inbox.retain();
	return () => {
		stopScrollTop?.();
		release();
	};
});
</script>

{#snippet sourcePicker()}
	<ChatsSourcePicker value={filter.source} onChange={(source) => inbox.setSource(source)} />
{/snippet}

<section class="flex h-full min-h-0 flex-col {isPage ? 'bg-bg-primary' : 'list-compact'}">
	<div class="shrink-0 border-b border-border-subtle">
		<ListHeader title={m.nav_tab_chats({}, { locale })} brand={isPage}>
			{#snippet actions()}
				{#if isPage}
					<HeaderAction label={m.list_search({}, { locale })} icon={Search} onclick={() => openAreaSearch("chats")} />
				{:else}
					<div class="mr-0.5">{@render sourcePicker()}</div>
				{/if}
				<HeaderAction
					label={m.sidebar_new_chat({}, { locale })}
					icon={Plus}
					tone="brand"
					shortcut={isPage ? undefined : "⌘O"}
					onclick={() => {
						onNavigate?.();
						void inbox.newChat();
					}}
				/>
			{/snippet}
		</ListHeader>
		<FilterBar
			label={m.chats_filter_label({}, { locale })}
			role="tablist"
			activeKey={keys[shownIndex] ?? null}
			{position}
			leading={isPage ? sourcePicker : undefined}
		>
			<FilterChip
				label={m.chats_space_all({}, { locale })}
				title={m.chats_space_all_hint({}, { locale })}
				active={shownIndex === 0}
				onclick={() => select(0)}
			/>
			{#each inbox.spaceChips as space, index (space.id)}
				{@const selected = pageIndex === index + 1}
				<FilterChip
					label={space.name}
					active={shownIndex === index + 1}
					title={selected ? m.chats_space_all_hint({}, { locale }) : space.name}
					onclick={() => select(index + 1)}
				>
					{#snippet leading()}
						<SpaceAvatar name={space.name} profile={space.publicProfile ?? null} size="xxs" />
					{/snippet}
					{#snippet trailing()}
						{#if selected}<X class="h-3 w-3 shrink-0 opacity-70" aria-hidden="true" />{/if}
					{/snippet}
				</FilterChip>
			{/each}
		</FilterBar>
	</div>

	<SwipePager
		{keys}
		index={pageIndex}
		enabled={isPage}
		onChange={(index) => inbox.setSpace(pages[index] ?? null)}
		onPosition={(next) => (swipePosition = next)}
	>
		{#snippet page(index, active)}
			{@const pageFilter = { ...filter, space: pages[index] ?? null }}
			<ChatsList
				bind:this={() => lists[index], (instance) => (lists[index] = instance)}
				view={inbox.viewOf(pageFilter)}
				filter={pageFilter}
				{active}
				{variant}
				{activeSessionId}
				{onNavigate}
			/>
		{/snippet}
	</SwipePager>
</section>
