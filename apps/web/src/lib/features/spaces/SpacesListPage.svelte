<script lang="ts" module>
import type { SpaceListPage, SpaceRecord } from "@neta-art/cohub";
import { SvelteMap } from "svelte/reactivity";
import type { SpacesFilter } from "$lib/features/spaces/spaces-filter";

type MemoPage = {
	items: SpaceRecord[];
	cursor: string | null;
	hasMore: boolean;
	fetchedAt: number;
};

let lastFilter: SpacesFilter = "recent";
const pageMemo = new SvelteMap<string, MemoPage>();
</script>

<script lang="ts">
import { Archive, ArchiveRestore, Pin, PinOff, Plus, Search, Tag, X } from "lucide-svelte";
import { onMount, untrack } from "svelte";
import { getCacheUserKey } from "$lib/cache/keys";
import {
	getCachedSpacePage,
	setCachedSpacePage,
} from "$lib/cache/space-list-page-cache";
import { openAreaSearch } from "$lib/command-palette/open";
import FilterBar from "$lib/components/list-page/FilterBar.svelte";
import FilterChip from "$lib/components/list-page/FilterChip.svelte";
import HeaderAction from "$lib/components/list-page/HeaderAction.svelte";
import ListHeader from "$lib/components/list-page/ListHeader.svelte";
import SwipePager from "$lib/components/list-page/SwipePager.svelte";
import SpaceLabelPicker from "$lib/features/spaces/SpaceLabelPicker.svelte";
import SpacesListPane from "$lib/features/spaces/SpacesListPane.svelte";
import {
	matchesSpacesFilter,
	SPACES_FILTERS,
} from "$lib/features/spaces/spaces-filter";
import { getLocale } from "$lib/i18n/locale.svelte";
import { useCompactShell } from "$lib/layout/compact-shell.svelte";
import { onListScrollTop } from "$lib/layout/list-scroll-top";
import { m } from "$lib/paraglide/messages.js";
import { sdk } from "$lib/sdk";
import { pruneSelection, selectRange, toggleSelection } from "$lib/selection";
import { authStore } from "$lib/stores/auth.svelte";
import { getRecentSpaces } from "$lib/stores/recent-space";
import { toggleSpaceArchive } from "$lib/stores/space-pins.svelte";

const PAGE_SIZE = 50;
const NEIGHBOUR_STALE_MS = 60_000;
const NO_SELECTION: ReadonlySet<string> = new Set();

const locale = $derived(getLocale());
const compact = $derived(useCompactShell());
let filter = $state<SpacesFilter>(lastFilter);
const filterIndex = $derived(SPACES_FILTERS.indexOf(filter));
let swipePosition = $state<number | null>(null);
const position = $derived(compact ? (swipePosition ?? filterIndex) : filterIndex);
const shownIndex = $derived(Math.round(position));
let spaces = $state<SpaceRecord[]>([]);
let cursor = $state<string | null>(null);
let hasMore = $state(false);
let loading = $state(true);
let refreshing = $state(false);
let loadingMore = $state(false);
let error = $state("");
let selected = $state<Set<string>>(new Set());
let anchorId: string | null = null;
let busy = $state(false);
let labelAnchor = $state<HTMLElement | null>(null);
let labelPickerOpen = $state(false);
let requestGeneration = 0;
let staleBefore = 0;
type FirstPage = { page: SpaceListPage; startedAt: number };
const inflight = new Map<string, { request: Promise<FirstPage>; startedAt: number }>();
const panes: (SpacesListPane | undefined)[] = [];

const selecting = $derived(selected.size > 0);
const allSelectedPinned = $derived(
	selecting && spaces.every((space) => !selected.has(space.id) || space.isPinned),
);

function filterLabel(value: SpacesFilter) {
	switch (value) {
		case "recent":
			return m.spaces_section_recent({}, { locale });
		case "all":
			return m.spaces_section_all({}, { locale });
		case "mine":
			return m.command_mine({}, { locale });
		case "pinned":
			return m.spaces_section_pinned({}, { locale });
		case "archived":
			return m.spaces_archived({}, { locale });
	}
}

