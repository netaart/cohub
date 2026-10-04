<script lang="ts">
import type { ContentBlock } from "@cohub/protocol/core";
import type { PaletteOverviewResponse, SpaceRecord } from "@neta-art/cohub";
import {
	CornerDownRight,
	FolderKanban,
	Loader2,
	MessageSquare,
	Pin,
	Plus,
	Search,
	Settings2,
	Tag,
	TerminalSquare,
} from "lucide-svelte";
import { onMount, tick } from "svelte";
import { goto } from "$app/navigation";
import { page } from "$app/state";
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
import { searchLocalCommandItems } from "$lib/command-palette/local-search";
import {
	mergeCommandResults,
	sameCommandItemSequence,
} from "$lib/command-palette/merge-results";
import {
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
import { searchRemoteCommandItems } from "$lib/command-palette/remote-search";
import {
	getRemoteResourceTypes,
	typeLabelFor,
} from "$lib/command-palette/scope";
import type { CommandPaletteItem } from "$lib/command-palette/types";
import SpaceAvatar from "$lib/components/SpaceAvatar.svelte";
import {
	SETTINGS_SECTION_ICONS,
	settingsSectionLabel,
} from "$lib/components/settings-section";
import ToolCallList from "$lib/components/ToolCallList.svelte";
import UserAvatar from "$lib/components/UserAvatar.svelte";
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

const MIN_QUERY_LENGTH = 2;
const locale = $derived(getLocale());
const RESULT_LIMIT = 30;
const DEBOUNCE_MS = 180;
const POINTER_HOVER_ARM_MS = 220;

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

function defaultPlaceholder() {
	return m.command_placeholder({}, { locale });
}

let open = $state(false);
let query = $state("");
let title = $state("");
let placeholder = $state("");
let openIntent = $state<CommandPaletteIntent>("navigate");
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
	query;
	open;
	spaceDisplayLimit = SPACE_PAGE_SIZE;
});

