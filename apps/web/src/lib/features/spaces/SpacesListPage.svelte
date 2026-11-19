<script lang="ts">
import type { SpaceRecord } from "@neta-art/cohub";
import {
	Archive,
	ArchiveRestore,
	CircleCheck,
	Pin,
	PinOff,
	Plus,
	Search,
	Settings,
	Tag,
	Wallet,
	X,
} from "lucide-svelte";
import { onMount, untrack } from "svelte";
import { openAreaSearch } from "#lib/command-palette/open.ts";
import FilterBar from "#lib/components/list-page/FilterBar.svelte";
import FilterChip from "#lib/components/list-page/FilterChip.svelte";
import HeaderAction from "#lib/components/list-page/HeaderAction.svelte";
import ListHeader from "#lib/components/list-page/ListHeader.svelte";
import SwipePager from "#lib/components/list-page/SwipePager.svelte";
import { SwipeTabs } from "#lib/components/list-page/swipe-tabs.svelte.ts";
import type { ContextMenuContent } from "#lib/context-menu/context-menu.svelte.ts";
import { linkEntries, MENU_SEPARATOR } from "#lib/context-menu/menu.ts";
import LibraryTabs from "#lib/features/library/LibraryTabs.svelte";
import SpaceLabelPicker from "#lib/features/spaces/SpaceLabelPicker.svelte";
import SpacesListPane from "#lib/features/spaces/SpacesListPane.svelte";
import {
	SPACES_FILTERS,
	type SpacesFilter,
} from "#lib/features/spaces/spaces-filter.ts";
import { spacesInbox } from "#lib/features/spaces/spaces-inbox.svelte.ts";
import { spacesFilterLabel } from "#lib/features/spaces/spaces-views.ts";
import { getLocale } from "#lib/i18n/locale.svelte.ts";
import { useCompactShell } from "#lib/layout/compact-shell.svelte.ts";
import { onListScrollTop } from "#lib/layout/list-scroll-top.ts";
import { m } from "#lib/paraglide/messages.js";
import { sdk } from "#lib/sdk.ts";
import {
	pruneSelection,
	selectRange,
	toggleSelection,
} from "#lib/selection.ts";
import {
	buildSpaceRootRoute,
	buildSpaceSettingsRoute,
	buildSpaceWalletRoute,
} from "#lib/space-routes.ts";
import {
	archiveFlags,
	pinFlags,
	setSpacesArchived,
	setSpacesPinned,
	type ViewerFlags,
} from "#lib/stores/space-pins.svelte.ts";
import { goto } from "$app/navigation";

const NO_SELECTION: ReadonlySet<string> = new Set();

type LabelTarget = { ids: string[]; anchor: HTMLElement | null; title: string };

const list = spacesInbox.list;
const locale = $derived(getLocale());
const compact = $derived(useCompactShell());
const filter = $derived(spacesInbox.filter);
const filterIndex = $derived(SPACES_FILTERS.indexOf(filter));
const tabs = new SwipeTabs(() => ({ index: filterIndex, enabled: compact }));
const view = $derived(list.view(filter));
const spaces = $derived(view.items);
let actionError = $state("");
let selected = $state<Set<string>>(new Set());
let anchorId: string | null = null;
let busy = $state(false);
let labelAnchor = $state<HTMLElement | null>(null);
let labelTarget = $state<LabelTarget | null>(null);

const selecting = $derived(selected.size > 0);
const allSelectedPinned = $derived(
	selecting &&
		spaces.every((space) => !selected.has(space.id) || space.isPinned),
);

function neighbours() {
	return [
		SPACES_FILTERS[filterIndex - 1],
		SPACES_FILTERS[filterIndex + 1],
	].filter((value) => value !== undefined);
}

function selectFilter(value: SpacesFilter) {
	if (value === filter) {
		tabs.scrollToTop();
		return;
	}
	spacesInbox.filter = value;
}

function clearSelection() {
	selected = new Set();
	anchorId = null;
	labelTarget = null;
}

function toggle(id: string, event?: MouseEvent) {
	selected = event?.shiftKey
		? selectRange(
				selected,
				spaces.map((space) => space.id),
				anchorId,
				id,
			)
		: toggleSelection(selected, id);
	anchorId = id;
}

