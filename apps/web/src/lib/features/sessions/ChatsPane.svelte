<script lang="ts" module>
const scrollOffsets = new Map<string, number>();
</script>

<script lang="ts">
import type { UserSessionListItem } from "@neta-art/cohub";
import { Plus, Search, X } from "lucide-svelte";
import { onMount, tick } from "svelte";
import { goto } from "$app/navigation";
import { openAreaSearch } from "$lib/command-palette/open";
import FilterBar from "$lib/components/list-page/FilterBar.svelte";
import FilterChip from "$lib/components/list-page/FilterChip.svelte";
import HeaderAction from "$lib/components/list-page/HeaderAction.svelte";
import ListHeader from "$lib/components/list-page/ListHeader.svelte";
import SessionSidebarRowContent from "$lib/components/SessionSidebarRowContent.svelte";
import SpaceAvatar from "$lib/components/SpaceAvatar.svelte";
import { getSessionTitle } from "$lib/features/session-chat";
import ChatsSourcePicker from "$lib/features/sessions/ChatsSourcePicker.svelte";
import { chatsInbox } from "$lib/features/sessions/chats-inbox.svelte";
import { getLocale } from "$lib/i18n/locale.svelte";
import { m } from "$lib/paraglide/messages.js";
import { getSessionPreview } from "$lib/session-preview";
import {
	buildSpaceSessionRoute,
	buildUserSessionRoute,
} from "$lib/space-routes";
import { chatsFilterScope } from "$lib/stores/chats-filter";
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

const LOAD_MORE_THRESHOLD_PX = 480;
const SKELETON_ROWS = [0, 1, 2, 3, 4, 5, 6];

const locale = $derived(getLocale());
const inbox = chatsInbox;
const filter = $derived(inbox.filter);
const scoped = $derived(Boolean(filter.space));
const isPage = $derived(variant === "page");
const isDefaultFilter = $derived(filter.source === "web" && !filter.space);
let scroller = $state<HTMLDivElement | null>(null);

function hrefFor(session: UserSessionListItem) {
	return isPage
		? buildSpaceSessionRoute(session.spaceId, session.id)
		: buildUserSessionRoute(session.id);
}

function spaceName(session: UserSessionListItem) {
	return session.space?.name?.trim() || m.spaces_default_name({}, { locale });
}

function subtitleFor(session: UserSessionListItem) {
	const preview = getSessionPreview(session);
	if (scoped) return preview;
	return preview ? `${spaceName(session)} · ${preview}` : spaceName(session);
}

function open(event: MouseEvent, session: UserSessionListItem) {
	if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0)
		return;
	event.preventDefault();
	onNavigate?.();
	void goto(
		hrefFor(session),
		isPage ? undefined : { keepFocus: true, noScroll: true },
	);
}

function onScroll(event: Event) {
	const element = event.currentTarget as HTMLElement;
	scrollOffsets.set(chatsFilterScope(filter), element.scrollTop);
	if (
		element.scrollHeight - element.scrollTop - element.clientHeight <
		LOAD_MORE_THRESHOLD_PX
	)
		void inbox.loadMore();
}

let restoredScope: string | null = null;
$effect(() => {
	const scope = chatsFilterScope(filter);
	const hasRows = inbox.sessions.length > 0;
	if (!scroller || !hasRows || restoredScope === scope) return;
	restoredScope = scope;
	const offset = scrollOffsets.get(scope) ?? 0;
	void tick().then(() => {
		if (scroller) scroller.scrollTop = offset;
	});
});

onMount(() => {
	void modelsCatalogStore.load().catch(() => undefined);
	return inbox.retain();
});
</script>

