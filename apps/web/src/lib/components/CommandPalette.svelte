<script lang="ts">
import type { ContentBlock } from "@cohub/protocol/core";
import type { PaletteOverviewResponse, SpaceRecord } from "@neta-art/cohub";
import {
	CornerDownRight,
	Loader2,
	Search,
	Settings2,
	TerminalSquare,
	X,
} from "lucide-svelte";
import { onMount, tick, untrack } from "svelte";
import { MediaQuery, SvelteMap } from "svelte/reactivity";
import { afterNavigate, goto, pushState, replaceState } from "$app/navigation";
import { page } from "$app/state";
import { getCacheUserKey } from "$lib/cache/keys";
import {
	getCachedSpacePage,
	setCachedSpacePage,
} from "$lib/cache/space-list-page-cache";
import {
	resolveLocalCommandItems,
	settingsCommandSection,
	withLocalCommands,
} from "$lib/command-palette/commands";
import {
	getCommandPaletteDefaultItems,
	getLocalPaletteOverview,
	spaceRecordToCommandItem,
} from "$lib/command-palette/default-items";
import {
	absorbLensPrefix,
	buildSearchPlan,
	COMMAND_PALETTE_LENSES,
	type CommandPaletteLens,
	lensOf,
} from "$lib/command-palette/lens";
import {
	commandLensLabel,
	commandLensPlaceholder,
} from "$lib/command-palette/lens-copy";
import { searchLocalCommandItems } from "$lib/command-palette/local-search";
import {
	commandItemKey,
	mergeCommandResults,
	sameCommandItemSequence,
} from "$lib/command-palette/merge-results";
import {
	type CommandPaletteHistoryEntry,
	type CommandPaletteIntent,
	OPEN_COMMAND_PALETTE_EVENT,
	type OpenCommandPaletteDetail,
} from "$lib/command-palette/open";
import {
	getPaletteOverviewSnapshot,
	revalidatePaletteOverview,
	schedulePaletteOverviewRevalidate,
} from "$lib/command-palette/palette-overview";
import { mergeLocalOverviewIntoSnapshot } from "$lib/command-palette/palette-overview-local";
import { parseCommandPaletteQuery } from "$lib/command-palette/query";
import {
	getRecentCommandItems,
	openCommandItem,
	rememberCommandItem,
} from "$lib/command-palette/recent";
import {
	clearRecentQueries,
	getRecentQueries,
	type RecentQuery,
	rememberRecentQuery,
} from "$lib/command-palette/recent-queries";
import { searchRemoteCommandItems } from "$lib/command-palette/remote-search";
import { getRemoteResourceTypes } from "$lib/command-palette/scope";
import type { CommandPaletteItem } from "$lib/command-palette/types";
import CommandPaletteLensBar from "$lib/components/command-palette/CommandPaletteLensBar.svelte";
import CommandPaletteRecentQueries from "$lib/components/command-palette/CommandPaletteRecentQueries.svelte";
import CommandPaletteResultRow from "$lib/components/command-palette/CommandPaletteResultRow.svelte";
import FilterBar from "$lib/components/list-page/FilterBar.svelte";
import FilterChip from "$lib/components/list-page/FilterChip.svelte";
import ListRowSkeleton from "$lib/components/list-page/ListRowSkeleton.svelte";
import SwipePager from "$lib/components/list-page/SwipePager.svelte";
import { SwipeTabs } from "$lib/components/list-page/swipe-tabs.svelte";
import { settingsSectionLabel } from "$lib/components/settings-section";
import ToolCallList from "$lib/components/ToolCallList.svelte";
import { getLocale } from "$lib/i18n/locale.svelte";
import { isComposingKeyboardEvent } from "$lib/keyboard";
import { m } from "$lib/paraglide/messages.js";
import { sdk } from "$lib/sdk";
import { filterSpacePickerItems } from "$lib/space-picker-model";
import { buildUserNewSessionRoute } from "$lib/space-routes";
import { authStore } from "$lib/stores/auth.svelte";
import { getRecentSpaces } from "$lib/stores/recent-space";
import {
	getCachedSpaceFilterPref,
	type SpaceFilterPref,
	setCachedSpaceFilterPref,
} from "$lib/stores/space-picker-filter";
import { toggleSpacePin } from "$lib/stores/space-pins.svelte";

/** Immediately reflect pin state on rendered items after a toggle. */
function syncPinStateInItems(spaceId: string, isPinned: boolean) {
	const patch = (items: CommandPaletteItem[]) =>
		items.map((item) =>
			item.type === "space" && item.spaceId === spaceId
				? { ...item, isPinned }
				: item,
		);
	defaultItems = patch(defaultItems);
	localItems = patch(localItems);
}

function togglePin(item: CommandPaletteItem) {
	const wasPinned = item.isPinned ?? false;
	syncPinStateInItems(item.spaceId, !wasPinned);
	void toggleSpacePin(item.spaceId).catch((error) => {
		console.warn("[command-palette] pin toggle failed", error);
		syncPinStateInItems(item.spaceId, wasPinned);
	});
}

const MIN_QUERY_LENGTH = 2;
const locale = $derived(getLocale());
const RESULT_LIMIT = 30;
const DEBOUNCE_MS = 180;
const POINTER_HOVER_ARM_MS = 220;
const fullScreen = new MediaQuery("max-width: 640px");

/**
 * Land a rebuilt default list without a redundant render. The result list is
 * keyed by item identity, so an identical ordered sequence would not move any
 * DOM node anyway — skipping the assignment keeps a background revalidation
 * (which usually predicts the same order via the local merge) invisible.
 */
function applyDefaultItems(next: CommandPaletteItem[]) {
	if (sameCommandItemSequence(defaultItems, next)) return;
	defaultItems = next;
}

let open = $state(false);
let lens = $state<CommandPaletteLens>("all");
/** What the landing page showed mid-swipe, held until its own results arrive. */
let seed = $state<CommandPaletteItem[] | null>(null);
const lensSnapshots = new SvelteMap<string, CommandPaletteItem[]>();
let query = $state("");
let openIntent = $state<CommandPaletteIntent>("navigate");
let historyBacked = false;
let recentQueries = $state<RecentQuery[]>([]);
let inputEl = $state<HTMLInputElement | null>(null);
let resultsEl = $state<HTMLDivElement | null>(null);
let activeIndex = $state(0);
let settledItems = $state<CommandPaletteItem[]>([]);
let suppressPointerHover = $state(false);
let pointerHoverTimer: number | null = null;
let localItems = $state<CommandPaletteItem[]>([]);
let remoteItems = $state<import("@neta-art/cohub").GlobalSearchResult[]>([]);
let defaultItems = $state<CommandPaletteItem[]>([]);
/** Pre-overview local default list — backs the "All" tab in space picker mode. */
let legacyDefaultItems = $state<CommandPaletteItem[]>([]);
let localDone = $state(true);
let remoteDone = $state(true);
let defaultDone = $state(true);
let legacyDefaultDone = $state(true);
let remoteError = $state<string | null>(null);
let archivedItems = $state<CommandPaletteItem[]>([]);
let archivedDone = $state(true);
let archivedToken = 0;
let debounceTimer: number | null = null;
let localController: AbortController | null = null;
let remoteController: AbortController | null = null;
let searchToken = 0;
let runMode = $state(false);
let runCommand = $state("");
let runTaskId = $state<string | null>(null);
let runProgress = $state<ContentBlock[] | null>(null);
let runResult = $state<ContentBlock[] | null>(null);
let runStatus = $state<"idle" | "queued" | "running" | "done" | "failed">(
	"idle",
);
let runError = $state("");
let runPollTimer: number | null = null;

