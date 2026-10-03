<script lang="ts">
import type { LabelListItem, SpaceRecord } from "@neta-art/cohub";
import { Archive, Check, Loader2, Pin, Plus, Search, X } from "lucide-svelte";
import { onMount } from "svelte";
import {
	getCachedSpacePage,
	setCachedSpacePage,
} from "$lib/cache/space-list-page-cache";
import SpaceAvatar from "$lib/components/SpaceAvatar.svelte";
import { getLocale } from "$lib/i18n/locale.svelte";
import { m } from "$lib/paraglide/messages.js";
import { sdk } from "$lib/sdk";
import { buildSpaceRootRoute } from "$lib/space-routes";
import { authStore } from "$lib/stores/auth.svelte";
import { getRecentSpaces } from "$lib/stores/recent-space";
import { toggleSpaceArchive } from "$lib/stores/space-pins.svelte";

const locale = $derived(getLocale());
type Filter = "recent" | "all" | "mine" | "pinned" | "archived";
const filters: Filter[] = ["recent", "all", "mine", "pinned", "archived"];
let filter = $state<Filter>("recent");
let spaces = $state<SpaceRecord[]>([]);
let labels = $state<LabelListItem[]>([]);
let query = $state("");
let cursor = $state<string | null>(null);
let hasMore = $state(false);
let loading = $state(true);
let loadingMore = $state(false);
let error = $state("");
let scrollTop = $state(0);
let viewportHeight = $state(600);
let selected = $state(new Set<string>());
let busy = $state(false);
let requestGeneration = 0;
let labelName = $state("");
let debounce: ReturnType<typeof setTimeout> | undefined;
const ROW_HEIGHT = 58;
const start = $derived(Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - 5));
const end = $derived(
	Math.min(
		spaces.length,
		Math.ceil((scrollTop + viewportHeight) / ROW_HEIGHT) + 5,
	),
);
const visible = $derived(spaces.slice(start, end));
const topSpacer = $derived(start * ROW_HEIGHT);
const bottomSpacer = $derived(Math.max(0, (spaces.length - end) * ROW_HEIGHT));