{#snippet sourcePicker()}
	<ChatsSourcePicker value={filter.source} onChange={(source) => inbox.setSource(source)} />
{/snippet}

<section class="flex h-full min-h-0 flex-col {isPage ? 'bg-bg-primary' : ''}">
	<div class="shrink-0 border-b border-border-subtle">
		<ListHeader title={m.nav_tab_chats({}, { locale })} busy={inbox.refreshing} brand={isPage}>
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
			activeKey={filter.space?.id ?? null}
			leading={isPage ? sourcePicker : undefined}
		>
			{#each inbox.spaceChips as space (space.id)}
				{@const active = filter.space?.id === space.id}
				<FilterChip
					kind="toggle"
					label={space.name}
					{active}
					title={active
						? m.chats_space_clear({}, { locale })
						: m.chats_space_only({ name: space.name }, { locale })}
					onclick={() => inbox.toggleSpace(space)}
				>
					{#snippet leading()}
						<SpaceAvatar name={space.name} profile={space.publicProfile ?? null} size="xxs" />
					{/snippet}
					{#snippet trailing()}
						{#if active}<X class="h-3 w-3 shrink-0 opacity-70" aria-hidden="true" />{/if}
					{/snippet}
				</FilterChip>
			{/each}
		</FilterBar>
	</div>

	<div bind:this={scroller} class="min-h-0 flex-1 overflow-y-auto overscroll-contain px-1.5 py-1.5" onscroll={onScroll}>
		{#if inbox.loading && inbox.sessions.length === 0}
			<div aria-busy="true" aria-label={m.common_loading({}, { locale })}>
				{#each SKELETON_ROWS as index (index)}
					<div class="flex items-center gap-[var(--list-row-gap)] px-[var(--list-row-pad-x)] py-2" style:min-height="var(--list-row-height)">
						{#if !scoped}<div class="h-9 w-9 shrink-0 rounded-[10px] bg-bg-surface"></div>{/if}
						<div class="min-w-0 flex-1 space-y-1.5">
							<div class="h-3 rounded-[3px] bg-bg-surface" style:width={`${45 + ((index * 23) % 40)}%`}></div>
							<div class="h-2.5 w-2/3 rounded-[3px] bg-bg-surface/70"></div>
						</div>
					</div>
				{/each}
			</div>
		{:else if inbox.error && inbox.sessions.length === 0}
			<div class="px-3 py-8 text-center">
				<p class="text-[12px] text-error-soft">{inbox.error}</p>
				<button type="button" class="mt-3 text-[12px] text-text-secondary underline underline-offset-2 hover:text-text-primary" onclick={() => void inbox.refresh()}>
					{m.common_retry({}, { locale })}
				</button>
			</div>
		{:else if inbox.sessions.length === 0}
			<div class="flex flex-col items-center px-6 py-12 text-center">
				<p class="text-[13px] font-medium text-text-secondary">
					{isDefaultFilter ? m.sessions_no_chats({}, { locale }) : m.chats_empty_filtered({}, { locale })}
				</p>
				<p class="mt-1 max-w-[260px] text-[12px] text-text-tertiary">
					{isDefaultFilter ? m.sessions_no_chats_hint({}, { locale }) : m.chats_empty_filtered_hint({}, { locale })}
				</p>
				<div class="mt-4 flex items-center gap-2">
					<button
						type="button"
						class="inline-flex h-8 items-center gap-1.5 rounded-[6px] bg-brand-muted px-3 text-[12px] font-medium text-brand-muted-fg transition-colors hover:bg-brand-muted-hover"
						onclick={() => void inbox.newChat()}
					>
						<Plus class="h-3.5 w-3.5" />{m.sidebar_new_chat({}, { locale })}
					</button>
					{#if filter.source || filter.space}
						<button
							type="button"
							class="inline-flex h-8 items-center rounded-[6px] px-3 text-[12px] text-text-tertiary transition-colors hover:bg-bg-hover hover:text-text-secondary"
							onclick={() => inbox.showAll()}
						>
							{m.chats_show_all({}, { locale })}
						</button>
					{/if}
				</div>
			</div>
		{:else}
			<ul class="space-y-[2px]">
				{#each inbox.sessions as session (session.id)}
					{@const active = activeSessionId === session.id}
					<li>
						<a
							href={hrefFor(session)}
							class="relative flex items-center gap-[var(--list-row-gap)] overflow-hidden rounded-[var(--list-row-radius)] px-[var(--list-row-pad-x)] py-2 transition-colors duration-100 {isPage ? 'text-[15px]' : 'text-[14px]'} {active ? 'bg-[var(--list-row-active-bg)]' : 'hover:bg-[var(--list-row-hover-bg)]'}"
							style:min-height="var(--list-row-height)"
							aria-current={active ? "page" : undefined}
							onclick={(event) => open(event, session)}
						>
							{#if !scoped}
								<SpaceAvatar name={spaceName(session)} profile={session.space?.publicProfile ?? null} size="md" />
							{/if}
							<SessionSidebarRowContent
								{session}
								title={getSessionTitle(session)}
								subtitle={subtitleFor(session)}
								isMobile={isPage}
								modelsCatalog={modelsCatalogStore.items ?? undefined}
								showSourceBadge={!filter.source}
							/>
						</a>
					</li>
				{/each}
			</ul>
			{#if inbox.loadingMore}
				<div class="flex h-10 items-center justify-center text-[12px] text-text-placeholder">{m.common_loading({}, { locale })}</div>
			{/if}
		{/if}
	</div>
</section>