type SpaceFilter = SpaceFilterPref | "archived";
let spaceFilter = $state<SpaceFilter>("all");

// Pagination for Space Picker mode: load larger page sizes (e.g. 50 items per page)
// and dynamically render more as user scrolls.
const SPACE_PAGE_SIZE = 50;
let spaceDisplayLimit = $state(SPACE_PAGE_SIZE);

function handleResultsScroll(event: Event) {
	if (!isSpacePickerMode || runMode) return;
	const target = event.currentTarget as HTMLElement | null;
	if (!target) return;
	// When scrolled within 100px of bottom, reveal next page
	if (target.scrollTop + target.clientHeight >= target.scrollHeight - 100) {
		const totalAvailable = filteredSpaceItems
			? filteredSpaceItems(mergedItemsRaw).length
			: mergedItemsRaw.length;
		if (spaceDisplayLimit < totalAvailable) {
			spaceDisplayLimit += SPACE_PAGE_SIZE;
		}
	}
}

// Space filter reset on change
$effect(() => {
	spaceFilter;
	lens;
	query;
	open;
	spaceDisplayLimit = SPACE_PAGE_SIZE;
});

const currentSpaceId = $derived.by(() => {
	const match = page.url.pathname.match(/^\/spaces\/([^/]+)/);
	const id = match?.[1] ?? null;
	return id === "new" ? null : id;
});
const searchPlan = $derived(buildSearchPlan(lens, query));
const activeLens = $derived(lensOf(searchPlan.resourceTypes));
const trimmedQuery = $derived(searchPlan.query.trim());
const hasLabelScope = $derived(
	Boolean(searchPlan.labelRef && searchPlan.resourceTypes?.includes("label")),
);
const typeLabel = $derived(
	searchPlan.resourceTypes?.length
		? searchPlan.resourceTypes
				.map((type) => commandLensLabel(type, locale))
				.join(" + ")
		: null,
);
const title = $derived(
	runMode
		? m.command_run_title({}, { locale })
		: openIntent === "new-chat"
			? m.chats_new_chat_in({}, { locale })
			: m.command_title({}, { locale }),
);
const placeholder = $derived(
	runMode
		? m.command_run_placeholder({}, { locale })
		: commandLensPlaceholder(activeLens ?? "all", locale),
);
const showLensBar = $derived(!runMode && openIntent !== "new-chat");
const isSpacePickerMode = $derived(
	openIntent === "new-chat" ||
		(searchPlan.resourceTypes?.length === 1 &&
			searchPlan.resourceTypes[0] === "space"),
);
const hasRecentQueries = $derived(
	!runMode && !query.trim() && recentQueries.length > 0,
);
const resultLimit = $derived(
	isSpacePickerMode ? SPACE_PAGE_SIZE : RESULT_LIMIT,
);
const recentItems = $derived.by(() => {
	const items = getRecentCommandItems();
	if (!searchPlan.resourceTypes) return items;
	return items.filter((item) => searchPlan.resourceTypes?.includes(item.type));
});
// Local commands are always resolved synchronously — never blocked by network/IDB.
function localizedCommandTitle(item: CommandPaletteItem) {
	if (item.id === "manage-spaces") return m.spaces_manage({}, { locale });
	const section = settingsCommandSection(item);
	return section ? settingsSectionLabel(section, locale) : null;
}

function localizedCommandExcerpt(item: CommandPaletteItem) {
	if (item.id === "manage-spaces")
		return m.spaces_search_placeholder({}, { locale });
	return settingsCommandSection(item) ? m.nav_settings({}, { locale }) : null;
}

const localCommands = $derived(
	resolveLocalCommandItems(searchPlan, localizedCommandTitle).map((item) => ({
		...item,
		title: localizedCommandTitle(item) ?? item.title,
		excerpt: localizedCommandExcerpt(item) ?? item.excerpt,
	})),
);
const myUserUuid = $derived(authStore.userUuid);
const filteredSpaceItems = $derived.by(() => {
	if (!isSpacePickerMode || spaceFilter === "archived") return null;
	const pickerFilter = spaceFilter;
	if (pickerFilter === "all" || pickerFilter === "recent") {
		return (items: CommandPaletteItem[]) =>
			items.filter((item) => item.type !== "space" || !item.isArchived);
	}
	return (items: CommandPaletteItem[]) =>
		items.filter(
			(item) =>
				item.type !== "space" ||
				filterSpacePickerItems(
					[
						{
							id: item.spaceId,
							name: item.spaceName,
							ownerUserUuid: item.ownerProfile?.userUuid,
							isPinned: item.isPinned,
							isArchived: item.isArchived,
						},
					],
					pickerFilter,
					"",
					myUserUuid,
				).length > 0,
		);
});
const mergedItemsRaw = $derived.by(() => {
	if (isSpacePickerMode && spaceFilter === "archived") return archivedItems;
	// Long, specific queries let strong matches bypass the personal-relevance tier.
	const isLongQuery = trimmedQuery.length >= 12;
	// Only the space picker "Recent" tab uses the overview-backed list.
	const useOverviewDefaults = isSpacePickerMode && spaceFilter === "recent";
	const defaultSource = useOverviewDefaults
		? defaultItems.length > 0
			? defaultItems
			: legacyDefaultItems.length > 0
				? legacyDefaultItems
				: recentItems
		: legacyDefaultItems.length > 0
			? legacyDefaultItems
			: defaultItems.length > 0
				? defaultItems
				: recentItems;
	let raw =
		trimmedQuery.length < MIN_QUERY_LENGTH && !hasLabelScope
			? withLocalCommands(defaultSource, localCommands, resultLimit)
			: withLocalCommands(
					mergeCommandResults({
						local: localItems,
						remote: remoteItems,
						limit: resultLimit * 2,
						longQuery: isLongQuery,
					}),
					localCommands,
					resultLimit,
					isLongQuery,
				);
	// New-chat intent is space-only: keep spaces + New Space, drop the rest.
	if (openIntent === "new-chat") {
		raw = raw.filter(
			(item) =>
				item.type === "space" ||
				(item.type === "command" && item.id === "new-space"),
		);
	}
	// Apply Mine / Pinned filter in space picker mode
	if (filteredSpaceItems) raw = filteredSpaceItems(raw);
	return raw;
});
const mergedItems = $derived.by(() => {
	if (isSpacePickerMode) {
		return mergedItemsRaw.slice(0, spaceDisplayLimit);
	}
	return mergedItemsRaw;
});
const isSearching = $derived(
	!localDone ||
		!remoteDone ||
		!defaultDone ||
		!legacyDefaultDone ||
		!archivedDone,
);
const lensSettled = $derived(
	trimmedQuery.length < MIN_QUERY_LENGTH && !hasLabelScope
		? defaultDone && legacyDefaultDone
		: localDone,
);
const pending = $derived(seed !== null && !lensSettled);
const renderedItems = $derived(
	pending && seed
		? seed
		: mergedItems.length > 0 || !isSearching
			? mergedItems
			: settledItems,
);
const swipeable = $derived(
	fullScreen.current && showLensBar && activeLens !== null,
);
const lensIndex = $derived(
	activeLens ? COMMAND_PALETTE_LENSES.indexOf(activeLens) : 0,
);
const lensTabs = new SwipeTabs(() => ({
	index: lensIndex,
	enabled: swipeable,
}));
const lensPosition = $derived(activeLens ? lensTabs.position : null);
const showingSettledItems = $derived(
	isSearching && mergedItems.length === 0 && settledItems.length > 0,
);
const runBlocks = $derived(runResult ?? runProgress ?? []);
const statusText = $derived.by(() => {
	const label = typeLabel ?? m.command_type_default({}, { locale });
	if (trimmedQuery.length < MIN_QUERY_LENGTH && !hasLabelScope) {
		return renderedItems.length > 0
			? m.command_status_filter({ label }, { locale })
			: m.command_status_search_initial(
					{ label: label.toLowerCase() },
					{ locale },
				);
	}
	if (showingSettledItems)
		return m.command_status_searching({ label }, { locale });
	if (remoteError)
		return m.command_status_local({ label, error: remoteError }, { locale });
	if (!remoteDone)
		return m.command_status_server(
			{ label, count: localItems.length + localCommands.length },
			{ locale },
		);
	if (!localDone) return m.command_status_cache({ label }, { locale });
	const count = renderedItems.length;
	return count === 1
		? m.command_status_done({ label, count }, { locale })
		: m.command_status_done_many({ label, count }, { locale });
});

