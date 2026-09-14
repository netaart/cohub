<script lang="ts">
import type {
	UserSessionListItem,
	UserSessionSourceKey,
} from "@neta-art/cohub";
import { Loader2, Search } from "lucide-svelte";
import SessionSidebarRowContent from "$lib/components/SessionSidebarRowContent.svelte";
import SpaceAvatar from "$lib/components/SpaceAvatar.svelte";
import { getSessionTitle } from "$lib/features/session-chat";
import SessionsSourceFilter from "$lib/features/sessions/SessionsSourceFilter.svelte";
import { getLocale } from "$lib/i18n/locale.svelte";
import type { ModelCatalogItem } from "$lib/model-catalog";
import { m } from "$lib/paraglide/messages.js";
import {
	buildSpaceSessionRoute,
	buildUserSessionRoute,
} from "$lib/space-routes";
import { uiState } from "$lib/stores/ui.svelte";

function openCommandPalette() {
	window.dispatchEvent(new CustomEvent("cohub:open-command-palette"));
}

const {
	sessions,
	activeSessionId = null,
	loading = false,
	loadingMore = false,
	refreshing = false,
	error = null,
	hasMore = false,
	isDesktop = true,
	modelsCatalog = null,
	sourceFilter = [],
	sourceCounts = [],
	onSourceFilterChange,
	onSelect,
	onLoadMore,
	onNewChat,
}: {
	sessions: UserSessionListItem[];
	activeSessionId?: string | null;
	loading?: boolean;
	loadingMore?: boolean;
	refreshing?: boolean;
	error?: string | null;
	hasMore?: boolean;
	isDesktop?: boolean;
	modelsCatalog?: ModelCatalogItem[] | null;
	sourceFilter?: readonly UserSessionSourceKey[];
	sourceCounts?: Array<{ key: string; count: number }>;
	onSourceFilterChange?: (filter: UserSessionSourceKey[]) => void;
	onSelect: (session: UserSessionListItem) => void;
	onLoadMore: () => void;
	onNewChat: () => void;
} = $props();

const locale = $derived(getLocale());

function hrefFor(session: UserSessionListItem) {
	return isDesktop
		? buildUserSessionRoute(session.id)
		: buildSpaceSessionRoute(session.spaceId, session.id);
}

function spaceName(session: UserSessionListItem) {
	return session.space?.name?.trim() || "Space";
}
</script>