const currentSpaceId = $derived.by(() => {
	const match = page.url.pathname.match(/^\/spaces\/([^/]+)/);
	const id = match?.[1] ?? null;
	return id === "new" ? null : id;
});
const parsedQuery = $derived(parseCommandPaletteQuery(query));
const searchPlan = $derived({
	query: parsedQuery.query,
	resourceTypes: parsedQuery.resourceTypes,
	labelRef: parsedQuery.labelRef,
});
const trimmedQuery = $derived(searchPlan.query.trim());
const hasLabelScope = $derived(
	Boolean(searchPlan.labelRef && searchPlan.resourceTypes?.includes("label")),
);
const typeLabel = $derived(typeLabelFor(searchPlan.resourceTypes));
const isSpacePickerMode = $derived(
	openIntent === "new-chat" ||
		(searchPlan.resourceTypes?.length === 1 &&
			searchPlan.resourceTypes[0] === "space"),
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
	// Only the space picker "Recent" tab uses the overview-backed list. The
	// plain palette default list and every other picker tab stay on the local
	// legacy derivation, which reads the same IndexedDB caches the old default
	// list used (no overview snapshot, no overview refetch).
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
const renderedItems = $derived(
	mergedItems.length > 0 || !isSearching ? mergedItems : settledItems,
);
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

function profileFor(item: CommandPaletteItem) {
	if (item.type !== "space") return null;
	return item.ownerProfile?.userUuid && item.ownerProfile.displayName
		? item.ownerProfile
		: null;
}

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
	const value = (event.currentTarget as HTMLInputElement).value;
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
	query = value;
	// Searching should search the full Space set; Recent remains the empty-query
	if (value.trim() && isSpacePickerMode && spaceFilter !== "archived")
		spaceFilter = "all";
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

function typeMeta(type: CommandPaletteItem["type"]) {
	if (type === "turn") return { className: "turn", icon: MessageSquare };
	if (type === "session") return { className: "session", icon: TerminalSquare };
	if (type === "label") return { className: "label", icon: Tag };
	if (type === "command") return { className: "command", icon: Plus };
	return { className: "space", icon: FolderKanban };
}

function contextFor(item: CommandPaletteItem) {
	if (item.type === "command")
		return item.excerpt ?? m.command_ctx_command({}, { locale });
	if (item.type === "space")
		return item.excerpt ?? m.command_ctx_space({}, { locale });
	if (item.type === "label")
		return `${m.command_ctx_label({ label: item.labelRef ?? item.labelName ?? "Label" }, { locale })}${item.spaceName ? ` · ${item.spaceName}` : ""}`;
	if (item.type === "session")
		return item.spaceName ?? m.command_ctx_session({}, { locale });
	return `${item.spaceName ?? "Space"}${item.sessionTitle ? ` / ${item.sessionTitle}` : ""} · ${m.command_ctx_turn({ n: item.sequence ?? "?" }, { locale })}`;
}

function itemTimestamp(item: CommandPaletteItem) {
	if (!item.updatedAt) return null;
	const date = new Date(item.updatedAt);
	const time = date.getTime();
	if (!Number.isFinite(time)) return null;

	const now = new Date();
	const isSameLocalDay =
		date.getFullYear() === now.getFullYear() &&
		date.getMonth() === now.getMonth() &&
		date.getDate() === now.getDate();
	const pad = (value: number) => String(value).padStart(2, "0");
	const dateLabel = `${date.getFullYear()}.${pad(date.getMonth() + 1)}.${pad(date.getDate())}`;
	const timeLabel = `${pad(date.getHours())}:${pad(date.getMinutes())}`;
	const timezoneLabel = new Intl.DateTimeFormat(undefined, {
		timeZoneName: "short",
	})
		.formatToParts(date)
		.find((part) => part.type === "timeZoneName")?.value;

	return {
		label: isSameLocalDay ? timeLabel : dateLabel,
		title: `${dateLabel} ${timeLabel}${timezoneLabel ? ` ${timezoneLabel}` : ""}`,
	};
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

function openPalette(detail?: OpenCommandPaletteDetail) {
	title = detail?.title ?? m.command_title({}, { locale });
	placeholder = detail?.placeholder ?? defaultPlaceholder();
	query = detail?.query ?? "";
	openIntent = detail?.intent ?? "navigate";
	spaceFilter = getCachedSpaceFilterPref();
	activeIndex = 0;
	armPointerHover();
	resetRunState();
	open = true;
	void tick().then(() => inputEl?.focus());
	warmSpacePickerCache();
}

function closePalette() {
	open = false;
	query = "";
	title = m.command_title({}, { locale });
	placeholder = defaultPlaceholder();
	openIntent = "navigate";
	spaceFilter = getCachedSpaceFilterPref();
	activeIndex = 0;
	settledItems = [];
	archivedItems = [];
	searchToken += 1;
	localController?.abort();
	remoteController?.abort();
	resetRunState();
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
		// Only the space picker "Recent" tab consumes the overview payload. The
		// plain palette default list (no query, no `a:`) and the other picker
		// tabs stay on the pre-overview local derivation, which reads the same
		// IndexedDB / space-list caches as before — no overview snapshot, no
		// overview refetch, no snapshot-driven re-sort.
		const useOverviewDefaults = isSpacePickerMode && spaceFilter === "recent";
		// The space list cache feeds both paths; keep it fresh (the helper checks
		// its own staleness unless forced).
		if (useOverviewDefaults) {
			// First frame = last server payload (the cached overview snapshot)
			// folded with local caches: device visits and viewer-authored turns
			// re-rank it, and newly cached spaces/sessions are merged in. The
			// frame therefore tracks what the refetched response will say, so the
			// swap-in does not visibly re-sort the list. Only when no snapshot
			// exists at all does the frame fall back to a purely local synthesis.
			const snapshot = getPaletteOverviewSnapshot();
			const snapshotData = snapshot.data;
			const hasSnapshotItems = Boolean(
				snapshotData?.spaces.length || snapshotData?.recentSessions.length,
			);
			void getLocalPaletteOverview({
				signal: defaultSignal,
				viewerUserUuid: myUserUuid,
			})
				.then((local) =>
					snapshotData && hasSnapshotItems
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
			// Detached from the search signal: the refetch survives tab/query changes
			// (aborting it here previously delayed the correct list by a full
			// re-request cycle). Revalidation is throttled and skipped while the
			// snapshot is fresh — viewer activity is folded in locally at render
			// time, so most opens land here with nothing to fetch. The fresh server
			// response is authoritative and replaces the merged frame in place.
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
		// Explicit `t:` lens keeps raw turn rows; otherwise the server groups
		// turns per session (one best turn each).
		const explicitTurnOnly =
			plan.resourceTypes?.length === 1 && plan.resourceTypes[0] === "turn";
		void searchRemoteCommandItems(q, {
			signal: remoteController?.signal,
			limit: RESULT_LIMIT,
			types: remoteResourceTypes,
			spaceId: remoteSearchSpaceId(spaceId, remoteResourceTypes),
			labelRef: plan.labelRef,
			groupTurns: !explicitTurnOnly,
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
	title = m.command_run_title({}, { locale });
	placeholder = m.command_run_placeholder({}, { locale });
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
			rememberCommandItem(item);
			closePalette();
			await goto(buildUserNewSessionRoute(item.spaceId), {
				keepFocus: true,
				noScroll: true,
			});
			return;
		}
		if (item.type === "command" && item.id === "new-space") {
			await openCommandItem(item);
			closePalette();
			return;
		}
		// Ignore sessions/labels/turns — keep palette open for a real space pick.
		return;
	}
	await openCommandItem(item);
	closePalette();
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
				title = m.command_title({}, { locale });
				placeholder = defaultPlaceholder();
				runStatus = "idle";
				return;
			}
		}
		closePalette();
		return;
	}
	if (isComposingKeyboardEvent(event)) return;
	if ((event.target as HTMLElement | null)?.getAttribute("role") === "tab")
		return;
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
	if (activeIndex >= renderedItems.length)
		activeIndex = Math.max(renderedItems.length - 1, 0);
});