function armPointerHover() {
	suppressPointerHover = true;
	if (pointerHoverTimer != null) window.clearTimeout(pointerHoverTimer);
	pointerHoverTimer = window.setTimeout(() => {
		suppressPointerHover = false;
		pointerHoverTimer = null;
	}, POINTER_HOVER_ARM_MS);
}

function handleResultPointerMove(index: number) {
	if (suppressPointerHover) return;
	activeIndex = index;
}

function remoteSearchSpaceId(
	spaceId: string | null,
	remoteResourceTypes: ReturnType<typeof getRemoteResourceTypes>,
) {
	if (!spaceId) return undefined;
	if (!remoteResourceTypes || remoteResourceTypes.includes("space"))
		return undefined;
	return spaceId;
}

function handleCommandInput(event: Event) {
	const input = event.currentTarget as HTMLInputElement;
	const value = input.value;
	if (runMode) {
		runCommand = value;
		if (runStatus !== "running" && runStatus !== "queued") {
			runTaskId = null;
			runProgress = null;
			runResult = null;
			runError = "";
			runStatus = "idle";
		}
		return;
	}
	const next =
		openIntent === "new-chat"
			? { lens, input: value }
			: absorbLensPrefix(lens, value);
	// Set the DOM value directly: `query` may not change (`s:` → "").
	if (next.input !== value) input.value = next.input;
	query = next.input;
	if (next.lens !== lens) selectLens(next.lens);
	widenSpaceFilter();
}

function widenSpaceFilter() {
	if (query.trim() && isSpacePickerMode && spaceFilter !== "archived")
		spaceFilter = "all";
}

function selectLens(next: CommandPaletteLens) {
	const parsed = parseCommandPaletteQuery(query);
	if (parsed.explicitTypeFilter) query = parsed.query;
	if (next === "space" && lens !== "space")
		spaceFilter = getCachedSpaceFilterPref();
	if (next !== activeLens) {
		seed = previewFor(next) ?? [];
		settledItems = seed;
		localDone = false;
		legacyDefaultDone = false;
	}
	lens = next;
	activeIndex = 0;
	refocusInput();
}

function snapshotKey(target: CommandPaletteLens) {
	return `${target === "space" ? spaceFilter : ""}:${target}\n${query}`;
}

function previewFor(target: CommandPaletteLens) {
	const snapshot = lensSnapshots.get(snapshotKey(target));
	if (snapshot) return snapshot;
	if (activeLens !== "all" || target === "all") return null;
	if (target === "space" && spaceFilter !== "all") return null;
	return renderedItems.filter((item) => item.type === target);
}

function bindResults(node: HTMLDivElement) {
	resultsEl = node;
	return () => {
		if (resultsEl === node) resultsEl = null;
	};
}

function refocusInput() {
	if (!fullScreen.current) inputEl?.focus();
}

function clearInput() {
	if (runMode) runCommand = "";
	else query = "";
	activeIndex = 0;
	inputEl?.focus();
}

function pickRecentQuery(entry: RecentQuery) {
	selectLens(entry.lens);
	query = entry.query;
	widenSpaceFilter();
}

function forgetRecentQueries() {
	clearRecentQueries(getCacheUserKey());
	recentQueries = [];
	refocusInput();
}

function dismissKeyboard() {
	if (document.activeElement === inputEl) inputEl?.blur();
}

const SPACE_FILTER_KEYS: SpaceFilter[] = [
	"recent",
	"all",
	"mine",
	"pinned",
	"archived",
];

function selectSpaceFilter(next: SpaceFilter) {
	spaceFilter = next;
	if (next !== "archived") setCachedSpaceFilterPref(next);
	activeIndex = 0;
}

function spaceFilterLabel(key: SpaceFilter) {
	switch (key) {
		case "recent":
			return m.command_recent({}, { locale });
		case "all":
			return m.command_all({}, { locale });
		case "mine":
			return m.command_mine({}, { locale });
		case "pinned":
			return m.command_pinned({}, { locale });
		case "archived":
			return m.spaces_archived({}, { locale });
	}
}

