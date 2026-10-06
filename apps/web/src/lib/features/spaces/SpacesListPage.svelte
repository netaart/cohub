<script lang="ts" module>
import type { SpaceRecord } from "@neta-art/cohub";

type Filter = "recent" | "all" | "mine" | "pinned" | "archived";
type MemoPage = {
	items: SpaceRecord[];
	cursor: string | null;
	hasMore: boolean;
};

let lastFilter: Filter = "recent";
const pageMemo = new Map<string, MemoPage>();
</script>

<script lang="ts">
import {
	Archive,
	ArchiveRestore,
	Check,
	Pin,
	PinOff,
	Plus,
	Search,
	Tag,
	X,
} from "lucide-svelte";
import { onMount } from "svelte";
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
import ListRow from "$lib/components/list-page/ListRow.svelte";
import ListRowSkeleton from "$lib/components/list-page/ListRowSkeleton.svelte";
import ListRowText from "$lib/components/list-page/ListRowText.svelte";
import {
	LIST_ROW_AVATAR,
	LIST_ROW_HEIGHT,
	type ListRowDensity,
} from "$lib/components/list-page/list-row";
import SpaceAvatar from "$lib/components/SpaceAvatar.svelte";
import SpaceLabelPicker from "$lib/features/spaces/SpaceLabelPicker.svelte";
import { longPress } from "$lib/gestures/long-press";
import { swipePager } from "$lib/gestures/swipe-pager";
import { getLocale } from "$lib/i18n/locale.svelte";
import { useCompactShell } from "$lib/layout/compact-shell.svelte";
import { onListScrollTop, scrollListToTop } from "$lib/layout/list-scroll-top";
import { m } from "$lib/paraglide/messages.js";
import { sdk } from "$lib/sdk";
import { pruneSelection, selectRange, toggleSelection } from "$lib/selection";
import { buildSpaceRootRoute } from "$lib/space-routes";
import { authStore } from "$lib/stores/auth.svelte";
import { getRecentSpaces } from "$lib/stores/recent-space";
import { toggleSpaceArchive } from "$lib/stores/space-pins.svelte";
import { formatCompactAbsoluteTime } from "$lib/time-format";

const FILTERS: readonly Filter[] = [
	"recent",
	"all",
	"mine",
	"pinned",
	"archived",
];
const PAGE_SIZE = 50;
const OVERSCAN_ROWS = 6;

const locale = $derived(getLocale());
const compact = $derived(useCompactShell());
const density = $derived<ListRowDensity>(compact ? "comfortable" : "compact");
const rowHeight = $derived(LIST_ROW_HEIGHT[density]);
let filter = $state<Filter>(lastFilter);
const filterIndex = $derived(FILTERS.indexOf(filter));
let spaces = $state<SpaceRecord[]>([]);
let cursor = $state<string | null>(null);
let hasMore = $state(false);
let loading = $state(true);
let refreshing = $state(false);
let loadingMore = $state(false);
let error = $state("");
let scroller = $state<HTMLDivElement | null>(null);
let scrollTop = $state(0);
let viewportHeight = $state(600);
let selected = $state<Set<string>>(new Set());
let anchorId: string | null = null;
let busy = $state(false);
let labelAnchor = $state<HTMLElement | null>(null);
let labelPickerOpen = $state(false);
let requestGeneration = 0;

const selecting = $derived(selected.size > 0);
const allSelectedPinned = $derived(
	selecting && spaces.every((space) => !selected.has(space.id) || space.isPinned),
);
const start = $derived(
	Math.max(0, Math.floor(scrollTop / rowHeight) - OVERSCAN_ROWS),
);
const end = $derived(
	Math.min(
		spaces.length,
		Math.ceil((scrollTop + viewportHeight) / rowHeight) + OVERSCAN_ROWS,
	),
);
const visible = $derived(spaces.slice(start, end));