<section class="flex h-full min-h-0 flex-col bg-[var(--sidebar-bg)]">
	<header class="flex h-11 shrink-0 items-center gap-2 border-b border-border-subtle px-3">
		<div class="flex min-w-0 flex-1 items-center gap-2">
			{#if !isDesktop}
				<button
					type="button"
					class="group flex min-w-0 items-center gap-2"
					onclick={() => {
						uiState.mobileDrawerOpen = !uiState.mobileDrawerOpen;
					}}
					aria-label={m.sessions_open_nav({}, { locale })}
				>
					<span class="flex h-7 w-7 shrink-0 items-center justify-center rounded-[6px] bg-brand text-[11px] font-bold text-brand-contrast-fg transition-colors group-hover:bg-brand-hover">
						C
					</span>
					<span class="truncate text-[13px] font-semibold tracking-tight text-text-primary">Cohub</span>
				</button>
			{:else}
				<h1 class="text-[13px] font-semibold tracking-tight text-text-primary">Chats</h1>
			{/if}
			{#if refreshing}
				<Loader2 class="h-3 w-3 shrink-0 animate-spin text-text-placeholder" />
			{/if}
		</div>
		<div class="flex shrink-0 items-center gap-1">
			{#if !isDesktop}
				<button
					type="button"
					class="group/search flex h-7 shrink-0 items-center justify-center rounded-[6px] bg-bg-surface px-2 text-text-tertiary transition-colors duration-100 hover:bg-bg-hover hover:text-text-secondary"
					onclick={openCommandPalette}
					title={m.sessions_search_everywhere({}, { locale })}
					aria-label="Search everywhere"
				>
					<Search class="h-3.5 w-3.5 text-text-placeholder transition-colors group-hover/search:text-brand" />
				</button>
			{/if}
			{#if onSourceFilterChange}
				<SessionsSourceFilter
					selected={sourceFilter}
					counts={sourceCounts}
					onChange={onSourceFilterChange}
				/>
			{/if}
			<button
				type="button"
				class="inline-flex h-7 items-center rounded-[6px] border border-[color:var(--sidebar-primary-action-border)] bg-[var(--sidebar-primary-action-bg)] px-2.5 text-[12px] font-medium text-[var(--sidebar-primary-action-fg)] transition-colors hover:bg-[var(--sidebar-primary-action-bg-hover)]"
				onclick={onNewChat}
			>
				New
			</button>
		</div>
	</header>

	<div class="min-h-0 flex-1 overflow-y-auto px-1.5 py-2">
		{#if loading && sessions.length === 0}
			<div class="flex items-center gap-2 px-2 py-3 text-[12px] text-text-tertiary">
				<Loader2 class="h-3.5 w-3.5 animate-spin" />
				Loading chats…
			</div>
		{:else if error && sessions.length === 0}
			<div class="px-2 py-3 text-[12px] text-error-soft">{error}</div>
		{:else if sessions.length === 0 && sourceFilter.length > 0 && onSourceFilterChange}
			<div class="px-2 py-8 text-center">
				<p class="text-[13px] text-text-secondary">No chats from this origin</p>
				<p class="mt-1 text-[12px] text-text-placeholder">The filter hides chats from other origins.</p>
				<div class="mt-4 flex items-center justify-center gap-2">
					<button
						type="button"
						class="sessions-empty-new-chat inline-flex items-center rounded-[6px] bg-bg-hover px-3 py-1.5 text-[12px] text-text-secondary transition-colors hover:bg-bg-hover-strong hover:text-text-primary"
						onclick={onNewChat}
					>
						New chat
					</button>
					<button
						type="button"
						class="inline-flex items-center rounded-[6px] px-3 py-1.5 text-[12px] text-text-tertiary transition-colors hover:bg-bg-hover hover:text-text-secondary"
						onclick={() => onSourceFilterChange([])}
					>
						Show any origin
					</button>
				</div>
			</div>
		{:else if sessions.length === 0}
			<div class="px-2 py-8 text-center">
				<p class="text-[13px] text-text-secondary">{m.sessions_no_chats({}, { locale })}</p>
				<p class="mt-1 text-[12px] text-text-placeholder">{m.sessions_no_chats_hint({}, { locale })}</p>
				<button
					type="button"
					class="sessions-empty-new-chat mt-4 inline-flex items-center rounded-[6px] bg-bg-hover px-3 py-1.5 text-[12px] text-text-secondary transition-colors hover:bg-bg-hover-strong hover:text-text-primary"
					onclick={onNewChat}
				>
					New chat
				</button>
			</div>
		{:else}
			<div class="space-y-[2px]">
				{#each sessions as session (session.id)}
					{@const active = activeSessionId === session.id}
					<a
						href={hrefFor(session)}
						class="group/session relative flex items-start gap-2 overflow-hidden rounded-[var(--sidebar-item-radius)] px-2 py-1.5 pr-3 text-[13px] transition-colors duration-100 {active ? 'bg-[var(--sidebar-item-active-bg)] font-medium text-[var(--sidebar-item-active-fg)]' : 'text-text-tertiary hover:bg-[var(--sidebar-item-hover-bg)] hover:text-text-secondary'}"
						onclick={(event) => {
							event.preventDefault();
							onSelect(session);
						}}
					>
						<div class="mt-0.5 shrink-0">
							<SpaceAvatar
								name={spaceName(session)}
								profile={session.space?.publicProfile ?? null}
								size="sm"
							/>
						</div>
						<div class="min-w-0 flex-1">
							<div class="mb-0.5 truncate text-[10px] font-normal text-text-placeholder">
								{spaceName(session)}
							</div>
							<SessionSidebarRowContent
								{session}
								title={getSessionTitle(session)}
								isMobile={!isDesktop}
								modelsCatalog={modelsCatalog ?? undefined}
								showSourceBadge={true}
							/>
						</div>
					</a>
				{/each}
			</div>
			{#if hasMore}
				<button
					type="button"
					class="mt-2 flex w-full items-center justify-center gap-2 rounded-[6px] px-2 py-1.5 text-[12px] text-text-tertiary transition-colors hover:bg-bg-hover hover:text-text-secondary disabled:opacity-60"
					disabled={loadingMore}
					onclick={onLoadMore}
				>
					{#if loadingMore}
						<Loader2 class="h-3 w-3 animate-spin" />
						Loading…
					{:else}
						Load more
					{/if}
				</button>
			{/if}
		{/if}
	</div>
</section>

<style>
	:global([data-theme="neta-studio"]) .sessions-empty-new-chat {
		border: 1px solid var(--sidebar-primary-action-border);
		border-radius: var(--sidebar-primary-action-radius);
		background: var(--sidebar-primary-action-bg);
		color: var(--sidebar-primary-action-fg);
		font-weight: 500;
	}

	:global([data-theme="neta-studio"]) .sessions-empty-new-chat:hover {
		background: var(--sidebar-primary-action-bg-hover);
		color: var(--sidebar-primary-action-fg);
	}
</style>