function loadArchivedSpaces(searchQuery: string) {
	const token = ++archivedToken;
	archivedDone = false;
	const q = searchQuery.trim();
	const toItems = (spaces: SpaceRecord[]) =>
		spaces
			.filter((space) => space.isArchived)
			.map((space, rank) =>
				spaceRecordToCommandItem(space, rank, currentSpaceId),
			);
	void getCachedSpacePage("archived", q)
		.then((cached) => {
			if (token === archivedToken && cached)
				archivedItems = toItems(cached.items);
		})
		.catch(() => undefined);
	const timer = window.setTimeout(
		() => {
			if (token !== archivedToken) return;
			void sdk.spaces
				.list({ limit: SPACE_PAGE_SIZE, filter: "archived", query: q })
				.then((page) => {
					if (token !== archivedToken) return;
					archivedItems = toItems(page.items);
					void setCachedSpacePage("archived", q, page).catch(() => undefined);
				})
				.catch((error) => {
					if (token === archivedToken)
						console.warn("[command-palette] archived spaces failed", error);
				})
				.finally(() => {
					if (token === archivedToken) archivedDone = true;
				});
		},
		q ? DEBOUNCE_MS : 0,
	);
	return () => window.clearTimeout(timer);
}

function handleSpaceFilterKeydown(event: KeyboardEvent, current: SpaceFilter) {
	const currentIndex = SPACE_FILTER_KEYS.indexOf(current);
	let nextIndex = -1;
	if (event.key === "ArrowRight")
		nextIndex = (currentIndex + 1) % SPACE_FILTER_KEYS.length;
	if (event.key === "ArrowLeft")
		nextIndex =
			(currentIndex - 1 + SPACE_FILTER_KEYS.length) % SPACE_FILTER_KEYS.length;
	if (event.key === "Home") nextIndex = 0;
	if (event.key === "End") nextIndex = SPACE_FILTER_KEYS.length - 1;
	if (nextIndex < 0) return;
	event.preventDefault();
	const next =
		SPACE_FILTER_KEYS[
			Math.min(Math.max(nextIndex, 0), SPACE_FILTER_KEYS.length - 1)
		];
	if (!next) return;
	selectSpaceFilter(next);
	void tick().then(() =>
		document.getElementById(`command-space-filter-${next}`)?.focus(),
	);
}

function resetRunState() {
	runMode = false;
	runCommand = "";
	runTaskId = null;
	runProgress = null;
	runResult = null;
	runStatus = "idle";
	runError = "";
	if (runPollTimer != null) window.clearInterval(runPollTimer);
	runPollTimer = null;
}

const SPACE_WARM_TTL_MS = 60_000;
let lastSpaceWarmAt = 0;

function warmSpacePickerCache() {
	const auth = authStore.userUuid;
	if (!auth) return;
	const now = Date.now();
	if (now - lastSpaceWarmAt < SPACE_WARM_TTL_MS) return;
	lastSpaceWarmAt = now;
	void sdk.spaces
		.list({
			limit: 50,
			filter: "all",
			recentSpaces: getRecentSpaces(auth).map((entry) => ({
				id: entry.spaceId,
				timestamp: entry.timestamp,
			})),
		})
		.then((page) => setCachedSpacePage("all", "", page))
		.catch(() => {
			lastSpaceWarmAt = 0;
		});
}

function openPalette(detail?: OpenCommandPaletteDetail, restored = false) {
	openIntent = detail?.intent ?? "navigate";
	const initial = absorbLensPrefix(detail?.lens ?? "all", detail?.query ?? "");
	lens = openIntent === "new-chat" ? "space" : initial.lens;
	query = initial.input;
	spaceFilter = getCachedSpaceFilterPref();
	widenSpaceFilter();
	recentQueries = getRecentQueries(getCacheUserKey());
	activeIndex = 0;
	armPointerHover();
	resetRunState();
	open = true;
	historyBacked = restored || fullScreen.current;
	if (historyBacked && !restored) writeHistoryEntry();
	if (!restored || !fullScreen.current)
		void tick().then(() => inputEl?.focus());
	warmSpacePickerCache();
}

function writeHistoryEntry() {
	const commandPalette: CommandPaletteHistoryEntry = {
		lens,
		query,
		intent: openIntent,
	};
	const state = { ...page.state, commandPalette };
	if (page.state.commandPalette) replaceState("", state);
	else pushState("", state);
}

function closePalette() {
	if (historyBacked && page.state.commandPalette) history.back();
	teardownPalette();
}

function teardownPalette() {
	open = false;
	historyBacked = false;
	lens = "all";
	query = "";
	openIntent = "navigate";
	spaceFilter = getCachedSpaceFilterPref();
	activeIndex = 0;
	settledItems = [];
	archivedItems = [];
	seed = null;
	lensSnapshots.clear();
	searchToken += 1;
	localController?.abort();
	remoteController?.abort();
	resetRunState();
}

async function leavePalette(navigate: () => Promise<unknown>) {
	if (openIntent === "navigate" && query.trim().length >= MIN_QUERY_LENGTH)
		recentQueries = rememberRecentQuery(getCacheUserKey(), { lens, query });
	if (historyBacked && page.state.commandPalette) writeHistoryEntry();
	await navigate();
	closePalette();
}

function openSpacesManager(event: MouseEvent) {
	if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey)
		return;
	event.preventDefault();
	void leavePalette(() => goto("/spaces"));
}

function resetSearch(options?: { clearDefaultLists?: boolean }) {
	localController?.abort();
	remoteController?.abort();
	if (debounceTimer != null) window.clearTimeout(debounceTimer);
	localItems = [];
	remoteItems = [];
	// Tab switches pass `clearDefaultLists: false` so each tab keeps its last
	// list as the instant first frame while the rebuild runs. Dropping to the
	// localStorage recent-commands list mid-switch is what made the palette
	// visibly flash between two unrelated datasets on every tab toggle.
	if (options?.clearDefaultLists !== false) {
		defaultItems = [];
		legacyDefaultItems = [];
	}
	localDone = true;
	remoteDone = true;
	defaultDone = true;
	legacyDefaultDone = true;
	remoteError = null;
	activeIndex = 0;
}