$effect(() => {
	activeIndex;
	renderedItems.length;
	void scrollActiveIntoView();
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

{#if open}
	<div class="command-palette-root" role="presentation" onmousedown={(event) => { if (event.target === event.currentTarget) closePalette(); }}>
		<div class="command-palette" role="dialog" aria-modal="true" aria-label={title} tabindex="-1" onkeydown={handlePaletteKeydown}>
			<div class="command-input-row">
				{#if runMode}
					<TerminalSquare class="h-4 w-4 text-brand" />
				{:else}
					<Search class="h-4 w-4 text-text-tertiary" />
				{/if}
				<input
					bind:this={inputEl}
					value={runMode ? runCommand : query}
					class="command-input"
					placeholder={placeholder}
					autocomplete="off"
					spellcheck="false"
					oninput={handleCommandInput}
				/>
				{#if runMode}
					<div class="command-shortcut">↵ {m.command_run({}, { locale })}</div>
				{:else}
					<div class="command-shortcut">⌘K</div>
				{/if}
			</div>

			{#if isSpacePickerMode && !runMode}
				<div class="space-filter-row">
				<div class="space-filter-bar" role="tablist" aria-orientation="horizontal" aria-label={m.command_filter_spaces({}, { locale })}>
					{#each SPACE_FILTER_KEYS as key (key)}
						<button
							id={`command-space-filter-${key}`}
							type="button"
							class="space-filter-btn"
							class:active={spaceFilter === key}
							role="tab"
							aria-selected={spaceFilter === key}
							aria-controls="command-palette-results"
							tabindex={spaceFilter === key ? 0 : -1}
							onclick={() => selectSpaceFilter(key)}
							onkeydown={(event) => handleSpaceFilterKeydown(event, key)}
						>{spaceFilterLabel(key)}</button>
					{/each}
				</div>
				<a href="/spaces" class="space-manage-link" title={m.spaces_manage({}, { locale })} aria-label={m.spaces_manage({}, { locale })} onclick={closePalette}>
					<Settings2 class="h-3.5 w-3.5" />
					<span>{m.spaces_manage({}, { locale })}</span>
				</a>
				</div>
			{/if}

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
				<div id="command-palette-results" bind:this={resultsEl} class:searching={showingSettledItems} class="command-results" role="listbox" aria-label={m.command_search_results({}, { locale })} onscroll={handleResultsScroll}>
					{#if renderedItems.length === 0}
						<div class="command-empty">
							<div class="command-empty-mark"><CornerDownRight class="h-4 w-4" /></div>
							<div>
								<div class="text-[13px] font-medium text-text-secondary">
									{#if isSpacePickerMode && spaceFilter === "recent"}
										{m.command_no_recent({}, { locale })}
									{:else if isSpacePickerMode && spaceFilter === "pinned"}
										{m.command_no_pinned({}, { locale })}
									{:else if isSpacePickerMode && spaceFilter === "mine"}
										{m.command_no_owned({}, { locale })}
									{:else if isSpacePickerMode && spaceFilter === "archived"}
										{m.spaces_empty_archived({}, { locale })}
									{:else if trimmedQuery.length < MIN_QUERY_LENGTH && !hasLabelScope}
										{m.command_lens_ready({}, { locale })}
									{:else}
										{m.command_no_matching({}, { locale })}
									{/if}
								</div>
								<div class="mt-1 text-[12px] text-text-tertiary">
									{#if isSpacePickerMode && spaceFilter === "recent"}
										{m.command_recent_hint({}, { locale })}
									{:else if isSpacePickerMode && spaceFilter === "pinned"}
										{m.command_pin_hint({}, { locale })}
									{:else if isSpacePickerMode && spaceFilter === "archived"}
										{m.spaces_empty_archived_hint({}, { locale })}
									{:else if trimmedQuery.length < MIN_QUERY_LENGTH && !hasLabelScope}
										{m.command_try_filters({}, { locale })}
									{:else}
										{m.command_try_other({}, { locale })}
									{/if}
								</div>
							</div>
						</div>
					{:else}
						{#each renderedItems as item, index (`${item.type}:${item.id || item.turnId || item.sessionId || item.spaceId}`)}
							{@const meta = typeMeta(item.type)}
							{@const section = settingsCommandSection(item)}
							{@const Icon = section ? SETTINGS_SECTION_ICONS[section] : meta.icon}
							{@const profile = profileFor(item)}
							{@const timestamp = itemTimestamp(item)}
							<div
								class:active={index === activeIndex}
								class="command-result"
								onpointermove={() => handleResultPointerMove(index)}
								role="option"
								aria-selected={index === activeIndex}
								tabindex="-1"
							>
								<button
									type="button"
									class="command-result-main"
									onclick={() => void activate(item)}
								>
									{#if item.type === "space"}
										<SpaceAvatar name={item.title || item.spaceName || item.spaceId} profile={item.spaceProfile} size="sm" />
									{:else}
										<div class={`command-type-mark ${meta.className}`} aria-label={item.type}>
											<Icon class="h-3.5 w-3.5" />
										</div>
									{/if}
									<div class="min-w-0 flex-1 text-left">
										<div class="flex min-w-0 items-center gap-2">
											<span class="truncate text-[13px] font-medium text-text-primary">{item.title}</span>
										</div>
										<div class="command-context-row">
											{#if profile}
												<span class="command-profile" title={profile.displayName}>
													<UserAvatar name={profile.displayName} avatarUrl={profile.avatarUrl} size="xxs" class="border-0 bg-bg-primary text-[8px]" />
													<span class="truncate">{profile.displayName}</span>
												</span>
												<span class="command-context-separator">·</span>
											{/if}
											<span class="command-context" title={contextFor(item)}>{contextFor(item)}</span>
											{#if timestamp}
												<span class="command-context-separator">·</span>
												<time class="command-time" datetime={item.updatedAt ?? undefined} title={timestamp.title}>{timestamp.label}</time>
											{/if}
										</div>
									</div>
									<div class="command-enter">↵</div>
								</button>
								{#if isSpacePickerMode && item.type === "space" && !item.isArchived}
									<button
										type="button"
										class="command-pin-btn"
										class:pinned={item.isPinned}
										title={item.isPinned ? m.command_unpin({}, { locale }) : m.command_pin({}, { locale })}
										aria-label={item.isPinned ? m.command_unpin_item({ title: item.title }, { locale }) : m.command_pin_item({ title: item.title }, { locale })}
										onclick={(e) => {
									e.stopPropagation();
									const wasPinned = item.isPinned ?? false;
									syncPinStateInItems(item.spaceId, !wasPinned);
									void toggleSpacePin(item.spaceId).catch((err) => {
										console.warn("[palette] pin toggle failed", err);
										syncPinStateInItems(item.spaceId, wasPinned);
									});
								}}
									>
										<Pin class="h-3.5 w-3.5" />
									</button>
								{/if}
							</div>
						{/each}
						{#if isSpacePickerMode && mergedItemsRaw.length > spaceDisplayLimit}
							<div class="flex items-center justify-center py-2 text-[11px] text-text-tertiary">
								<span>{m.command_showing({ shown: spaceDisplayLimit, total: mergedItemsRaw.length }, { locale })}</span>
							</div>
						{/if}
					{/if}
				</div>
			{/if}

			<div class="command-footer">
				<div class:error={Boolean(runError)} class="command-status" role="status" aria-live="polite">
					{#if runMode}
						{#if runStatus === "queued" || runStatus === "running"}<Loader2 class="h-3 w-3 animate-spin text-brand" />{/if}
						<span>{runError || (runStatus === "done" ? m.command_done({ id: runTaskId ?? "" }, { locale }) : runStatus === "running" ? m.command_running({}, { locale }) : runStatus === "queued" ? m.command_queued({}, { locale }) : currentSpaceId ? m.command_press_run({}, { locale }) : m.command_open_space({}, { locale }))}</span>
					{:else}
						{#if isSearching}<Loader2 class="h-3 w-3 animate-spin text-brand" />{/if}
						<span>{statusText}</span>
					{/if}
				</div>
				<div class="hidden items-center gap-2 sm:flex"><span>↑↓</span><span>C-n/p</span><span>{m.command_navigate({}, { locale })}</span><span>↵</span><span>{m.command_open_verb({}, { locale })}</span><span>esc</span><span>{m.command_close({}, { locale })}</span></div>
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
		width: min(720px, calc(100vw - 32px));
		max-height: min(640px, calc(100vh - 96px));
		display: flex;
		flex-direction: column;
		overflow: hidden;
		border: 1px solid color-mix(in oklch, var(--border-primary) 72%, var(--brand) 8%);
		border-radius: 14px;
		background: color-mix(in oklch, var(--bg-surface) 94%, var(--brand-900) 6%);
		box-shadow: 0 24px 80px color-mix(in oklch, var(--neutral-100) 74%, transparent), 0 0 0 1px color-mix(in oklch, var(--neutral-0) 4%, transparent) inset;
		animation: command-enter 140ms cubic-bezier(0.16, 1, 0.3, 1);
	}

	.command-input-row {
		display: flex;
		align-items: center;
		gap: 12px;
		padding: 14px 16px;
		border-bottom: 1px solid var(--border-subtle);
		background: color-mix(in oklch, var(--bg-primary) 30%, transparent);
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

	.command-shortcut,
	.command-enter,
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
		overflow-y: auto;
		padding: 8px;
		transition: opacity 120ms cubic-bezier(0.25, 1, 0.5, 1);
	}

	.command-results.searching {
		opacity: 0.72;
	}

	.command-result {
		position: relative;
		display: flex;
		width: 100%;
		align-items: center;
		gap: 4px;
		border: 0;
		border-radius: 9px;
		background: transparent;
		padding: 6px 6px;
		color: inherit;
		transition: background-color 90ms cubic-bezier(0.25, 1, 0.5, 1), transform 90ms cubic-bezier(0.25, 1, 0.5, 1);
	}

	.command-result-main {
		display: flex;
		align-items: center;
		gap: 12px;
		min-width: 0;
		flex: 1;
		border: 0;
		background: transparent;
		color: inherit;
		padding: 4px 4px;
		border-radius: 7px;
		cursor: pointer;
	}

	.command-result-main:focus-visible {
		outline: 2px solid color-mix(in oklch, var(--brand) 42%, transparent);
		outline-offset: -2px;
	}

	.command-pin-btn {
		display: grid;
		place-items: center;
		flex: 0 0 auto;
		width: 28px;
		height: 28px;
		border: 0;
		border-radius: 7px;
		background: transparent;
		color: var(--text-tertiary);
		opacity: 0;
		cursor: pointer;
		transition: opacity 90ms cubic-bezier(0.25, 1, 0.5, 1), background-color 90ms cubic-bezier(0.25, 1, 0.5, 1), color 90ms cubic-bezier(0.25, 1, 0.5, 1);
	}

	.command-pin-btn:focus-visible {
		opacity: 1;
		outline: 2px solid color-mix(in oklch, var(--brand) 42%, transparent);
		outline-offset: -2px;
	}

	.command-pin-btn.pinned {
		opacity: 1;
		color: var(--brand);
	}

	.command-pin-btn:hover {
		opacity: 1;
		background: var(--bg-hover);
		color: var(--brand);
	}

	.command-pin-btn:active {
		transform: scale(0.92);
	}

	.command-result.active .command-pin-btn { opacity: 1; }
	.command-result.active .command-pin-btn:not(.pinned) { color: var(--text-tertiary); }

	.command-result::before {
		content: "";
		position: absolute;
		left: 0;
		top: 8px;
		bottom: 8px;
		width: 2px;
		border-radius: 999px;
		background: transparent;
	}

	.command-result.active { background: color-mix(in oklch, var(--brand-bg) 56%, var(--bg-hover) 44%); }
	.command-result.active::before { background: var(--brand); }
	.command-result.active .command-enter {
		opacity: 1;
	}
	.command-result.active .command-time { color: var(--text-secondary); }
	.command-result.active .command-type-mark { border-color: color-mix(in oklch, currentColor 36%, transparent); }

	.command-type-mark {
		display: grid;
		place-items: center;
		width: 28px;
		height: 28px;
		border: 1px solid color-mix(in oklch, currentColor 18%, transparent);
		border-radius: 7px;
		background: color-mix(in oklch, currentColor 10%, var(--bg-primary) 90%);
		color: var(--text-tertiary);
	}

	.command-type-mark.space {
		color: var(--brand);
		background: color-mix(in oklch, var(--brand) 12%, var(--bg-primary) 88%);
	}

	.command-type-mark.session {
		color: color-mix(in oklch, var(--text-secondary) 82%, var(--brand) 18%);
		background: color-mix(in oklch, var(--text-secondary) 8%, var(--bg-primary) 92%);
	}

	.command-type-mark.turn {
		color: color-mix(in oklch, var(--text-tertiary) 72%, var(--brand) 28%);
		background: color-mix(in oklch, var(--text-tertiary) 7%, var(--bg-primary) 93%);
	}

	.command-type-mark.label {
		color: color-mix(in oklch, var(--brand) 76%, var(--text-secondary) 24%);
		background: color-mix(in oklch, var(--brand) 9%, var(--bg-primary) 91%);
	}

	.command-type-mark.command {
		color: var(--brand);
		background: color-mix(in oklch, var(--brand) 10%, var(--bg-primary) 90%);
	}

	.command-context-row {
		margin-top: 2px;
		display: flex;
		min-width: 0;
		align-items: center;
		gap: 6px;
		color: var(--text-tertiary);
		font-size: 12px;
		line-height: 1.35;
	}

	.command-profile {
		display: inline-flex;
		min-width: 0;
		max-width: min(190px, 42%);
		flex-shrink: 0;
		align-items: center;
		gap: 5px;
		color: color-mix(in oklch, var(--text-secondary) 86%, var(--brand) 14%);
	}

	.command-context {
		min-width: 0;
		flex: 0 1 auto;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.command-context-separator {
		flex: 0 0 auto;
		color: var(--text-placeholder);
	}

	.command-time {
		flex: 0 0 auto;
		color: var(--text-placeholder);
		font-family: var(--font-mono);
		font-size: 10px;
		font-variant-numeric: tabular-nums;
		letter-spacing: 0.01em;
		line-height: 1;
		white-space: nowrap;
	}

	.command-enter {
		width: 12px;
		flex: 0 0 auto;
		opacity: 0;
		color: var(--brand);
		font-size: 13px;
		line-height: 1;
		text-align: right;
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

	.space-filter-row {
		display: flex;
		align-items: center;
		gap: 8px;
		padding: 6px 8px;
		border-bottom: 1px solid var(--border-subtle);
	}

	.space-filter-bar {
		display: flex;
		min-width: 0;
		gap: 2px;
	}

	.space-manage-link {
		display: inline-flex;
		flex-shrink: 0;
		align-items: center;
		gap: 4px;
		margin-left: auto;
		border-radius: 6px;
		padding: 4px 8px;
		color: var(--text-placeholder);
		font-size: 11px;
		transition: background-color 90ms, color 90ms;
	}

	.space-manage-link:hover {
		background: var(--bg-hover);
		color: var(--text-secondary);
	}

	.space-filter-btn {
		min-height: 36px;
		border: 0;
		border-radius: 6px;
		background: transparent;
		padding: 4px 12px;
		color: var(--text-tertiary);
		font-size: 12px;
		font-weight: 500;
		cursor: pointer;
		transition: background-color 90ms, color 90ms;
	}

	.space-filter-btn:hover {
		background: var(--bg-hover);
		color: var(--text-secondary);
	}

	.space-filter-btn.active {
		background: color-mix(in oklch, var(--brand) 12%, var(--bg-primary) 88%);
		color: var(--brand);
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
			align-items: flex-end;
			padding: 0;
			background: var(--overlay-scrim);
		}

		.command-palette {
			width: 100vw;
			max-height: min(82svh, 680px);
			border-right: 0;
			border-bottom: 0;
			border-left: 0;
			border-radius: 16px 16px 0 0;
			animation-name: command-sheet-enter;
		}

		.command-palette::before {
			content: "";
			align-self: center;
			width: 36px;
			height: 4px;
			margin-top: 8px;
			border-radius: 999px;
			background: var(--border-primary);
		}

		.command-input-row {
			padding: 12px 14px 13px;
		}

		.command-shortcut,
		.command-enter {
			display: none;
		}

		.command-result {
			min-height: 58px;
			gap: 6px;
			padding: 8px 8px;
		}

		.space-filter-btn {
			min-height: 44px;
		}

		.space-manage-link {
			min-width: 44px;
			min-height: 44px;
			justify-content: center;
		}

		.space-manage-link span {
			display: none;
		}

		.command-type-mark {
			width: 32px;
			height: 32px;
		}

		.command-pin-btn,
		.command-pin-btn:not(.pinned) {
			width: 44px;
			height: 44px;
			opacity: 1;
		}

		.command-footer {
			padding: 10px 14px calc(10px + env(safe-area-inset-bottom));
		}
	}

	@keyframes command-sheet-enter {
		from { opacity: 0; transform: translateY(14px); }
		to { opacity: 1; transform: translateY(0); }
	}

	@media (prefers-reduced-motion: reduce) {
		.command-palette,
		.command-results,
		.command-result {
			animation: none;
			transition: none;
		}
	}
</style>
