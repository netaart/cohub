<script lang="ts">
import type { UserSessionListItem } from "@neta-art/cohub";
import { Plus } from "lucide-svelte";
import { tick } from "svelte";
import { goto } from "$app/navigation";
import ListRowSkeleton from "$lib/components/list-page/ListRowSkeleton.svelte";
import {
	type FixedListRowDensity,
	LIST_ROW_AVATAR,
	LIST_ROW_HEIGHT,
} from "$lib/components/list-page/list-row";
import SessionRow from "$lib/components/SessionRow.svelte";
import SpaceAvatar from "$lib/components/SpaceAvatar.svelte";
import {
	type ChatsView,
	chatsInbox,
} from "$lib/features/sessions/chats-inbox.svelte";
import { chatsWorkspaceScope } from "$lib/features/sessions/chats-workspace-scope";
import { withCurrentWindow } from "$lib/features/space/modules/window-route";
import { getLocale } from "$lib/i18n/locale.svelte";
import { scrollListToTop } from "$lib/layout/list-scroll-top";
import { scrollMemory } from "$lib/layout/scroll-memory";
import { m } from "$lib/paraglide/messages.js";
import {
	buildSessionForkTree,
	getSessionTreeTitle,
} from "$lib/session-fork-tree";
import {
	buildSpaceSessionRoute,
	buildUserSessionRoute,
} from "$lib/space-routes";
import { type ChatsFilter, chatsFilterScope } from "$lib/stores/chats-filter";
import { setSessionsArchived } from "$lib/stores/session-archive.svelte";

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
const OVERSCAN_ROWS = 6;

const locale = $derived(getLocale());
const isPage = $derived(variant === "page");
const scoped = $derived(Boolean(filter.space));
const density = $derived<FixedListRowDensity>(
	isPage ? "comfortable" : "compact",
);
const isDefaultFilter = $derived(filter.source === "web" && !filter.space);
const isArchivedView = $derived(filter.archived);
const sessions = $derived(view.sessions);
const forks = $derived(view.forks);
const rows = $derived(buildSessionForkTree(sessions, forks));
let scroller = $state<HTMLDivElement | null>(null);
let scrollTop = $state(0);
let viewportHeight = $state(600);
let focusedSessionId = $state<string | null>(null);
const rowHeight = $derived(LIST_ROW_HEIGHT[density]);
const windowTop = $derived(
	Math.min(scrollTop, Math.max(0, rows.length * rowHeight - viewportHeight)),
);
const start = $derived(
	Math.max(0, Math.floor(windowTop / rowHeight) - OVERSCAN_ROWS),
);
const end = $derived(
	Math.min(
		rows.length,
		Math.ceil((windowTop + viewportHeight) / rowHeight) + OVERSCAN_ROWS,
	),
);
const focusedIndex = $derived(
	focusedSessionId
		? rows.findIndex((row) => row.session.id === focusedSessionId)
		: -1,
);
const visibleIndices = $derived.by(() => {
	const indices = new Set<number>();
	for (let index = start; index < end; index += 1) indices.add(index);
	if (rows.length) {
		indices.add(0);
		indices.add(rows.length - 1);
	}
	if (focusedIndex >= 0) indices.add(focusedIndex);
	return [...indices].sort((a, b) => a - b);
});

function listKeyboard(node: HTMLUListElement) {
	const rowIndex = (target: EventTarget | null) => {
		if (!(target instanceof Element)) return -1;
		const row = target.closest<HTMLElement>("[data-chat-index]");
		return row && node.contains(row) ? Number(row.dataset.chatIndex) : -1;
	};
	const onFocus = (event: FocusEvent) => {
		focusedSessionId = rows[rowIndex(event.target)]?.session.id ?? null;
	};
	const onBlur = (event: FocusEvent) => {
		if (
			!(event.relatedTarget instanceof Node) ||
			!node.contains(event.relatedTarget)
		) {
			focusedSessionId = null;
		}
	};
	const onKeydown = async (event: KeyboardEvent) => {
		if (event.key !== "Tab" || event.altKey || event.ctrlKey || event.metaKey)
			return;
		const index = rowIndex(event.target);
		const next = index + (event.shiftKey ? -1 : 1);
		if (
			index < 0 ||
			next < 0 ||
			next >= rows.length ||
			visibleIndices.includes(next) ||
			!scroller
		)
			return;
		event.preventDefault();
		const id = rows[next].session.id;
		scroller.scrollTop = next * rowHeight;
		scrollTop = scroller.scrollTop;
		await tick();
		if (!node.isConnected || document.activeElement !== event.target) return;
		const targetIndex = rows.findIndex((row) => row.session.id === id);
		node
			.querySelector<HTMLAnchorElement>(
				`[data-chat-index="${targetIndex}"] a[href]`,
			)
			?.focus();
	};
	node.addEventListener("focusin", onFocus);
	node.addEventListener("focusout", onBlur);
	node.addEventListener("keydown", onKeydown);
	return () => {
		node.removeEventListener("focusin", onFocus);
		node.removeEventListener("focusout", onBlur);
		node.removeEventListener("keydown", onKeydown);
	};
}

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

