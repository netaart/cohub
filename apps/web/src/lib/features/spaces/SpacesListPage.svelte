<script lang="ts" module>
import type { SpacesFilter } from "$lib/features/spaces/spaces-filter";

let lastFilter: SpacesFilter = "recent";
</script>

<script lang="ts">
import { Archive, ArchiveRestore, Pin, PinOff, Plus, Search, Tag, X } from "lucide-svelte";
import { onMount, untrack } from "svelte";
import { openAreaSearch } from "$lib/command-palette/open";
import FilterBar from "$lib/components/list-page/FilterBar.svelte";
import FilterChip from "$lib/components/list-page/FilterChip.svelte";
import HeaderAction from "$lib/components/list-page/HeaderAction.svelte";
import ListHeader from "$lib/components/list-page/ListHeader.svelte";
import SwipePager from "$lib/components/list-page/SwipePager.svelte";
import SpaceLabelPicker from "$lib/features/spaces/SpaceLabelPicker.svelte";
import SpacesListPane from "$lib/features/spaces/SpacesListPane.svelte";
import { SPACES_FILTERS } from "$lib/features/spaces/spaces-filter";
import { spacesInbox } from "$lib/features/spaces/spaces-inbox.svelte";
import { getLocale } from "$lib/i18n/locale.svelte";
import { useCompactShell } from "$lib/layout/compact-shell.svelte";
import { onListScrollTop } from "$lib/layout/list-scroll-top";
import { m } from "$lib/paraglide/messages.js";
import { sdk } from "$lib/sdk";
import { pruneSelection, selectRange, toggleSelection } from "$lib/selection";
import { toggleSpaceArchive } from "$lib/stores/space-pins.svelte";

const NO_SELECTION: ReadonlySet<string> = new Set();

const list = spacesInbox.list;
const locale = $derived(getLocale());
const compact = $derived(useCompactShell());
let filter = $state<SpacesFilter>(lastFilter);
const filterIndex = $derived(SPACES_FILTERS.indexOf(filter));
let swipePosition = $state<number | null>(null);
const position = $derived(compact ? (swipePosition ?? filterIndex) : filterIndex);
const shownIndex = $derived(Math.round(position));
const view = $derived(list.view(filter));
const spaces = $derived(view.items);
let actionError = $state("");
let selected = $state<Set<string>>(new Set());
let anchorId: string | null = null;
let busy = $state(false);
let labelAnchor = $state<HTMLElement | null>(null);
let labelPickerOpen = $state(false);
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

function neighbours() {
	return [SPACES_FILTERS[filterIndex - 1], SPACES_FILTERS[filterIndex + 1]].filter(
		(value) => value !== undefined,
	);
}

function selectFilter(value: SpacesFilter) {
	if (value === filter) {
		panes[filterIndex]?.scrollToTop();
		return;
	}
	filter = value;
	lastFilter = value;
	clearSelection();
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

async function runBatch(
	action: () => Promise<unknown>,
	flags?: { isPinned?: boolean; isArchived?: boolean },
) {
	if (!selected.size || busy) return;
	const ids = [...selected];
	busy = true;
	actionError = "";
	try {
		await action();
		if (flags) spacesInbox.applyViewerFlags(ids, flags);
		clearSelection();
	} catch (cause) {
		actionError =
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
	return runBatch(
		() =>
			sdk.user.labels.patchResources(
				ids,
				unpin
					? { removeLabelRefs: ["Pinned"] }
					: { addLabelRefs: ["Pinned"], removeLabelRefs: ["Archived"] },
			),
		unpin ? { isPinned: false } : { isPinned: true, isArchived: false },
	);
}

function archiveSelection() {
	const ids = [...selected];
	const archive = filter !== "archived";
	return runBatch(
		() => toggleSpaceArchive(ids, archive),
		archive ? { isArchived: true, isPinned: false } : { isArchived: false },
	);
}

function applyLabel(labelRef: string) {
	const ids = [...selected];
	return runBatch(() =>
		sdk.user.labels.patchResources(ids, { addLabelRefs: [labelRef] }),
	);
}

$effect(() => {
	const value = filter;
	return untrack(() => list.watch(value));
});

$effect(() => {
	if (!compact) return;
	const values = neighbours();
	untrack(() => {
		for (const value of values) void list.open(value);
	});
});

$effect(() => {
	const ids = spaces.map((space) => space.id);
	untrack(() => {
		selected = pruneSelection(selected, ids);
	});
});

onMount(() => {
	const stopScrollTop = onListScrollTop(() => panes[filterIndex]?.scrollToTop());
	const onKeydown = (event: KeyboardEvent) => {
		if (event.key !== "Escape" || event.defaultPrevented || !selecting) return;
		if (labelPickerOpen) return;
		event.preventDefault();
		clearSelection();
	};
	window.addEventListener("keydown", onKeydown);
	return () => {
		stopScrollTop();
		window.removeEventListener("keydown", onKeydown);
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

	{#if actionError || view.error}
		<div class="flex shrink-0 items-center gap-3 border-b border-border-subtle px-[var(--list-content-x)] py-2 text-[12px] text-error-fg" role="alert">
			<span class="min-w-0 flex-1 truncate">{actionError || view.error}</span>
			{#if actionError}
				<button type="button" class="shrink-0 text-text-secondary hover:text-text-primary" aria-label={m.common_close({}, { locale })} onclick={() => (actionError = "")}><X class="h-3.5 w-3.5" /></button>
			{:else}
				<button type="button" class="shrink-0 text-text-secondary underline underline-offset-2 hover:text-text-primary" onclick={() => void list.sync(filter)}>{m.spaces_retry({}, { locale })}</button>
			{/if}
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
			{@const pageView = list.view(value)}
			<SpacesListPane
				bind:this={() => panes[index], (instance) => (panes[index] = instance)}
				filter={value}
				spaces={pageView.items}
				loading={pageView.loading}
				loadingMore={pageView.loadingMore}
				error={Boolean(pageView.error)}
				{compact}
				selected={active ? selected : NO_SELECTION}
				onToggle={toggle}
				onLoadMore={active ? () => void list.loadMore(value) : undefined}
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