function failed(cause: unknown) {
	actionError =
		cause instanceof Error
			? cause.message
			: m.spaces_update_failed({}, { locale });
}

async function setFlags(
	ids: string[],
	flags: ViewerFlags,
	write: () => Promise<unknown>,
) {
	const previous = ids.map((id) => {
		const space = list.find(id);
		return [
			id,
			{
				isPinned: space?.isPinned ?? false,
				isArchived: space?.isArchived ?? false,
			},
		] as const;
	});
	actionError = "";
	spacesInbox.applyViewerFlags(ids, flags);
	try {
		await write();
	} catch (cause) {
		for (const [id, before] of previous)
			spacesInbox.applyViewerFlags([id], before);
		failed(cause);
	}
}

function setPinned(ids: string[], pinned: boolean) {
	return setFlags(ids, pinFlags(pinned), () => setSpacesPinned(ids, pinned));
}

function setArchived(ids: string[], archived: boolean) {
	return setFlags(ids, archiveFlags(archived), () =>
		setSpacesArchived(ids, archived),
	);
}

async function applyLabel(labelRef: string) {
	if (!labelTarget || busy) return;
	const { ids } = labelTarget;
	busy = true;
	actionError = "";
	try {
		await sdk.user.labels.patchResources(ids, { addLabelRefs: [labelRef] });
		if (selecting) clearSelection();
		else labelTarget = null;
	} catch (cause) {
		failed(cause);
	} finally {
		busy = false;
	}
}

function selectionIds() {
	const ids = [...selected];
	clearSelection();
	return ids;
}

function pinSelection() {
	const pinned = !allSelectedPinned;
	void setPinned(selectionIds(), pinned);
}

function archiveSelection() {
	const archived = filter !== "archived";
	void setArchived(selectionIds(), archived);
}

function toggleSelectionLabel() {
	labelTarget = labelTarget
		? null
		: {
				ids: [...selected],
				anchor: labelAnchor,
				title: m.spaces_label_title({ count: selected.size }, { locale }),
			};
}

function nameOf(space: SpaceRecord) {
	return (
		space.name?.trim() ||
		space.title?.trim() ||
		m.spaces_default_name({}, { locale })
	);
}

function spaceMenu(
	space: SpaceRecord,
	target: HTMLElement,
): ContextMenuContent {
	return {
		title: nameOf(space),
		items: [
			{
				id: "pin",
				label: space.isPinned
					? m.command_unpin({}, { locale })
					: m.command_pin({}, { locale }),
				icon: space.isPinned ? PinOff : Pin,
				run: () => void setPinned([space.id], !space.isPinned),
			},
			{
				id: "archive",
				label: space.isArchived
					? m.spaces_unarchive({}, { locale })
					: m.spaces_archive({}, { locale }),
				icon: space.isArchived ? ArchiveRestore : Archive,
				run: () => void setArchived([space.id], !space.isArchived),
			},
			{
				id: "label",
				label: `${m.spaces_label_add({}, { locale })}…`,
				icon: Tag,
				run: () => {
					labelTarget = {
						ids: [space.id],
						anchor: target,
						title: m.spaces_label_add({}, { locale }),
					};
				},
			},
			MENU_SEPARATOR,
			{
				id: "wallet",
				label: m.wallet_title({}, { locale }),
				icon: Wallet,
				run: () => void goto(buildSpaceWalletRoute(space.id)),
			},
			space.relation !== "public" && {
				id: "settings",
				label: m.sidebar_space_settings({}, { locale }),
				icon: Settings,
				run: () => void goto(buildSpaceSettingsRoute(space.id)),
			},
			MENU_SEPARATOR,
			...linkEntries(buildSpaceRootRoute(space.id)),
			MENU_SEPARATOR,
			{
				id: "select",
				label: m.spaces_select({}, { locale }),
				icon: CircleCheck,
				run: () => toggle(space.id),
			},
		],
	};
}

