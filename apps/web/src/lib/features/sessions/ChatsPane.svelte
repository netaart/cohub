<script lang="ts" module>
const scrollOffsets = new Map<string, number>();
</script>

<script lang="ts">
import type {
	UserSessionListItem,
	UserSessionSpaceSummary,
} from "@neta-art/cohub";
import { Plus, Search, X } from "lucide-svelte";
import { onMount, tick } from "svelte";
import { goto } from "$app/navigation";
import { openAreaSearch } from "$lib/command-palette/open";
import FilterBar from "$lib/components/list-page/FilterBar.svelte";
import FilterChip from "$lib/components/list-page/FilterChip.svelte";
import HeaderAction from "$lib/components/list-page/HeaderAction.svelte";
import ListHeader from "$lib/components/list-page/ListHeader.svelte";
import ListRowSkeleton from "$lib/components/list-page/ListRowSkeleton.svelte";
import {
	LIST_ROW_AVATAR,
	type ListRowDensity,
} from "$lib/components/list-page/list-row";
import SessionRow from "$lib/components/SessionRow.svelte";
import SpaceAvatar from "$lib/components/SpaceAvatar.svelte";
import ChatsSourcePicker from "$lib/features/sessions/ChatsSourcePicker.svelte";
import { chatsInbox } from "$lib/features/sessions/chats-inbox.svelte";
import { swipePager } from "$lib/gestures/swipe-pager";
import { getLocale } from "$lib/i18n/locale.svelte";
import { onListScrollTop, scrollListToTop } from "$lib/layout/list-scroll-top";
import { m } from "$lib/paraglide/messages.js";
import { buildSessionForkTree, getSessionTreeTitle } from "$lib/session-fork-tree";
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

const locale = $derived(getLocale());
const inbox = chatsInbox;
const filter = $derived(inbox.filter);
const scoped = $derived(Boolean(filter.space));
const isPage = $derived(variant === "page");
const density = $derived<ListRowDensity>(isPage ? "comfortable" : "compact");
const isDefaultFilter = $derived(filter.source === "web" && !filter.space);
const pages = $derived<(UserSessionSpaceSummary | null)[]>([
	null,
	...inbox.spaceChips,
]);
const pageIndex = $derived(
	Math.max(
		0,
		pages.findIndex((space) => (space?.id ?? null) === (filter.space?.id ?? null)),
	),
);
const rows = $derived.by(() => {
	const items = buildSessionForkTree(inbox.sessions, inbox.forks);
	return items.map((item, index) => ({
		...item,
		tree: {
			depth: Math.min(item.visualDepth, 1),
			last: (items[index + 1]?.visualDepth ?? 0) === 0,
			hasChildren: item.visualDepth === 0 && item.hasChildren,
		},
	}));
});
let scroller = $state<HTMLDivElement | null>(null);

function hrefFor(session: UserSessionListItem) {
	return isPage
		? buildSpaceSessionRoute(session.spaceId, session.id)
		: buildUserSessionRoute(session.id);
}

function spaceName(session: UserSessionListItem) {
	return session.space?.name?.trim() || m.spaces_default_name({}, { locale });
}

function subtitleFor(row: (typeof rows)[number], title: string) {
	const preview = getSessionPreview(row.session, title);
	if (scoped || row.fork) return preview;
	const name = spaceName(row.session);
	return preview ? `${name} · ${preview}` : name;
}

function forkTooltip(parentTitle: string | null | undefined) {
	const title = parentTitle?.trim();
	return title
		? m.sidebar_forked_from({ title }, { locale })
		: m.sidebar_forked_from_chat({}, { locale });
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

$effect(() => {
	if (!isPage) return;
	const neighbours = [pages[pageIndex - 1], pages[pageIndex + 1]]
		.filter((space) => space !== undefined)
		.map((space) => ({ ...filter, space }));
	void inbox.prewarm(neighbours);
});

onMount(() => {
	void modelsCatalogStore.load().catch(() => undefined);
	const stopScrollTop = isPage
		? onListScrollTop(() => scrollListToTop(scroller))
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

	<div
		bind:this={scroller}
		class="min-h-0 flex-1 overflow-y-auto overscroll-contain px-[var(--list-gutter-x)] py-1.5"
		data-drawer-swipe-ignore={isPage ? "" : undefined}
		onscroll={onScroll}
		use:swipePager={{
			index: pageIndex,
			count: pages.length,
			enabled: isPage,
			onChange: (index) => inbox.setSpace(pages[index] ?? null),
		}}
	>
		{#if inbox.loading && inbox.sessions.length === 0}
			<ListRowSkeleton {density} label={m.common_loading({}, { locale })} />
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
			<ul>
				{#each rows as row (row.session.id)}
					{@const session = row.session}
					{@const title = getSessionTreeTitle(row) ?? m.sidebar_new_chat({}, { locale })}
					<li>
						<SessionRow
							{session}
							{title}
							href={hrefFor(session)}
							{density}
							subtitle={subtitleFor(row, title)}
							active={activeSessionId === session.id}
							isMobile={isPage}
							modelsCatalog={modelsCatalogStore.items ?? undefined}
							showSourceBadge={!filter.source}
							tree={row.tree}
							tooltip={row.fork ? forkTooltip(row.fork.parentTitle) : undefined}
							showInsert={false}
							showRename={false}
							onNavigate={open}
						>
							{#snippet avatar()}
								<SpaceAvatar name={spaceName(session)} profile={session.space?.publicProfile ?? null} size={LIST_ROW_AVATAR[density]} />
							{/snippet}
						</SessionRow>
					</li>
				{/each}
			</ul>
			{#if inbox.loadingMore}
				<div class="flex h-10 items-center justify-center text-[12px] text-text-placeholder">{m.common_loading({}, { locale })}</div>
			{/if}
		{/if}
	</div>
</section>