function scheduleSearch(plan: typeof searchPlan, spaceId: string | null) {
	const q = plan.query.trim();
	const isLabelScope = Boolean(
		plan.labelRef && plan.resourceTypes?.includes("label"),
	);
	const token = ++searchToken;
	if (q.length < MIN_QUERY_LENGTH && !isLabelScope) {
		// Keep previous default/resource items while reloading so the list does not
		// flash empty. Both tab lists survive the switch (see resetSearch): the
		// active tab renders its own last list until the rebuild lands, and only
		// the very first activation falls back through the other tab's list.
		resetSearch({ clearDefaultLists: false });
		defaultDone = false;
		legacyDefaultDone = false;
		localController = new AbortController();
		const defaultSignal = localController.signal;
		const buildDefaults = (overview: PaletteOverviewResponse | null) =>
			getCommandPaletteDefaultItems({
				...plan,
				currentSpaceId: spaceId,
				signal: defaultSignal,
				viewerUserUuid: myUserUuid,
				paletteOverview: overview,
			});
		const useOverviewDefaults = isSpacePickerMode && spaceFilter === "recent";
		if (useOverviewDefaults) {
			// First frame: the cached snapshot folded with local caches, so the
			// refetched response swaps in without re-sorting.
			const snapshot = getPaletteOverviewSnapshot();
			const snapshotData = snapshot.data;
			void getLocalPaletteOverview({
				signal: defaultSignal,
				viewerUserUuid: myUserUuid,
			})
				.then((local) =>
					snapshotData?.spaces.length
						? mergeLocalOverviewIntoSnapshot(snapshotData, local)
						: local,
				)
				.then(buildDefaults)
				.then((items) => {
					if (token !== searchToken) return;
					applyDefaultItems(items);
				})
				.catch((error) => {
					if (error?.name === "AbortError") return;
					console.warn("[command-palette] local overview failed", error);
				})
				.finally(() => {
					if (token === searchToken) defaultDone = true;
				});
			// Detached from the search signal so the refetch survives tab changes.
			void revalidatePaletteOverview().then((fresh) => {
				if (!fresh || token !== searchToken) return;
				return buildDefaults(fresh)
					.then((items) => {
						if (token === searchToken) applyDefaultItems(items);
					})
					.catch(() => {
						// Keep the merged frame on refresh failures.
					});
			});
			legacyDefaultDone = true;
		} else {
			// Pre-overview behavior: the local default list is the source of truth
			// for the plain palette and the All / Mine / Pinned tabs.
			void buildDefaults(null)
				.then((items) => {
					if (token !== searchToken) return;
					legacyDefaultItems = items;
				})
				.catch((error) => {
					console.warn("[command-palette] legacy default items failed", error);
				})
				.finally(() => {
					if (token === searchToken) legacyDefaultDone = true;
				});
			defaultDone = true;
		}
		return;
	}

	resetSearch();
	localDone = false;
	remoteDone = false;
	localController = new AbortController();
	remoteController = new AbortController();

	void searchLocalCommandItems(q, {
		signal: localController.signal,
		resourceTypes: plan.resourceTypes,
		labelRef: plan.labelRef,
		viewerUserUuid: myUserUuid,
	})
		.then((items) => {
			if (token !== searchToken) return;
			localItems = items;
		})
		.catch((error) => {
			if (error?.name !== "AbortError")
				console.warn("[command-palette] local search failed", error);
		})
		.finally(() => {
			if (token === searchToken) localDone = true;
		});

	const remoteResourceTypes = getRemoteResourceTypes(plan);
	if (remoteResourceTypes && remoteResourceTypes.length === 0) {
		remoteDone = true;
		return;
	}

	debounceTimer = window.setTimeout(() => {
		void searchRemoteCommandItems(q, {
			signal: remoteController?.signal,
			limit: RESULT_LIMIT,
			types: remoteResourceTypes,
			spaceId: remoteSearchSpaceId(spaceId, remoteResourceTypes),
			labelRef: plan.labelRef,
		})
			.then((items) => {
				if (token !== searchToken) return;
				remoteItems = items;
				remoteError = null;
			})
			.catch((error) => {
				if (token !== searchToken || error?.name === "AbortError") return;
				remoteError =
					error instanceof Error ? error.message : "server unavailable";
			})
			.finally(() => {
				if (token === searchToken) remoteDone = true;
			});
	}, DEBOUNCE_MS);
}

function openRunCommandMode() {
	runMode = true;
	runCommand = "";
	runTaskId = null;
	runProgress = null;
	runResult = null;
	runStatus = "idle";
	runError = "";
	activeIndex = 0;
	void tick().then(() => inputEl?.focus());
}

async function submitRunCommand() {
	if (!currentSpaceId) {
		runError = m.command_open_space({}, { locale });
		runStatus = "failed";
		return;
	}
	if (!runCommand.trim() || runStatus === "running" || runStatus === "queued")
		return;
	runError = "";
	runStatus = "queued";
	try {
		const { taskRunId } = await sdk.space(currentSpaceId).runCommand({
			command: runCommand.trim(),
		});
		runTaskId = taskRunId;
		runProgress = null;
		runResult = null;
		runStatus = "running";
		if (runPollTimer != null) window.clearInterval(runPollTimer);
		const poll = async () => {
			if (!runTaskId) return;
			try {
				const { run, progress } = await sdk.tasks.get(runTaskId);
				runProgress =
					(progress as { content?: ContentBlock[] } | null)?.content ?? null;
				if (run.status === "completed") {
					runStatus = "done";
					runResult =
						(run.result as { content?: ContentBlock[] } | null)?.content ??
						null;
					if (runPollTimer != null) window.clearInterval(runPollTimer);
					runPollTimer = null;
					return;
				}
				if (run.status === "failed") {
					runStatus = "failed";
					runError = run.errorMessage ?? m.command_failed({}, { locale });
					if (runPollTimer != null) window.clearInterval(runPollTimer);
					runPollTimer = null;
				}
			} catch (error) {
				console.warn("[command-palette] command polling failed", error);
			}
		};
		await poll();
		runPollTimer = window.setInterval(() => void poll(), 1000);
	} catch (error) {
		runStatus = "failed";
		runError =
			error instanceof Error
				? error.message
				: m.command_run_failed({}, { locale });
	}
}

async function activate(item: CommandPaletteItem | undefined) {
	if (!item) return;
	if (item.id === "run-command") {
		// Not meaningful while picking a space for new chat.
		if (openIntent === "new-chat") return;
		openRunCommandMode();
		return;
	}
	// New-chat intent: only space (or create-space) actions are valid.
	if (openIntent === "new-chat") {
		if (item.type === "space" && item.spaceId) {
			const spaceId = item.spaceId;
			rememberCommandItem(item);
			await leavePalette(() =>
				goto(buildUserNewSessionRoute(spaceId), {
					keepFocus: true,
					noScroll: true,
				}),
			);
			return;
		}
		if (item.type === "command" && item.id === "new-space") {
			await leavePalette(() => openCommandItem(item));
			return;
		}
		// Ignore chats and labels — keep the palette open for a real space pick.
		return;
	}
	await leavePalette(() => openCommandItem(item));
}

function moveActive(delta: number) {
	if (renderedItems.length === 0) {
		activeIndex = 0;
		return;
	}
	activeIndex = Math.min(
		Math.max(activeIndex + delta, 0),
		renderedItems.length - 1,
	);
}

async function scrollActiveIntoView() {
	if (!open) return;
	await tick();
	resultsEl
		?.querySelector<HTMLElement>(".command-result.active")
		?.scrollIntoView({ block: "nearest" });
}

