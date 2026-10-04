<script lang="ts" module>
type Filter = "recent" | "all" | "mine" | "pinned" | "archived";

let lastFilter: Filter = "recent";
</script>

<script lang="ts">
import type { SpaceRecord } from "@neta-art/cohub";
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
import {
	getCachedSpacePage,
	setCachedSpacePage,
} from "$lib/cache/space-list-page-cache";
import { openAreaSearch } from "$lib/command-palette/open";
import FilterBar from "$lib/components/list-page/FilterBar.svelte";
import FilterChip from "$lib/components/list-page/FilterChip.svelte";
import HeaderAction from "$lib/components/list-page/HeaderAction.svelte";
import ListHeader from "$lib/components/list-page/ListHeader.svelte";
import SpaceAvatar from "$lib/components/SpaceAvatar.svelte";
import SpaceLabelPicker from "$lib/features/spaces/SpaceLabelPicker.svelte";
import { longPress } from "$lib/gestures/long-press";
import { getLocale } from "$lib/i18n/locale.svelte";
import { m } from "$lib/paraglide/messages.js";
import { sdk } from "$lib/sdk";
import { pruneSelection, selectRange, toggleSelection } from "$lib/selection";
import { buildSpaceRootRoute } from "$lib/space-routes";
import { authStore } from "$lib/stores/auth.svelte";
import { getRecentSpaces } from "$lib/stores/recent-space";
import { toggleSpaceArchive } from "$lib/stores/space-pins.svelte";

const FILTERS: readonly Filter[] = [
	"recent",
	"all",
	"mine",
	"pinned",
	"archived",
];
const PAGE_SIZE = 50;
const ROW_HEIGHT = 56;
const OVERSCAN_ROWS = 6;
const SKELETON_ROWS = [0, 1, 2, 3, 4, 5];

const locale = $derived(getLocale());
let filter = $state<Filter>(lastFilter);
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
	Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN_ROWS),
);
const end = $derived(
	Math.min(
		spaces.length,
		Math.ceil((scrollTop + viewportHeight) / ROW_HEIGHT) + OVERSCAN_ROWS,
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
		cursor = null;
		hasMore = false;
		error = "";
		const cached = await getCachedSpacePage(requestFilter, "").catch(() => null);
		if (generation !== requestGeneration) return;
		spaces = (cached?.items ?? []).filter((space) =>
			matchesFilter(space, requestFilter),
		);
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
		ROW_HEIGHT * 8
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

onMount(() => {
	void load({ reset: true });
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
		class="-ml-1 flex h-9 w-9 shrink-0 items-center justify-center rounded-[8px] text-text-tertiary transition-colors hover:bg-bg-hover hover:text-text-primary lg:h-7 lg:w-7 lg:rounded-[6px]"
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
		<FilterBar label={m.spaces_title({}, { locale })} role="tablist" activeKey={filter}>
			{#each FILTERS as value (value)}
				<FilterChip label={filterLabel(value)} active={filter === value} onclick={() => selectFilter(value)} />
			{/each}
		</FilterBar>
	</div>

	{#if error}
		<div class="flex shrink-0 items-center gap-3 border-b border-border-subtle px-3 py-2 text-[12px] text-error-fg" role="alert">
			<span class="min-w-0 flex-1 truncate">{error}</span>
			<button type="button" class="shrink-0 text-text-secondary underline underline-offset-2 hover:text-text-primary" onclick={() => void load()}>{m.spaces_retry({}, { locale })}</button>
		</div>
	{/if}

	<div bind:this={scroller} class="min-h-0 flex-1 overflow-y-auto overscroll-contain" onscroll={onScroll}>
		{#if loading && spaces.length === 0}
			<div aria-busy="true" aria-label={m.common_loading({}, { locale })}>
				{#each SKELETON_ROWS as index (index)}
					<div class="flex h-14 items-center gap-3 px-3">
						<div class="h-9 w-9 shrink-0 rounded-[10px] bg-bg-surface"></div>
						<div class="min-w-0 flex-1 space-y-1.5">
							<div class="h-3 rounded-[3px] bg-bg-surface" style:width={`${40 + ((index * 17) % 35)}%`}></div>
							<div class="h-2.5 w-1/3 rounded-[3px] bg-bg-surface/70"></div>
						</div>
					</div>
				{/each}
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
			<ul class="relative" style:height={`${spaces.length * ROW_HEIGHT}px`}>
				{#each visible as space, index (space.id)}
					{@const isSelected = selected.has(space.id)}
					{@const name = nameOf(space)}
					<li
						class="space-row group absolute inset-x-0 flex h-14 items-center gap-3 px-3 transition-colors duration-100 {isSelected ? 'bg-brand-muted' : 'hover:bg-bg-hover'}"
						style:top={`${(start + index) * ROW_HEIGHT}px`}
						use:longPress={{ onLongPress: () => toggle(space.id) }}
					>
						<button
							type="button"
							class="relative h-9 w-9 shrink-0 rounded-[10px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/35"
							aria-label={m.spaces_selected_aria({ name }, { locale })}
							aria-pressed={isSelected}
							onclick={(event) => toggle(space.id, event)}
						>
							<SpaceAvatar {name} profile={space.publicProfile} size="md" />
							<span
								class="select-mark absolute -bottom-1 -right-1 flex h-[18px] w-[18px] items-center justify-center rounded-full border-2 border-bg-primary transition-[opacity,transform] duration-150 {isSelected ? 'bg-brand text-brand-contrast-fg' : 'bg-bg-elevated text-transparent ring-1 ring-inset ring-border-primary'} {isSelected || selecting ? 'opacity-100' : 'scale-90 opacity-0 group-hover:scale-100 group-hover:opacity-100 group-focus-within:opacity-100'}"
								aria-hidden="true"
							>
								<Check class="h-2.5 w-2.5" strokeWidth={3.5} />
							</span>
						</button>
						<a
							href={buildSpaceRootRoute(space.id)}
							class="flex min-w-0 flex-1 items-center gap-2 self-stretch focus-visible:outline-none"
							onclick={(event) => handleRowClick(event, space.id)}
							draggable="false"
						>
							<span class="min-w-0 flex-1">
								<span class="flex min-w-0 items-center gap-1.5">
									<span class="truncate text-[14px] font-medium text-text-primary lg:text-[13px]">{name}</span>
									{#if space.isPinned && filter !== "pinned"}
										<Pin class="h-3 w-3 shrink-0 text-text-placeholder" aria-label={m.spaces_section_pinned({}, { locale })} />
									{/if}
								</span>
								{#if space.description?.trim()}
									<span class="block truncate text-[12px] text-text-tertiary lg:text-[11px]">{space.description}</span>
								{/if}
							</span>
						</a>
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