function filterLabel(value: Filter) {
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

function emptyCopy(value: Filter) {
	switch (value) {
		case "mine":
			return { title: m.spaces_empty_mine({}, { locale }), hint: m.spaces_empty_hint({}, { locale }) };
		case "pinned":
			return { title: m.spaces_empty_pinned({}, { locale }), hint: m.spaces_empty_pinned_hint({}, { locale }) };
		case "archived":
			return { title: m.spaces_empty_archived({}, { locale }), hint: m.spaces_empty_archived_hint({}, { locale }) };
		default:
			return { title: m.spaces_empty_title({}, { locale }), hint: m.spaces_empty_hint({}, { locale }) };
	}
}

function subtitleOf(space: SpaceRecord) {
	const description = space.description?.trim();
	if (description) return { text: description, quiet: false };
	const owner = space.ownerProfile;
	if (space.relation && space.relation !== "owner" && owner) {
		const handle = owner.username?.trim();
		return {
			text: handle ? `@${handle}` : owner.displayName?.trim() || "",
			quiet: true,
		};
	}
	return { text: m.spaces_row_no_description({}, { locale }), quiet: true };
}

function memoKey(value: Filter) {
	return `${getCacheUserKey()}:${value}`;
}

function remember(value: Filter, page: MemoPage) {
	pageMemo.set(memoKey(value), page);
}

async function prewarm(values: Filter[]) {
	for (const value of values) {
		if (pageMemo.has(memoKey(value))) continue;
		const cached = await getCachedSpacePage(value, "").catch(() => null);
		if (!cached || pageMemo.has(memoKey(value))) continue;
		remember(value, {
			items: cached.items.filter((space) => matchesFilter(space, value)),
			cursor: null,
			hasMore: false,
		});
	}
}

function nameOf(space: SpaceRecord) {
	return (
		space.name?.trim() ||
		space.title?.trim() ||
		m.spaces_default_name({}, { locale })
	);
}

function recentSpaces() {
	return getRecentSpaces(authStore.userUuid ?? "").map((entry) => ({
		id: entry.spaceId,
		timestamp: entry.timestamp,
	}));
}

function matchesFilter(space: SpaceRecord, value: Filter) {
	return value === "archived" ? Boolean(space.isArchived) : !space.isArchived;
}

async function load(options: { reset?: boolean } = {}) {
	const generation = ++requestGeneration;
	const requestFilter = filter;
	loadingMore = false;
	if (options.reset) {
		error = "";
		const memo = pageMemo.get(memoKey(requestFilter));
		if (memo) {
			spaces = memo.items;
			cursor = memo.cursor;
			hasMore = memo.hasMore;
		} else {
			cursor = null;
			hasMore = false;
			const cached = await getCachedSpacePage(requestFilter, "").catch(
				() => null,
			);
			if (generation !== requestGeneration) return;
			spaces = (cached?.items ?? []).filter((space) =>
				matchesFilter(space, requestFilter),
			);
		}
		loading = spaces.length === 0;
	}
	refreshing = spaces.length > 0;
	try {
		const page = await sdk.spaces.list({
			limit: PAGE_SIZE,
			cursor: null,
			filter: requestFilter,
			query: "",
			recentSpaces: recentSpaces(),
		});
		if (generation !== requestGeneration) return;
		spaces = page.items;
		cursor = page.pageInfo.nextCursor;
		hasMore = page.pageInfo.hasMore;
		remember(requestFilter, { items: spaces, cursor, hasMore });
		error = "";
		selected = pruneSelection(selected, spaces.map((space) => space.id));
		void setCachedSpacePage(requestFilter, "", page).catch(() => undefined);
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

function selectFilter(value: Filter) {
	if (value === filter) {
		scroller?.scrollTo({ top: 0, behavior: "smooth" });
		return;
	}
	filter = value;
	lastFilter = value;
	clearSelection();
	scroller?.scrollTo({ top: 0 });
	scrollTop = 0;
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

function handleRowClick(event: MouseEvent, id: string) {
	if (!selecting) return;
	event.preventDefault();
	toggle(id, event);
}

function onScroll(event: Event) {
	const element = event.currentTarget as HTMLElement;
	scrollTop = element.scrollTop;
	viewportHeight = element.clientHeight;
	if (
		element.scrollHeight - element.scrollTop - element.clientHeight <
		rowHeight * 8
	)
		void loadMore();
}

async function runBatch(action: () => Promise<unknown>) {
	if (!selected.size || busy) return;
	busy = true;
	try {
		await action();
		clearSelection();
		await load();
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
	const neighbours = [FILTERS[filterIndex - 1], FILTERS[filterIndex + 1]];
	void prewarm(neighbours.filter((value) => value !== undefined));
});

onMount(() => {
	void load({ reset: true });
	const stopScrollTop = onListScrollTop(() => scrollListToTop(scroller));
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
			void load();
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

{#snippet avatar(space: SpaceRecord, name: string, isSelected: boolean)}
	<SpaceAvatar {name} profile={space.publicProfile} size={LIST_ROW_AVATAR[density]} />
	<span
		class="absolute -bottom-1 -right-1 flex h-[18px] w-[18px] items-center justify-center rounded-full border-2 border-bg-primary transition-[opacity,transform] duration-150 {isSelected ? 'bg-brand text-brand-contrast-fg' : 'bg-bg-elevated text-transparent ring-1 ring-inset ring-border-primary'} {isSelected || selecting ? 'opacity-100' : compact ? 'scale-90 opacity-0' : 'scale-90 opacity-0 group-hover/row:scale-100 group-hover/row:opacity-100 group-focus-within/row:opacity-100'}"
		aria-hidden="true"
	>
		<Check class="h-2.5 w-2.5" strokeWidth={3.5} />
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
		<FilterBar label={m.spaces_title({}, { locale })} role="tablist" activeKey={filter}>
			{#each FILTERS as value (value)}
				<FilterChip label={filterLabel(value)} active={filter === value} onclick={() => selectFilter(value)} />
			{/each}
		</FilterBar>
	</div>

	{#if error}
		<div class="flex shrink-0 items-center gap-3 border-b border-border-subtle px-[var(--list-content-x)] py-2 text-[12px] text-error-fg" role="alert">
			<span class="min-w-0 flex-1 truncate">{error}</span>
			<button type="button" class="shrink-0 text-text-secondary underline underline-offset-2 hover:text-text-primary" onclick={() => void load()}>{m.spaces_retry({}, { locale })}</button>
		</div>
	{/if}

	<div
		bind:this={scroller}
		class="min-h-0 flex-1 overflow-y-auto overscroll-contain py-1.5"
		data-drawer-swipe-ignore={compact ? "" : undefined}
		onscroll={onScroll}
		use:swipePager={{
			index: filterIndex,
			count: FILTERS.length,
			enabled: compact && !selecting,
			onChange: (index) => selectFilter(FILTERS[index] ?? filter),
		}}
	>
		{#if loading && spaces.length === 0}
			<div class="px-[var(--list-gutter-x)]">
				<ListRowSkeleton {density} rows={6} label={m.common_loading({}, { locale })} />
			</div>
		{:else if spaces.length === 0 && !error}
			{@const copy = emptyCopy(filter)}
			<div class="flex flex-col items-center px-6 py-14 text-center">
				<p class="text-[13px] font-medium text-text-secondary">{copy.title}</p>
				<p class="mt-1 max-w-[280px] text-[12px] text-text-tertiary">{copy.hint}</p>
				{#if filter === "recent" || filter === "all" || filter === "mine"}
					<a href="/spaces/new" class="mt-4 inline-flex h-8 items-center gap-1.5 rounded-[6px] bg-brand-muted px-3 text-[12px] font-medium text-brand-muted-fg transition-colors hover:bg-brand-muted-hover">
						<Plus class="h-3.5 w-3.5" />{m.spaces_new({}, { locale })}
					</a>
				{/if}
			</div>
		{:else}
			<ul class="relative mx-[var(--list-gutter-x)]" style:height={`${spaces.length * rowHeight}px`}>
				{#each visible as space, index (space.id)}
					{@const isSelected = selected.has(space.id)}
					{@const name = nameOf(space)}
					{@const href = buildSpaceRootRoute(space.id)}
					{@const second = subtitleOf(space)}
					<li
						class="space-row absolute inset-x-0"
						style:top={`${(start + index) * rowHeight}px`}
						use:longPress={{ onLongPress: () => toggle(space.id) }}
					>
						<ListRow
							{density}
							selected={isSelected}
							class="has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-inset has-[:focus-visible]:ring-brand/35"
						>
							{#snippet leading()}
								{#if compact}
									<a {href} class="relative block focus-visible:outline-none" tabindex="-1" aria-hidden="true" draggable="false" onclick={(event) => handleRowClick(event, space.id)}>
										{@render avatar(space, name, isSelected)}
									</a>
								{:else}
									<button
										type="button"
										class="relative block rounded-[10px] focus-visible:outline-none"
										aria-label={m.spaces_selected_aria({ name }, { locale })}
										aria-pressed={isSelected}
										onclick={(event) => toggle(space.id, event)}
									>
										{@render avatar(space, name, isSelected)}
									</button>
								{/if}
							{/snippet}
							<a
								{href}
								class="flex min-w-0 flex-1 self-stretch focus-visible:outline-none"
								onclick={(event) => handleRowClick(event, space.id)}
								draggable="false"
							>
								<ListRowText title={name}>
									{#snippet meta()}
										{#if space.isPinned && filter !== "pinned"}
											<Pin class="h-3 w-3" aria-label={m.spaces_section_pinned({}, { locale })} />
										{/if}
										{#if space.lastActivityAt}
											<span>{formatCompactAbsoluteTime(space.lastActivityAt)}</span>
										{/if}
									{/snippet}
									{#snippet subtitle()}
										<span class={second.quiet ? "text-text-placeholder" : ""} title={second.quiet ? undefined : second.text}>{second.text}</span>
									{/snippet}
								</ListRowText>
							</a>
						</ListRow>
					</li>
				{/each}
			</ul>
			{#if loadingMore}
				<div class="flex h-12 items-center justify-center text-[12px] text-text-placeholder">{m.common_loading({}, { locale })}</div>
			{/if}
		{/if}
	</div>
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

<style>
	.space-row {
		-webkit-touch-callout: none;
		-webkit-user-select: none;
		user-select: none;
	}
</style>