function tooltipFor(row: (typeof rows)[number]) {
	const space = scoped ? null : spaceName(row.session);
	const fork = row.fork ? forkTooltip(row.fork.parentTitle) : null;
	return [space, fork].filter(Boolean).join(" · ") || undefined;
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
	if (isPage) {
		void goto(hrefFor(session));
		return;
	}
	const href = hrefFor(session);
	const sameSpace =
		chatsWorkspaceScope.spaceAt(new URL(window.location.href)) ===
		session.spaceId;
	void goto(sameSpace ? withCurrentWindow(href) : href, {
		keepFocus: true,
		noScroll: true,
	});
}

function onScroll(event: Event) {
	const element = event.currentTarget as HTMLElement;
	scrollTop = element.scrollTop;
	if (!active) return;
	if (
		element.scrollHeight - element.scrollTop - element.clientHeight <
		LOAD_MORE_THRESHOLD_PX
	)
		void chatsInbox.loadMore();
}
</script>

<div
	bind:this={scroller}
	bind:clientHeight={viewportHeight}
	class="scrollbar-quiet min-h-0 flex-1 overflow-x-hidden overflow-y-auto overscroll-y-contain px-[var(--list-gutter-x)] py-1.5"
	onscroll={onScroll}
	use:scrollMemory={{ key: `chats:${variant}:${chatsFilterScope(filter)}`, ready: rows.length > 0, onRestore: (offset) => { scrollTop = offset; } }}
>
	{#if view.loading && sessions.length === 0}
		<ListRowSkeleton {density} label={m.common_loading({}, { locale })} />
	{:else if view.error && sessions.length === 0}
		<div class="px-3 py-8 text-center">
			<p class="text-[12px] text-error-soft">{view.error}</p>
			<button type="button" class="mt-3 text-[12px] text-text-secondary underline underline-offset-2 hover:text-text-primary" onclick={() => void chatsInbox.list.sync(filter)}>
				{m.common_retry({}, { locale })}
			</button>
		</div>
	{:else if sessions.length === 0}
		<div class="flex flex-col items-center px-6 py-12 text-center">
			<p class="text-[13px] font-medium text-text-secondary">
				{isArchivedView ? m.chats_empty_archived({}, { locale }) : isDefaultFilter ? m.sessions_no_chats({}, { locale }) : m.chats_empty_filtered({}, { locale })}
			</p>
			<p class="mt-1 max-w-[260px] text-[12px] text-text-tertiary">
				{isArchivedView ? m.chats_empty_archived_hint({}, { locale }) : isDefaultFilter ? m.sessions_no_chats_hint({}, { locale }) : m.chats_empty_filtered_hint({}, { locale })}
			</p>
			<div class="mt-4 flex items-center gap-2">
				<button
					type="button"
					class="primary-key h-8 gap-1.5 bg-brand-muted px-3 text-[12px] text-brand-muted-fg hover:bg-brand-muted-hover"
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
		<ul {@attach listKeyboard}>
			{#each visibleIndices as index, slot (rows[index].session.id)}
				{@const gap = index - (visibleIndices[slot - 1] ?? -1) - 1}
				{#if gap > 0}<li aria-hidden="true" role="presentation" style:height={`${gap * rowHeight}px`}></li>{/if}
				{@const row = rows[index]}
				{@const session = row.session}
				{@const title = getSessionTreeTitle(row) ?? m.sidebar_new_chat({}, { locale })}
				<li data-chat-index={index} aria-posinset={index + 1} aria-setsize={rows.length}>
					<SessionRow
						{session}
						{title}
						href={hrefFor(session)}
						{density}
						active={activeSessionId === session.id}
						isMobile={isPage}
						showSourceBadge={!filter.source}
						tree={row.tree}
						tooltip={tooltipFor(row)}
						showInsert={false}
						showRename={false}
						archived={Boolean(session.isArchived)}
						onArchive={(target) => void setSessionsArchived([target.id], !target.isArchived)}
						onNavigate={open}
					>
						{#snippet avatar()}
							<SpaceAvatar name={spaceName(session)} profile={session.space?.publicProfile ?? null} seed={session.spaceId} size={LIST_ROW_AVATAR[density]} />
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