function labelFor(filterName: Filter) {
	switch (filterName) {
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

async function load(reset = false) {
	if (loadingMore && !reset) return;
	const generation = reset ? ++requestGeneration : requestGeneration;
	if (reset) {
		cursor = null;
		selected = new Set();
		loading = true;
		error = "";
		const cached = await getCachedSpacePage(filter, query).catch(() => null);
		if (generation === requestGeneration && cached) {
			spaces = cached.items.filter((space) =>
				filter === "archived" ? space.isArchived : !space.isArchived,
			);
		}
	} else loadingMore = true;
	try {
		const page = await sdk.spaces.list({
			limit: 50,
			cursor: reset ? null : cursor,
			filter,
			query,
			recentSpaces: recentSpaces(),
		});
		if (generation !== requestGeneration) return;
		if (reset) await setCachedSpacePage(filter, query, page);
		if (generation !== requestGeneration) return;
		spaces = reset ? page.items : [...spaces, ...page.items];
		cursor = page.pageInfo.nextCursor;
		hasMore = page.pageInfo.hasMore;
		error = "";
	} catch (e) {
		if (generation !== requestGeneration) return;
		error =
			e instanceof Error ? e.message : m.spaces_load_failed({}, { locale });
	} finally {
		if (generation === requestGeneration) {
			loading = false;
			loadingMore = false;
		}
	}
}
function searchChanged() {
	clearTimeout(debounce);
	debounce = setTimeout(() => void load(true), 250);
}
function selectFilter(value: Filter) {
	filter = value;
	void load(true);
}
function toggleSelection(id: string) {
	const next = new Set(selected);
	if (next.has(id)) next.delete(id);
	else next.add(id);
	selected = next;
}
function onScroll(event: Event) {
	const element = event.currentTarget as HTMLElement;
	scrollTop = element.scrollTop;
	viewportHeight = element.clientHeight;
	if (
		hasMore &&
		!loadingMore &&
		element.scrollHeight - element.scrollTop - element.clientHeight <
			ROW_HEIGHT * 8
	)
		void load();
}
async function pinSelection() {
	if (!selected.size) return;
	busy = true;
	try {
		const ids = [...selected];
		const unpin = ids.every(
			(id) => spaces.find((space) => space.id === id)?.isPinned,
		);
		await sdk.user.labels.patchResources(
			ids,
			unpin
				? { removeLabelRefs: ["Pinned"] }
				: { addLabelRefs: ["Pinned"], removeLabelRefs: ["Archived"] },
		);
		await load(true);
	} catch (e) {
		error =
			e instanceof Error ? e.message : m.spaces_update_failed({}, { locale });
	} finally {
		busy = false;
	}
}

async function archiveSelection(archive: boolean) {
	if (!selected.size) return;
	busy = true;
	try {
		await toggleSpaceArchive([...selected], archive);
		await load(true);
	} catch (e) {
		error =
			e instanceof Error ? e.message : m.spaces_update_failed({}, { locale });
	} finally {
		busy = false;
	}
}
async function addLabel() {
	const name = labelName.trim();
	if (!name || !selected.size) return;
	busy = true;
	try {
		await sdk.user.labels.patchResources([...selected], {
			addLabelRefs: [name],
		});
		const result = await sdk.user.labels.list();
		labels = result.labels;
		labelName = "";
		selected = new Set();
	} catch (e) {
		error =
			e instanceof Error
				? e.message
				: m.spaces_apply_label_failed({}, { locale });
	} finally {
		busy = false;
	}
}

onMount(() => {
	void load(true);
	void sdk.user.labels
		.list()
		.then((result) => {
			labels = result.labels;
		})
		.catch(() => undefined);
	const refreshOnReturn = () => {
		if (document.visibilityState === "visible") void load(true);
	};
	window.addEventListener("focus", refreshOnReturn);
	document.addEventListener("visibilitychange", refreshOnReturn);
	const unsubscribeRealtime = sdk.onUserEvent((event) => {
		if (
			event.type === "space.list.changed" ||
			(event.type === "label.assignments.updated" &&
				event.payload.resourceType === "space")
		)
			void load(true);
	});
	return () => {
		unsubscribeRealtime();
		window.removeEventListener("focus", refreshOnReturn);
		document.removeEventListener("visibilitychange", refreshOnReturn);
		clearTimeout(debounce);
	};
});
</script>

<section class="flex h-full min-h-0 flex-1 flex-col overflow-hidden bg-bg-primary">
	<header class="flex h-11 shrink-0 items-center gap-2 border-b border-border-subtle px-3">
		<h1 class="min-w-0 flex-1 truncate text-[13px] font-semibold text-text-primary">{m.spaces_title({}, { locale })}</h1>
		{#if loading}<Loader2 class="h-3.5 w-3.5 animate-spin text-text-placeholder" />{/if}
		<a href="/spaces/new" class="inline-flex h-7 items-center gap-1.5 rounded-[6px] bg-brand px-2.5 text-[12px] font-medium text-brand-contrast-fg"><Plus class="h-3.5 w-3.5" />{m.spaces_new({}, { locale })}</a>
	</header>
	<div class="shrink-0 px-3 pb-2 pt-2.5">
		<label class="flex h-9 items-center gap-2 rounded-[7px] border border-border-subtle bg-bg-input px-2.5 focus-within:border-brand/40">
			<Search class="h-3.5 w-3.5 text-text-placeholder" /><input bind:value={query} oninput={searchChanged} type="search" placeholder={m.spaces_search_placeholder({}, { locale })} aria-label={m.spaces_search_placeholder({}, { locale })} class="min-w-0 flex-1 bg-transparent text-[13px] text-text-primary placeholder:text-text-placeholder focus:outline-none" />
		</label>
		<div class="mt-2 flex gap-1 overflow-x-auto" role="tablist" aria-label={m.spaces_title({}, { locale })}>
			{#each filters as value (value)}<button type="button" role="tab" aria-selected={filter === value} class="shrink-0 rounded-[5px] px-2 py-1 text-[11px] {filter === value ? 'bg-bg-hover text-text-primary' : 'text-text-tertiary hover:bg-bg-hover hover:text-text-secondary'}" onclick={() => selectFilter(value)}>{labelFor(value)}</button>{/each}
		</div>
	</div>
	{#if selected.size}
		<div class="flex shrink-0 flex-wrap items-center gap-2 border-y border-border-subtle px-3 py-2">
			<span class="text-[12px] text-text-secondary">{m.label_selected_count({ count: selected.size }, { locale })}</span>
			<button type="button" disabled={busy} class="inline-flex items-center gap-1 text-[12px] text-text-secondary hover:text-text-primary" onclick={() => void pinSelection()}><Pin class="h-3.5 w-3.5" />{m.command_pinned({}, { locale })}</button>
			{#if filter !== "archived"}<button type="button" disabled={busy} class="inline-flex items-center gap-1 text-[12px] text-text-secondary hover:text-text-primary" onclick={() => void archiveSelection(true)}><Archive class="h-3.5 w-3.5" />{m.spaces_archive({}, { locale })}</button>{:else}<button type="button" disabled={busy} class="inline-flex items-center gap-1 text-[12px] text-text-secondary hover:text-text-primary" onclick={() => void archiveSelection(false)}><Archive class="h-3.5 w-3.5" />{m.spaces_unarchive({}, { locale })}</button>{/if}
			<form class="flex min-w-0 items-center gap-1" onsubmit={(event) => { event.preventDefault(); void addLabel(); }}><input bind:value={labelName} list="space-label-options" placeholder={m.spaces_label_placeholder({}, { locale })} class="h-7 w-32 rounded-[5px] border border-border-subtle bg-bg-input px-2 text-[11px] text-text-primary" /><datalist id="space-label-options">{#each labels as label (label.id)}<option value={label.name}></option>{/each}</datalist><button type="submit" disabled={busy || !labelName.trim()} class="text-[11px] text-text-secondary hover:text-text-primary">{m.spaces_label_add({}, { locale })}</button></form>
			<button type="button" aria-label={m.common_close({}, { locale })} class="ml-auto p-1 text-text-tertiary" onclick={() => selected = new Set()}><X class="h-3.5 w-3.5" /></button>
		</div>
	{/if}
	{#if error}<div class="flex shrink-0 items-center gap-3 px-3 py-2 text-[12px] text-error-fg" role="alert"><span class="min-w-0 flex-1">{error}</span><button type="button" class="shrink-0 text-text-secondary underline underline-offset-2 hover:text-text-primary" onclick={() => void load(true)}>{m.spaces_retry({}, { locale })}</button></div>{/if}
	<div class="min-h-0 flex-1 overflow-y-auto" onscroll={onScroll}>
		{#if loading && !spaces.length}<div class="flex items-center gap-2 px-3 py-4 text-[12px] text-text-tertiary"><Loader2 class="h-3.5 w-3.5 animate-spin" />{m.common_loading({}, { locale })}</div>
		{:else if !spaces.length}<div class="px-3 py-10 text-center text-[13px] text-text-secondary">{query ? m.spaces_empty_search({}, { locale }) : m.spaces_empty_title({}, { locale })}</div>
		{:else}<div style={`height:${topSpacer}px`}></div>{#each visible as space (space.id)}<div class="flex h-[58px] items-center gap-2 border-b border-border-subtle/50 px-2.5 hover:bg-bg-hover">
			<button type="button" aria-label={m.spaces_selected_aria({ name: nameOf(space) }, { locale })} aria-pressed={selected.has(space.id)} class="flex h-7 w-7 shrink-0 items-center justify-center text-text-tertiary hover:text-text-primary" onclick={() => toggleSelection(space.id)}>{#if selected.has(space.id)}<Check class="h-4 w-4 text-brand" />{:else}<span class="h-3.5 w-3.5 rounded-[3px] border border-border-default"></span>{/if}</button>
			<a href={buildSpaceRootRoute(space.id)} class="flex min-w-0 flex-1 items-center gap-2.5"><SpaceAvatar name={nameOf(space)} profile={space.publicProfile} size="md" /><span class="min-w-0 flex-1"><span class="block truncate text-[13px] font-medium text-text-primary">{nameOf(space)}</span>{#if space.description?.trim()}<span class="block truncate text-[11px] text-text-tertiary">{space.description}</span>{/if}</span></a>
			{#if space.isPinned}<Pin class="h-3.5 w-3.5 shrink-0 text-brand" />{/if}
			{#if space.isArchived}<span class="text-[10px] text-text-tertiary">{m.spaces_archived({}, { locale })}</span>{/if}
		</div>{/each}<div style={`height:${bottomSpacer}px`}></div>{#if loadingMore}<div class="flex justify-center py-3"><Loader2 class="h-4 w-4 animate-spin text-text-placeholder" /></div>{/if}{/if}
	</div>
</section>