function memoKey(value: SpacesFilter) {
	return `${getCacheUserKey()}:${value}`;
}

function remember(value: SpacesFilter, page: MemoPage) {
	pageMemo.set(memoKey(value), page);
}

function isFresh(page: MemoPage | undefined) {
	return Boolean(
		page &&
			page.fetchedAt > staleBefore &&
			Date.now() - page.fetchedAt < NEIGHBOUR_STALE_MS,
	);
}

function recentSpaces() {
	return getRecentSpaces(authStore.userUuid ?? "").map((entry) => ({
		id: entry.spaceId,
		timestamp: entry.timestamp,
	}));
}

// Only prewarm and landing share a request, and never one sent before the last invalidation.
function fetchFirstPage(value: SpacesFilter, reuse = false): Promise<FirstPage> {
	const key = memoKey(value);
	const pending = inflight.get(key);
	if (reuse && pending && pending.startedAt > staleBefore) return pending.request;
	const startedAt = Date.now();
	const request = sdk.spaces
		.list({
			limit: PAGE_SIZE,
			cursor: null,
			filter: value,
			query: "",
			recentSpaces: recentSpaces(),
		})
		.then((page) => {
			void setCachedSpacePage(value, "", page).catch(() => undefined);
			return { page, startedAt };
		})
		.finally(() => {
			if (inflight.get(key)?.request === request) inflight.delete(key);
		});
	inflight.set(key, { request, startedAt });
	return request;
}

async function readCachedPage(value: SpacesFilter): Promise<MemoPage | null> {
	const cached = await getCachedSpacePage(value, "").catch(() => null);
	if (!cached) return null;
	return {
		items: cached.items.filter((space) => matchesSpacesFilter(space, value)),
		cursor: null,
		hasMore: false,
		fetchedAt: 0,
	};
}

async function prewarm(values: SpacesFilter[]) {
	await Promise.all(
		values.map(async (value) => {
			const key = memoKey(value);
			if (!pageMemo.has(key)) {
				const cached = await readCachedPage(value);
				if (cached && !pageMemo.has(key)) pageMemo.set(key, cached);
			}
			if (isFresh(pageMemo.get(key)) || value === filter) return;
			try {
				const { page, startedAt } = await fetchFirstPage(value, true);
				if (value === filter || key !== memoKey(value)) return;
				remember(value, {
					items: page.items,
					cursor: page.pageInfo.nextCursor,
					hasMore: page.pageInfo.hasMore,
					fetchedAt: startedAt,
				});
			} catch {}
		}),
	);
}

function neighbours() {
	return [SPACES_FILTERS[filterIndex - 1], SPACES_FILTERS[filterIndex + 1]].filter(
		(value) => value !== undefined,
	);
}

async function load(options: { reset?: boolean } = {}) {
	const generation = ++requestGeneration;
	const requestFilter = filter;
	loadingMore = false;
	if (options.reset) {
		error = "";
		const memo = pageMemo.get(memoKey(requestFilter));
		spaces = memo?.items ?? [];
		cursor = memo?.cursor ?? null;
		hasMore = memo?.hasMore ?? false;
		loading = spaces.length === 0;
		if (!memo) {
			const cached = await readCachedPage(requestFilter);
			if (generation !== requestGeneration) return;
			if (cached) {
				remember(requestFilter, cached);
				spaces = cached.items;
			}
		}
		loading = spaces.length === 0;
	}
	refreshing = spaces.length > 0;
	try {
		const { page, startedAt } = await fetchFirstPage(
			requestFilter,
			options.reset,
		);
		if (generation !== requestGeneration) return;
		spaces = page.items;
		cursor = page.pageInfo.nextCursor;
		hasMore = page.pageInfo.hasMore;
		remember(requestFilter, { items: spaces, cursor, hasMore, fetchedAt: startedAt });
		error = "";
		selected = pruneSelection(selected, spaces.map((space) => space.id));
	} catch (cause) {
		if (generation !== requestGeneration) return;
		error =
			cause instanceof Error
				? cause.message
				: m.spaces_load_failed({}, { locale });
	} finally {
		if (generation === requestGeneration) {
			loading = false;
			refreshing = false;
		}
	}
}