$effect(() => {
	void filter;
	untrack(clearSelection);
});

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
	const stopScrollTop = onListScrollTop(() => tabs.scrollToTop());
	const onKeydown = (event: KeyboardEvent) => {
		if (event.key !== "Escape" || event.defaultPrevented || !selecting) return;
		if (labelTarget) return;
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
		class="-ml-2.5 flex h-10 w-10 shrink-0 items-center justify-center rounded-[8px] text-text-tertiary transition-colors hover:bg-bg-hover hover:text-text-primary lg:-ml-1.5 lg:h-7 lg:w-7 lg:rounded-[6px]"
		aria-label={m.common_cancel({}, { locale })}
		title={m.common_cancel({}, { locale })}
		onclick={clearSelection}
	>
		<X class="h-5 w-5 lg:h-4 lg:w-4" />
	</button>
	<span class="truncate text-[15px] font-semibold tabular-nums text-text-primary lg:text-[13px]" aria-live="polite">
		{m.label_selected_count({ count: selected.size }, { locale })}
	</span>
{/snippet}

{#snippet libraryTabs()}
	<LibraryTabs variant="header" />
{/snippet}

<section class="flex h-full min-h-0 flex-1 flex-col overflow-hidden bg-bg-primary">
	<div class="shrink-0 border-b border-border-subtle">
		<ListHeader
			title={m.spaces_title({}, { locale })}
			brand={!selecting}
			children={selecting ? selectionTitle : compact ? libraryTabs : undefined}
		>
			{#snippet actions()}
				{#if selecting}
					<HeaderAction
						label={allSelectedPinned ? m.command_unpin({}, { locale }) : m.command_pin({}, { locale })}
						icon={allSelectedPinned ? PinOff : Pin}
						disabled={busy}
						onclick={pinSelection}
					/>
					<HeaderAction
						label={filter === "archived" ? m.spaces_unarchive({}, { locale }) : m.spaces_archive({}, { locale })}
						icon={filter === "archived" ? ArchiveRestore : Archive}
						disabled={busy}
						onclick={archiveSelection}
					/>
					<HeaderAction
						bind:ref={labelAnchor}
						label={m.spaces_label_add({}, { locale })}
						icon={Tag}
						disabled={busy}
						expanded={labelTarget !== null}
						onclick={toggleSelectionLabel}
					/>
				{:else}
					<HeaderAction label={m.list_search({}, { locale })} icon={Search} shortcut="⌘K" onclick={() => openAreaSearch("spaces")} />
					<HeaderAction label={m.spaces_new({}, { locale })} icon={Plus} tone="brand" href="/spaces/new" />
				{/if}
			{/snippet}
		</ListHeader>
		{#if compact}
			<FilterBar
				label={m.spaces_title({}, { locale })}
				role="tablist"
				activeKey={SPACES_FILTERS[tabs.shown] ?? null}
				position={tabs.position}
				glide={tabs.glide}
			>
				{#each SPACES_FILTERS as value, index (value)}
					<FilterChip label={spacesFilterLabel(value, locale)} active={tabs.shown === index} onclick={() => selectFilter(value)} />
				{/each}
			</FilterBar>
		{/if}
	</div>

	{#if actionError || view.error}
		<div class="flex shrink-0 items-center gap-3 border-b border-border-subtle px-[var(--list-content-x)] py-2 text-[12px] text-error-soft" role="alert">
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
		onPosition={tabs.track}
	>
		{#snippet page(index, active)}
			{@const value = SPACES_FILTERS[index] ?? filter}
			{@const pageView = list.view(value)}
			<SpacesListPane
				bind:this={() => tabs.panes[index], (pane) => (tabs.panes[index] = pane)}
				filter={value}
				spaces={pageView.items}
				loading={pageView.loading}
				loadingMore={pageView.loadingMore}
				error={Boolean(pageView.error)}
				{compact}
				selected={active ? selected : NO_SELECTION}
				onToggle={toggle}
				onLoadMore={active ? () => void list.loadMore(value) : undefined}
				menu={spaceMenu}
			/>
		{/snippet}
	</SwipePager>
</section>

<SpaceLabelPicker
	open={labelTarget !== null}
	anchor={labelTarget?.anchor ?? null}
	title={labelTarget?.title ?? ""}
	onApply={applyLabel}
	onClose={() => {
		labelTarget = null;
	}}
/>
