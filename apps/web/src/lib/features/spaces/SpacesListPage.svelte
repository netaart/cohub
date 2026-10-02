<script lang="ts">
import type { SpaceRecord } from "@neta-art/cohub";
import { Loader2, Plus, Search } from "lucide-svelte";
import { onMount } from "svelte";
import SpaceAvatar from "$lib/components/SpaceAvatar.svelte";
import { getLocale } from "$lib/i18n/locale.svelte";
import { m } from "$lib/paraglide/messages.js";
import { sdk } from "$lib/sdk";
import { buildSpaceRootRoute } from "$lib/space-routes";
import { authStore } from "$lib/stores/auth.svelte";
import { getRecentSpaces } from "$lib/stores/recent-space";
import {
	fetchSpaceListWithCache,
	getCachedSpaceList,
	onSpaceListCacheUpdated,
} from "$lib/stores/space-list-cache";

const locale = $derived(getLocale());

let spaces = $state<SpaceRecord[]>([]);
let query = $state("");
let loading = $state(true);
let loadError = $state("");

function spaceName(space: SpaceRecord) {
	return (
		space.name?.trim() ||
		space.title?.trim() ||
		m.spaces_default_name({}, { locale })
	);
}

/** Most-recently-visited first; the timestamp is local and cheap to read. */
const recentRank = $derived.by(() => {
	const userUuid = authStore.userUuid;
	if (!userUuid) return new Map<string, number>();
	return new Map(
		getRecentSpaces(userUuid).map((entry, index) => [entry.spaceId, index]),
	);
});

const ordered = $derived.by(() => {
	const rank = recentRank;
	return [...spaces].sort((a, b) => {
		if (Boolean(a.isPinned) !== Boolean(b.isPinned)) {
			return a.isPinned ? -1 : 1;
		}
		const rankA = rank.get(a.id);
		const rankB = rank.get(b.id);
		if (rankA !== rankB) {
			if (rankA === undefined) return 1;
			if (rankB === undefined) return -1;
			return rankA - rankB;
		}
		return spaceName(a).localeCompare(spaceName(b));
	});
});

const visible = $derived.by(() => {
	const normalized = query.trim().toLocaleLowerCase();
	if (!normalized) return ordered;
	return ordered.filter((space) =>
		spaceName(space).toLocaleLowerCase().includes(normalized),
	);
});

async function load(force = false) {
	try {
		spaces = await fetchSpaceListWithCache(
			async () => await sdk.spaces.list(),
			{ force },
		);
		loadError = "";
	} catch (error) {
		if (!spaces.length) loadError = m.spaces_load_failed({}, { locale });
		console.warn("[spaces] Failed to load Spaces", error);
	} finally {
		loading = false;
	}
}

function refresh() {
	loading = true;
	loadError = "";
	void load(true);
}

onMount(() => {
	const cached = getCachedSpaceList();
	if (cached?.length) {
		spaces = cached;
		loading = false;
	}
	void (async () => {
		await authStore.ensureLoaded();
		await load();
	})();

	return onSpaceListCacheUpdated(({ spaces: next }) => {
		spaces = next;
	});
});
</script>

<section class="flex h-full min-h-0 flex-1 flex-col overflow-hidden bg-bg-primary">
	<header class="flex h-11 shrink-0 items-center gap-2 border-b border-border-subtle px-3">
		<h1 class="min-w-0 flex-1 truncate text-[13px] font-semibold tracking-tight text-text-primary">
			{m.spaces_title({}, { locale })}
		</h1>
		{#if loading}
			<Loader2 class="h-3.5 w-3.5 shrink-0 animate-spin text-text-placeholder" />
		{/if}
		<a
			href="/spaces/new"
			class="inline-flex h-7 shrink-0 items-center gap-1.5 rounded-[6px] border border-[color:var(--sidebar-primary-action-border)] bg-[var(--sidebar-primary-action-bg)] px-2.5 text-[12px] font-medium text-[var(--sidebar-primary-action-fg)] transition-colors hover:bg-[var(--sidebar-primary-action-bg-hover)]"
		>
			<Plus class="h-3.5 w-3.5" />
			{m.spaces_new({}, { locale })}
		</a>
	</header>

	<div class="shrink-0 px-3 pb-2 pt-2.5">
		<label class="flex h-9 items-center gap-2 rounded-[7px] border border-border-subtle bg-bg-input px-2.5 focus-within:border-brand/40">
			<Search class="h-3.5 w-3.5 shrink-0 text-text-placeholder" />
			<input
				bind:value={query}
				type="search"
				placeholder={m.spaces_search_placeholder({}, { locale })}
				aria-label={m.spaces_search_placeholder({}, { locale })}
				class="min-w-0 flex-1 bg-transparent text-[13px] text-text-primary placeholder:text-text-placeholder focus:outline-none"
			/>
		</label>
	</div>

	<div class="min-h-0 flex-1 overflow-y-auto px-1.5 pb-3">
		{#if loadError && !spaces.length}
			<div class="px-2 py-8 text-center">
				<p class="text-[13px] text-text-secondary">{loadError}</p>
				<button
					type="button"
					class="mt-3 inline-flex items-center rounded-[6px] bg-bg-hover px-3 py-1.5 text-[12px] text-text-secondary transition-colors hover:bg-bg-hover-strong hover:text-text-primary"
					onclick={refresh}
				>
					{m.spaces_retry({}, { locale })}
				</button>
			</div>
		{:else if loading && !spaces.length}
			<div class="flex items-center gap-2 px-2 py-3 text-[12px] text-text-tertiary">
				<Loader2 class="h-3.5 w-3.5 animate-spin" />
				{m.common_loading({}, { locale })}
			</div>
		{:else if !spaces.length}
			<div class="px-2 py-10 text-center">
				<p class="text-[13px] text-text-secondary">{m.spaces_empty_title({}, { locale })}</p>
				<p class="mt-1 text-[12px] text-text-placeholder">{m.spaces_empty_hint({}, { locale })}</p>
				<a
					href="/spaces/new"
					class="mt-4 inline-flex items-center gap-1.5 rounded-[6px] bg-bg-hover px-3 py-1.5 text-[12px] text-text-secondary transition-colors hover:bg-bg-hover-strong hover:text-text-primary"
				>
					<Plus class="h-3.5 w-3.5" />
					{m.spaces_new({}, { locale })}
				</a>
			</div>
		{:else if !visible.length}
			<div class="px-2 py-8 text-center text-[13px] text-text-secondary">
				{m.spaces_empty_search({}, { locale })}
			</div>
		{:else}
			<div class="space-y-[2px]">
				{#each visible as space (space.id)}
					<a
						href={buildSpaceRootRoute(space.id)}
						class="flex items-center gap-2.5 rounded-[var(--sidebar-item-radius)] px-2 py-2 transition-colors duration-100 hover:bg-[var(--sidebar-item-hover-bg)]"
					>
						<SpaceAvatar name={spaceName(space)} profile={space.publicProfile} size="md" />
						<div class="min-w-0 flex-1">
							<div class="truncate text-[13px] font-medium text-text-primary">{spaceName(space)}</div>
							{#if space.description?.trim()}
								<div class="truncate text-[11px] text-text-tertiary">{space.description.trim()}</div>
							{/if}
						</div>
					</a>
				{/each}
			</div>
		{/if}
	</div>
</section>