function handlePaletteKeydown(event: KeyboardEvent) {
	if (event.key === "Escape") {
		event.preventDefault();
		if (runMode) {
			if (runStatus === "running" || runStatus === "queued") {
				closePalette();
				return;
			}
			if (runCommand.trim()) {
				runMode = false;
				runStatus = "idle";
				return;
			}
		}
		closePalette();
		return;
	}
	if (isComposingKeyboardEvent(event)) return;
	if ((event.target as HTMLElement | null)?.closest("button, a")) return;
	if (runMode) {
		if (event.key === "Enter") {
			event.preventDefault();
			void submitRunCommand();
		}
		return;
	}
	if (
		event.key === "ArrowDown" ||
		(event.ctrlKey && event.key.toLowerCase() === "n")
	) {
		event.preventDefault();
		moveActive(1);
		return;
	}
	if (
		event.key === "ArrowUp" ||
		(event.ctrlKey && event.key.toLowerCase() === "p")
	) {
		event.preventDefault();
		moveActive(-1);
		return;
	}
	if (event.key === "Enter") {
		event.preventDefault();
		void activate(renderedItems[activeIndex]);
	}
}

function handleGlobalKeydown(event: KeyboardEvent) {
	if (isComposingKeyboardEvent(event)) return;
	if (open && event.key === "Escape") {
		event.preventDefault();
		event.stopPropagation();
		closePalette();
		return;
	}

	if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
		event.preventDefault();
		open ? closePalette() : openPalette();
	}
}

function handleOpenPaletteEvent(event: Event) {
	openPalette((event as CustomEvent<OpenCommandPaletteDetail>).detail);
}

$effect(() => {
	if (!open || runMode) return;
	if (isSpacePickerMode && spaceFilter === "archived") {
		resetSearch({ clearDefaultLists: false });
		return;
	}
	scheduleSearch(searchPlan, currentSpaceId);
});

$effect(() => {
	if (!open || runMode || !isSpacePickerMode || spaceFilter !== "archived") {
		archivedToken += 1;
		archivedDone = true;
		return;
	}
	return loadArchivedSpaces(searchPlan.query);
});

$effect(() => {
	if (mergedItems.length > 0 || !isSearching) settledItems = mergedItems;
});

$effect(() => {
	if (seed && lensSettled) seed = null;
});

$effect(() => {
	if (!open || runMode || !activeLens || seed || isSearching) return;
	lensSnapshots.set(snapshotKey(activeLens), mergedItems);
});

$effect(() => {
	if (activeIndex >= renderedItems.length)
		activeIndex = Math.max(renderedItems.length - 1, 0);
});

$effect(() => {
	activeIndex;
	renderedItems.length;
	void scrollActiveIntoView();
});

$effect(() => {
	const entry = page.state.commandPalette;
	untrack(() => {
		if (entry && !open) openPalette(entry, true);
		else if (!entry && open && historyBacked) teardownPalette();
	});
});

afterNavigate(({ type }) => {
	if (type === "popstate" && open && !page.state.commandPalette)
		teardownPalette();
});

onMount(() => {
	window.addEventListener("keydown", handleGlobalKeydown, { capture: true });
	window.addEventListener(OPEN_COMMAND_PALETTE_EVENT, handleOpenPaletteEvent);
	// Warm the overview when the app returns to the foreground, so the Recent
	// tab opens from cache instead of fetching. Cross-device activity is the
	// one signal the local caches cannot fold in at render time.
	const onVisibility = () => {
		if (document.visibilityState === "visible")
			schedulePaletteOverviewRevalidate();
	};
	const onFocus = () => schedulePaletteOverviewRevalidate();
	document.addEventListener("visibilitychange", onVisibility);
	window.addEventListener("focus", onFocus);
	return () => {
		document.removeEventListener("visibilitychange", onVisibility);
		window.removeEventListener("focus", onFocus);
		window.removeEventListener("keydown", handleGlobalKeydown, {
			capture: true,
		});
		window.removeEventListener(
			OPEN_COMMAND_PALETTE_EVENT,
			handleOpenPaletteEvent,
		);
		localController?.abort();
		remoteController?.abort();
		if (debounceTimer != null) window.clearTimeout(debounceTimer);
		if (pointerHoverTimer != null) window.clearTimeout(pointerHoverTimer);
	};
});
</script>