async function loadMore() {
	if (loading || refreshing || loadingMore || !hasMore || !cursor) return;
	const generation = requestGeneration;
	loadingMore = true;
	try {
		const page = await sdk.spaces.list({
			limit: PAGE_SIZE,
			cursor,
			filter,
			query: "",
			recentSpaces: recentSpaces(),
		});
		if (generation !== requestGeneration) return;
		const known = new Set(spaces.map((space) => space.id));
		spaces = [...spaces, ...page.items.filter((space) => !known.has(space.id))];
		cursor = page.pageInfo.nextCursor;
		hasMore = page.pageInfo.hasMore;
	} catch (cause) {
		if (generation !== requestGeneration) return;
		error =
			cause instanceof Error
				? cause.message
				: m.spaces_load_failed({}, { locale });
	} finally {
		if (generation === requestGeneration) loadingMore = false;
	}
}

function reloadAll() {
	staleBefore = Date.now();
	void load();
	if (compact) void prewarm(neighbours());
}

function selectFilter(value: SpacesFilter) {
	if (value === filter) {
		panes[filterIndex]?.scrollToTop();
		return;
	}
	filter = value;
	lastFilter = value;
	clearSelection();
	void load({ reset: true });
}

function clearSelection() {
	selected = new Set();
	anchorId = null;
	labelPickerOpen = false;
}

function toggle(id: string, event?: MouseEvent) {
	selected = event?.shiftKey
		? selectRange(selected, spaces.map((space) => space.id), anchorId, id)
		: toggleSelection(selected, id);
	anchorId = id;
}

async function runBatch(action: () => Promise<unknown>) {
	if (!selected.size || busy) return;
	busy = true;
	try {
		await action();
		clearSelection();
		reloadAll();
	} catch (cause) {
		error =
			cause instanceof Error
				? cause.message
				: m.spaces_update_failed({}, { locale });
	} finally {
		busy = false;
	}
}

function pinSelection() {
	const ids = [...selected];
	const unpin = allSelectedPinned;
	return runBatch(() =>
		sdk.user.labels.patchResources(
			ids,
			unpin
				? { removeLabelRefs: ["Pinned"] }
				: { addLabelRefs: ["Pinned"], removeLabelRefs: ["Archived"] },
		),
	);
}

function archiveSelection() {
	const ids = [...selected];
	return runBatch(() => toggleSpaceArchive(ids, filter !== "archived"));
}

function applyLabel(labelRef: string) {
	const ids = [...selected];
	return runBatch(() =>
		sdk.user.labels.patchResources(ids, { addLabelRefs: [labelRef] }),
	);
}

$effect(() => {
	if (!compact) return;
	const values = neighbours();
	untrack(() => void prewarm(values));
});

onMount(() => {
	void load({ reset: true });
	const stopScrollTop = onListScrollTop(() => panes[filterIndex]?.scrollToTop());
	const refreshOnReturn = () => {
		if (document.visibilityState === "visible") void load();
	};
	const onKeydown = (event: KeyboardEvent) => {
		if (event.key !== "Escape" || event.defaultPrevented || !selecting) return;
		if (labelPickerOpen) return;
		event.preventDefault();
		clearSelection();
	};
	window.addEventListener("focus", refreshOnReturn);
	window.addEventListener("keydown", onKeydown);
	document.addEventListener("visibilitychange", refreshOnReturn);
	const unsubscribeRealtime = sdk.onUserEvent((event) => {
		if (
			event.type === "space.list.changed" ||
			(event.type === "label.assignments.updated" &&
				event.payload.resourceType === "space")
		)
			reloadAll();
	});
	return () => {
		stopScrollTop();
		unsubscribeRealtime();
		window.removeEventListener("focus", refreshOnReturn);
		window.removeEventListener("keydown", onKeydown);
		document.removeEventListener("visibilitychange", refreshOnReturn);
	};
});
</script>

