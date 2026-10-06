<script lang="ts">
import type { UserSessionListItem } from "@neta-art/cohub";
import { Plus } from "lucide-svelte";
import { goto } from "$app/navigation";
import ListRowSkeleton from "$lib/components/list-page/ListRowSkeleton.svelte";
import {
	LIST_ROW_AVATAR,
	type ListRowDensity,
} from "$lib/components/list-page/list-row";
import SessionRow from "$lib/components/SessionRow.svelte";
import SpaceAvatar from "$lib/components/SpaceAvatar.svelte";
import {
	type ChatsView,
	chatsInbox,
} from "$lib/features/sessions/chats-inbox.svelte";
import { getLocale } from "$lib/i18n/locale.svelte";
import { scrollListToTop } from "$lib/layout/list-scroll-top";
import { scrollMemory } from "$lib/layout/scroll-memory";
import { m } from "$lib/paraglide/messages.js";
import {
	buildSessionForkTree,
	getSessionTreeTitle,
} from "$lib/session-fork-tree";
import { getSessionPreview } from "$lib/session-preview";
import {
	buildSpaceSessionRoute,
	buildUserSessionRoute,
} from "$lib/space-routes";
import { type ChatsFilter, chatsFilterScope } from "$lib/stores/chats-filter";
import { modelsCatalogStore } from "$lib/stores/models-catalog.svelte";

const {
	view,
	filter,
	active,
	variant,
	activeSessionId = null,
	onNavigate,
}: {
	view: ChatsView;
	filter: ChatsFilter;
	active: boolean;
	variant: "page" | "sidebar";
	activeSessionId?: string | null;
	onNavigate?: () => void;
} = $props();

const LOAD_MORE_THRESHOLD_PX = 480;

const locale = $derived(getLocale());
const isPage = $derived(variant === "page");
const scoped = $derived(Boolean(filter.space));
const density = $derived<ListRowDensity>(isPage ? "comfortable" : "compact");
const isDefaultFilter = $derived(filter.source === "web" && !filter.space);
const rows = $derived.by(() => {
	const items = buildSessionForkTree(view.sessions, view.forks);
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

export function scrollToTop() {
	scrollListToTop(scroller);
}

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
	if (!active) return;
	const element = event.currentTarget as HTMLElement;
	if (
		element.scrollHeight - element.scrollTop - element.clientHeight <
		LOAD_MORE_THRESHOLD_PX
	)
		void chatsInbox.loadMore();
}
</script>

<div
	bind:this={scroller}
	class="min-h-0 flex-1 overflow-x-hidden overflow-y-auto overscroll-y-contain px-[var(--list-gutter-x)] py-1.5"
	onscroll={onScroll}
	use:scrollMemory={{ key: `chats:${variant}:${chatsFilterScope(filter)}`, ready: rows.length > 0 }}
>
	{#if view.loading && view.sessions.length === 0}
		<ListRowSkeleton {density} label={m.common_loading({}, { locale })} />
	{:else if view.error && view.sessions.length === 0}
		<div class="px-3 py-8 text-center">
			<p class="text-[12px] text-error-soft">{view.error}</p>
			<button type="button" class="mt-3 text-[12px] text-text-secondary underline underline-offset-2 hover:text-text-primary" onclick={() => void chatsInbox.list.sync(filter)}>
				{m.common_retry({}, { locale })}
			</button>
		</div>
	{:else if view.sessions.length === 0}
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
					onclick={() => void chatsInbox.newChat()}
				>
					<Plus class="h-3.5 w-3.5" />{m.sidebar_new_chat({}, { locale })}
				</button>
				{#if filter.source || filter.space}
					<button
						type="button"
						class="inline-flex h-8 items-center rounded-[6px] px-3 text-[12px] text-text-tertiary transition-colors hover:bg-bg-hover hover:text-text-secondary"
						onclick={() => chatsInbox.showAll()}
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
		{#if view.loadingMore}
			<div class="flex h-10 items-center justify-center text-[12px] text-text-placeholder">{m.common_loading({}, { locale })}</div>
		{/if}
	{/if}
</div>