{#snippet spaceManageLink()}
	<a href="/spaces" class="space-manage-link" title={m.spaces_manage({}, { locale })} aria-label={m.spaces_manage({}, { locale })} onclick={openSpacesManager}>
		<Settings2 class="h-3.5 w-3.5" />
		<span>{m.spaces_manage({}, { locale })}</span>
	</a>
{/snippet}

{#snippet spaceFilterRow()}
	<FilterBar label={m.command_filter_spaces({}, { locale })} role="tablist" activeKey={spaceFilter} trailing={spaceManageLink}>
		{#each SPACE_FILTER_KEYS as key (key)}
			<FilterChip
				id={`command-space-filter-${key}`}
				tone="neutral"
				label={spaceFilterLabel(key)}
				active={spaceFilter === key}
				aria-controls="command-palette-results"
				tabindex={spaceFilter === key ? 0 : -1}
				onclick={() => selectSpaceFilter(key)}
				onkeydown={(event) => handleSpaceFilterKeydown(event, key)}
			/>
		{/each}
	</FilterBar>
{/snippet}

{#snippet emptyState(active: boolean)}
	{@const picker = active && isSpacePickerMode}
	{@const idle = trimmedQuery.length < MIN_QUERY_LENGTH && !hasLabelScope}
	<div class="command-empty">
		<div class="command-empty-mark"><CornerDownRight class="h-4 w-4" /></div>
		<div>
			<div class="text-[13px] font-medium text-text-secondary">
				{#if picker && spaceFilter === "recent"}
					{m.command_no_recent({}, { locale })}
				{:else if picker && spaceFilter === "pinned"}
					{m.command_no_pinned({}, { locale })}
				{:else if picker && spaceFilter === "mine"}
					{m.command_no_owned({}, { locale })}
				{:else if picker && spaceFilter === "archived"}
					{m.spaces_empty_archived({}, { locale })}
				{:else if idle}
					{m.command_lens_ready({}, { locale })}
				{:else}
					{m.command_no_matching({}, { locale })}
				{/if}
			</div>
			<div class="mt-1 text-[12px] text-text-tertiary">
				{#if picker && spaceFilter === "recent"}
					{m.command_recent_hint({}, { locale })}
				{:else if picker && spaceFilter === "pinned"}
					{m.command_pin_hint({}, { locale })}
				{:else if picker && spaceFilter === "archived"}
					{m.spaces_empty_archived_hint({}, { locale })}
				{:else if idle}
					{m.command_try_filters({}, { locale })}
				{:else}
					{m.command_try_other({}, { locale })}
				{/if}
			</div>
		</div>
	</div>
{/snippet}

{#if open}
	<div class="command-palette-root" role="presentation" onmousedown={(event) => { if (event.target === event.currentTarget) closePalette(); }}>
		<div class="command-palette" role="dialog" aria-modal="true" aria-label={title} tabindex="-1" onkeydown={handlePaletteKeydown}>
			<div class="command-header">
				<div class="command-input-row">
					<div class="command-field">
						{#if runMode}
							<TerminalSquare class="h-4 w-4 shrink-0 text-brand" />
						{:else}
							<Search class="h-4 w-4 shrink-0 text-text-tertiary" />
						{/if}
						<input
							bind:this={inputEl}
							value={runMode ? runCommand : query}
							class="command-input"
							{placeholder}
							autocomplete="off"
							spellcheck="false"
							enterkeyhint={runMode ? "go" : "search"}
							oninput={handleCommandInput}
						/>
						{#if runMode ? runCommand : query}
							<button type="button" class="command-clear" aria-label={m.command_clear_query({}, { locale })} title={m.command_clear_query({}, { locale })} onclick={clearInput}>
								<X class="h-3.5 w-3.5" />
							</button>
						{/if}
					</div>
					{#if runMode}
						<div class="command-shortcut">↵ {m.command_run({}, { locale })}</div>
					{:else}
						<div class="command-shortcut">⌘K</div>
					{/if}
					<button type="button" class="command-cancel" onclick={closePalette}>{m.common_cancel({}, { locale })}</button>
				</div>

				{#if showLensBar}
					<CommandPaletteLensBar lens={activeLens} position={lensPosition} glide={lensTabs.glide} onSelect={selectLens} />
				{/if}
			</div>

			{#if runMode}
				<div bind:this={resultsEl} class="command-results command-runner">
					{#if runError}
						<div class="command-empty">
							<div class="command-empty-mark"><CornerDownRight class="h-4 w-4" /></div>
							<div>
								<div class="text-[13px] font-medium text-text-secondary">{runStatus === "failed" ? m.command_failed({}, { locale }) : m.command_run_ready({}, { locale })}</div>
								<div class="mt-1 text-[12px] text-text-tertiary">{runError}</div>
							</div>
						</div>
					{:else if !currentSpaceId}
						<div class="command-empty">
							<div class="command-empty-mark"><CornerDownRight class="h-4 w-4" /></div>
							<div>
								<div class="text-[13px] font-medium text-text-secondary">{m.command_open_space({}, { locale })}</div>
								<div class="mt-1 text-[12px] text-text-tertiary">{m.command_run_needs_space({}, { locale })}</div>
							</div>
						</div>
					{:else if runBlocks.length === 0}
						<div class="command-empty">
							<div class="command-empty-mark"><CornerDownRight class="h-4 w-4" /></div>
							<div>
								<div class="text-[13px] font-medium text-text-secondary">{m.command_ready({}, { locale })}</div>
								<div class="mt-1 text-[12px] text-text-tertiary">{m.command_run_hint({}, { locale })}</div>
							</div>
						</div>
					{:else}
						<ToolCallList content={runBlocks} streaming={runStatus === "running" || runStatus === "queued"} defaultExpanded flush />
					{/if}
				</div>
			{:else}
				<SwipePager
					keys={COMMAND_PALETTE_LENSES}
					index={lensIndex}
					enabled={swipeable}
					onChange={(index) => selectLens(COMMAND_PALETTE_LENSES[index] ?? "all")}
					onPosition={lensTabs.track}
				>
					{#snippet page(index, active)}
						{@const pageLens = COMMAND_PALETTE_LENSES[index] ?? "all"}
						{@const items = active ? renderedItems : previewFor(pageLens)}
						<div
							class="command-results scrollbar-quiet"
							onscroll={active ? handleResultsScroll : undefined}
							{@attach active ? bindResults : undefined}
						>
							{#if swipeable ? pageLens === "space" : isSpacePickerMode}
								<div class="command-subbar">{@render spaceFilterRow()}</div>
							{:else if hasRecentQueries}
								<div class="command-subbar">
									<CommandPaletteRecentQueries queries={recentQueries} onPick={pickRecentQuery} onClear={forgetRecentQueries} />
								</div>
							{/if}
							<div
								class:searching={active && (pending || showingSettledItems)}
								class="command-list"
								id={active ? "command-palette-results" : undefined}
								role="listbox"
								tabindex="-1"
								aria-label={m.command_search_results({}, { locale })}
								ontouchmove={dismissKeyboard}
							>
								{#if !items || (active && items.length === 0 && isSearching)}
									<ListRowSkeleton density="compact" rows={6} label={m.common_loading({}, { locale })} />
								{:else if items.length === 0}
									{@render emptyState(active)}
								{:else}
									{#each items as item, itemIndex (commandItemKey(item))}
										<CommandPaletteResultRow
											{item}
											active={active && itemIndex === activeIndex}
											pinnable={active && isSpacePickerMode && item.type === "space" && !item.isArchived}
											onActivate={() => void activate(item)}
											onHover={() => handleResultPointerMove(itemIndex)}
											onTogglePin={() => togglePin(item)}
										/>
									{/each}
									{#if active && isSpacePickerMode && mergedItemsRaw.length > spaceDisplayLimit}
										<div class="flex items-center justify-center py-2 text-[11px] text-text-tertiary">
											<span>{m.command_showing({ shown: spaceDisplayLimit, total: mergedItemsRaw.length }, { locale })}</span>
										</div>
									{/if}
								{/if}
							</div>
						</div>
					{/snippet}
				</SwipePager>
			{/if}

			<div class="command-footer">
				<div class:error={Boolean(runMode ? runError : remoteError)} class="command-status" role="status" aria-live="polite">
					{#if runMode}
						{#if runStatus === "queued" || runStatus === "running"}<Loader2 class="h-3 w-3 animate-spin text-brand" />{/if}
						<span>{runError || (runStatus === "done" ? m.command_done({ id: runTaskId ?? "" }, { locale }) : runStatus === "running" ? m.command_running({}, { locale }) : runStatus === "queued" ? m.command_queued({}, { locale }) : currentSpaceId ? m.command_press_run({}, { locale }) : m.command_open_space({}, { locale }))}</span>
					{:else}
						{#if isSearching}<Loader2 class="h-3 w-3 animate-spin text-brand" />{/if}
						<span>{statusText}</span>
					{/if}
				</div>
				<div class="command-keys">
					<span>↑↓</span><span>C-n/p</span><span>{m.command_navigate({}, { locale })}</span>
					<span>↵</span><span>{m.command_open_verb({}, { locale })}</span><span>esc</span><span>{m.command_close({}, { locale })}</span>
				</div>
			</div>
		</div>
	</div>
{/if}

<style>
	.command-palette-root {
		position: fixed;
		inset: 0;
		z-index: var(--z-fullscreen);
		display: flex;
		align-items: flex-start;
		justify-content: center;
		padding: clamp(48px, 10vh, 92px) 16px 24px;
		background: color-mix(in oklch, var(--bg-primary) 56%, transparent);
	}

	.command-palette {
		--palette-x: 16px;
		--palette-bg: color-mix(in oklch, var(--bg-surface) 94%, var(--brand-900) 6%);
		width: min(720px, calc(100vw - 32px));
		max-height: min(640px, calc(100vh - 96px));
		display: flex;
		flex-direction: column;
		overflow: hidden;
		border: 1px solid color-mix(in oklch, var(--border-primary) 72%, var(--brand) 8%);
		border-radius: 14px;
		background: var(--palette-bg);
		box-shadow: 0 24px 80px color-mix(in oklch, var(--neutral-100) 74%, transparent), 0 0 0 1px color-mix(in oklch, var(--neutral-0) 4%, transparent) inset;
		animation: command-enter 140ms cubic-bezier(0.16, 1, 0.3, 1);
	}

	.command-header {
		flex-shrink: 0;
		--list-gutter-x: calc(var(--palette-x) - var(--list-row-pad-x));
		padding-bottom: 2px;
		border-bottom: 1px solid var(--border-subtle);
		background: color-mix(in oklch, var(--bg-primary) 30%, transparent);
	}

	.command-input-row {
		display: flex;
		align-items: center;
		gap: 12px;
		padding: 14px var(--palette-x) 8px;
	}

	.command-field {
		display: flex;
		min-width: 0;
		flex: 1;
		align-items: center;
		gap: 12px;
	}

	.command-input {
		min-width: 0;
		flex: 1;
		border: 0;
		outline: 0;
		background: transparent;
		color: var(--text-primary);
		font-size: 15px;
		line-height: 1.4;
	}

	.command-input::placeholder { color: var(--text-placeholder); }

	.command-clear {
		display: grid;
		place-items: center;
		flex: 0 0 auto;
		width: 22px;
		height: 22px;
		border: 0;
		border-radius: 999px;
		background: var(--bg-hover);
		color: var(--text-tertiary);
		cursor: pointer;
		transition: color 90ms cubic-bezier(0.25, 1, 0.5, 1);
	}

	.command-clear:hover { color: var(--text-primary); }

	.command-clear:focus-visible,
	.command-cancel:focus-visible,
	.space-manage-link:focus-visible {
		outline: 2px solid color-mix(in oklch, var(--brand) 42%, transparent);
		outline-offset: -2px;
	}

	.command-cancel {
		display: none;
		flex: 0 0 auto;
		align-items: center;
		min-height: 44px;
		border: 0;
		border-radius: 8px;
		background: transparent;
		padding: 0 6px;
		color: var(--text-secondary);
		font-size: 14px;
		font-weight: 500;
		cursor: pointer;
	}

	.command-cancel:active { color: var(--text-primary); }

	.command-shortcut,
	.command-footer {
		font-family: var(--font-mono);
		letter-spacing: 0.02em;
	}

	.command-shortcut {
		border: 1px solid var(--border-subtle);
		border-radius: 6px;
		padding: 2px 6px;
		color: var(--text-tertiary);
		font-size: 11px;
	}

	.command-results {
		--list-gutter-x: calc(var(--palette-x) - 8px - var(--list-row-pad-x));
		flex: 1 1 auto;
		min-height: 0;
		overflow-y: auto;
		padding: 8px;
	}

	.command-subbar {
		position: sticky;
		top: -8px;
		z-index: 1;
		margin-top: -8px;
		padding-top: 8px;
		background: var(--palette-bg);
	}

	/* 8px + FilterBar height (h-11 / lg:h-9) */
	.command-results:has(> .command-subbar) {
		scroll-padding-top: 52px;
	}

	@media (min-width: 1024px) {
		.command-results:has(> .command-subbar) {
			scroll-padding-top: 44px;
		}
	}

	.command-list {
		transition: opacity 120ms cubic-bezier(0.25, 1, 0.5, 1);
	}

	.command-list.searching {
		opacity: 0.72;
	}

	.command-empty {
		display: flex;
		align-items: center;
		gap: 12px;
		padding: 34px 22px;
	}

	.command-empty-mark {
		display: grid;
		place-items: center;
		width: 34px;
		height: 34px;
		border-radius: 9px;
		background: var(--bg-primary);
		color: var(--text-tertiary);
	}

	.command-footer {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 12px;
		border-top: 1px solid var(--border-subtle);
		padding: 8px 12px;
		color: var(--text-placeholder);
		font-size: 10px;
	}

	.command-keys {
		display: flex;
		flex-shrink: 0;
		align-items: center;
		gap: 8px;
	}

	.space-manage-link {
		display: inline-flex;
		align-items: center;
		gap: 4px;
		height: 28px;
		border-radius: 6px;
		padding: 0 var(--list-row-pad-x);
		color: var(--text-placeholder);
		font-size: 11px;
		transition: background-color 90ms, color 90ms;
	}

	.space-manage-link:hover {
		background: var(--bg-hover);
		color: var(--text-secondary);
	}

	.command-status {
		display: inline-flex;
		min-width: 0;
		align-items: center;
		gap: 6px;
	}

	.command-status span {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.command-status.error {
		color: var(--error-700);
	}

	@keyframes command-enter {
		from { opacity: 0; transform: translateY(-8px) scale(0.985); }
		to { opacity: 1; transform: translateY(0) scale(1); }
	}

	@media (max-width: 640px) {
		.command-palette-root {
			align-items: stretch;
			padding: 0;
			background: var(--bg-primary);
		}

		.command-palette {
			--palette-x: 18px;
			--palette-bg: var(--bg-primary);
			width: 100%;
			max-height: none;
			padding-top: env(safe-area-inset-top, 0px);
			border: 0;
			border-radius: 0;
			box-shadow: none;
			animation: command-screen-enter 160ms cubic-bezier(0.16, 1, 0.3, 1);
		}

		.command-header {
			background: transparent;
		}

		.command-input-row {
			gap: 4px;
			padding: 6px 6px 2px 10px;
		}

		.command-field {
			height: 38px;
			gap: 8px;
			border-radius: 10px;
			background: var(--bg-surface);
			padding: 0 6px 0 10px;
		}

		/* 16px keeps iOS from zooming into the focused field. */
		.command-input {
			font-size: 16px;
		}

		.command-clear {
			width: 28px;
			height: 28px;
			background: transparent;
		}

		.command-shortcut {
			display: none;
		}

		.command-cancel {
			display: inline-flex;
		}

		.command-results {
			flex: 1;
			overscroll-behavior: contain;
			padding-bottom: calc(8px + env(safe-area-inset-bottom, 0px));
		}

		.space-manage-link {
			width: 32px;
			height: 32px;
			justify-content: center;
			border-radius: 7px;
			padding: 0;
		}

		.space-manage-link span {
			display: none;
		}

		.command-footer {
			display: none;
			padding: 10px 14px calc(10px + env(safe-area-inset-bottom, 0px));
		}

		.command-footer:has(.command-status.error) {
			display: flex;
		}

		.command-keys {
			display: none;
		}
	}

	@keyframes command-screen-enter {
		from { opacity: 0; transform: translateY(8px); }
		to { opacity: 1; transform: translateY(0); }
	}

	@media (prefers-reduced-motion: reduce) {
		.command-palette,
		.command-list {
			animation: none;
			transition: none;
		}
	}
</style>