{#snippet selectionTitle()}
	<button
		type="button"
		class="-ml-[9px] flex h-9 w-9 shrink-0 items-center justify-center rounded-[8px] text-text-tertiary transition-colors hover:bg-bg-hover hover:text-text-primary lg:-ml-1.5 lg:h-7 lg:w-7 lg:rounded-[6px]"
		aria-label={m.common_cancel({}, { locale })}
		title={m.common_cancel({}, { locale })}
		onclick={clearSelection}
	>
		<X class="h-[18px] w-[18px] lg:h-4 lg:w-4" />
	</button>
	<span class="truncate text-[15px] font-semibold tabular-nums text-text-primary lg:text-[13px]" aria-live="polite">
		{m.label_selected_count({ count: selected.size }, { locale })}
	</span>
{/snippet}

<section class="flex h-full min-h-0 flex-1 flex-col overflow-hidden bg-bg-primary">
	<div class="shrink-0 border-b border-border-subtle">
		<ListHeader
			title={m.spaces_title({}, { locale })}
			busy={refreshing}
			brand={!selecting}
			children={selecting ? selectionTitle : undefined}
		>
			{#snippet actions()}
				{#if selecting}
					<HeaderAction
						label={allSelectedPinned ? m.command_unpin({}, { locale }) : m.command_pin({}, { locale })}
						icon={allSelectedPinned ? PinOff : Pin}
						disabled={busy}
						onclick={() => void pinSelection()}
					/>
					<HeaderAction
						label={filter === "archived" ? m.spaces_unarchive({}, { locale }) : m.spaces_archive({}, { locale })}
						icon={filter === "archived" ? ArchiveRestore : Archive}
						disabled={busy}
						onclick={() => void archiveSelection()}
					/>
					<HeaderAction
						bind:ref={labelAnchor}
						label={m.spaces_label_add({}, { locale })}
						icon={Tag}
						disabled={busy}
						onclick={() => {
							labelPickerOpen = !labelPickerOpen;
						}}
					/>
				{:else}
					<HeaderAction label={m.list_search({}, { locale })} icon={Search} shortcut="⌘K" onclick={() => openAreaSearch("spaces")} />
					<HeaderAction label={m.spaces_new({}, { locale })} icon={Plus} tone="brand" href="/spaces/new" />
				{/if}
			{/snippet}
		</ListHeader>
		<FilterBar
			label={m.spaces_title({}, { locale })}
			role="tablist"
			activeKey={SPACES_FILTERS[shownIndex] ?? null}
			{position}
		>
			{#each SPACES_FILTERS as value, index (value)}
				<FilterChip label={filterLabel(value)} active={shownIndex === index} onclick={() => selectFilter(value)} />
			{/each}
		</FilterBar>
	</div>

	{#if error}
		<div class="flex shrink-0 items-center gap-3 border-b border-border-subtle px-[var(--list-content-x)] py-2 text-[12px] text-error-fg" role="alert">
			<span class="min-w-0 flex-1 truncate">{error}</span>
			<button type="button" class="shrink-0 text-text-secondary underline underline-offset-2 hover:text-text-primary" onclick={() => void load()}>{m.spaces_retry({}, { locale })}</button>
		</div>
	{/if}

	<SwipePager
		keys={SPACES_FILTERS}
		index={filterIndex}
		enabled={compact}
		locked={selecting}
		onChange={(index) => selectFilter(SPACES_FILTERS[index] ?? filter)}
		onPosition={(next) => (swipePosition = next)}
	>
		{#snippet page(index, active)}
			{@const value = SPACES_FILTERS[index] ?? filter}
			{@const memo = active ? null : pageMemo.get(memoKey(value))}
			<SpacesListPane
				bind:this={() => panes[index], (instance) => (panes[index] = instance)}
				filter={value}
				spaces={active ? spaces : (memo?.items ?? [])}
				loading={active ? loading : !memo}
				loadingMore={active && loadingMore}
				error={active && Boolean(error)}
				{compact}
				selected={active ? selected : NO_SELECTION}
				onToggle={toggle}
				onLoadMore={active ? () => void loadMore() : undefined}
			/>
		{/snippet}
	</SwipePager>
</section>

<SpaceLabelPicker
	open={labelPickerOpen && selecting}
	anchor={labelAnchor}
	count={selected.size}
	onApply={applyLabel}
	onClose={() => {
		labelPickerOpen = false;
	}}
/>
