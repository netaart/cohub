<script lang="ts">
import type { SpaceRecord } from "@neta-art/cohub";
import { Check, Pin, Plus } from "lucide-svelte";
import ListRow from "$lib/components/list-page/ListRow.svelte";
import ListRowSkeleton from "$lib/components/list-page/ListRowSkeleton.svelte";
import ListRowText from "$lib/components/list-page/ListRowText.svelte";
import {
	LIST_ROW_AVATAR,
	LIST_ROW_HEIGHT,
	type ListRowDensity,
} from "$lib/components/list-page/list-row";
import SpaceAvatar from "$lib/components/SpaceAvatar.svelte";
import type { SpacesFilter } from "$lib/features/spaces/spaces-filter";
import { longPress } from "$lib/gestures/long-press";
import { getLocale } from "$lib/i18n/locale.svelte";
import { scrollListToTop } from "$lib/layout/list-scroll-top";
import { scrollMemory } from "$lib/layout/scroll-memory";
import { m } from "$lib/paraglide/messages.js";
import { buildSpaceRootRoute } from "$lib/space-routes";
import { formatCompactAbsoluteTime } from "$lib/time-format";

const {
	filter,
	spaces,
	loading,
	loadingMore = false,
	error = false,
	compact,
	selected,
	onToggle,
	onLoadMore,
}: {
	filter: SpacesFilter;
	spaces: SpaceRecord[];
	loading: boolean;
	loadingMore?: boolean;
	error?: boolean;
	compact: boolean;
	selected: ReadonlySet<string>;
	onToggle: (id: string, event?: MouseEvent) => void;
	onLoadMore?: () => void;
} = $props();

const OVERSCAN_ROWS = 6;
const LOAD_MORE_ROWS = 8;

const locale = $derived(getLocale());
const density = $derived<ListRowDensity>(compact ? "comfortable" : "compact");
const rowHeight = $derived(LIST_ROW_HEIGHT[density]);
const selecting = $derived(selected.size > 0);
let scroller = $state<HTMLDivElement | null>(null);
let scrollTop = $state(0);
let viewportHeight = $state(600);
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

export function scrollToTop() {
	scrollListToTop(scroller);
}

function emptyCopy(value: SpacesFilter) {
	switch (value) {
		case "mine":
			return {
				title: m.spaces_empty_mine({}, { locale }),
				hint: m.spaces_empty_hint({}, { locale }),
			};
		case "pinned":
			return {
				title: m.spaces_empty_pinned({}, { locale }),
				hint: m.spaces_empty_pinned_hint({}, { locale }),
			};
		case "archived":
			return {
				title: m.spaces_empty_archived({}, { locale }),
				hint: m.spaces_empty_archived_hint({}, { locale }),
			};
		default:
			return {
				title: m.spaces_empty_title({}, { locale }),
				hint: m.spaces_empty_hint({}, { locale }),
			};
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

function nameOf(space: SpaceRecord) {
	return (
		space.name?.trim() ||
		space.title?.trim() ||
		m.spaces_default_name({}, { locale })
	);
}

function handleRowClick(event: MouseEvent, id: string) {
	if (!selecting) return;
	event.preventDefault();
	onToggle(id, event);
}

function onScroll(event: Event) {
	const element = event.currentTarget as HTMLElement;
	scrollTop = element.scrollTop;
	if (
		onLoadMore &&
		element.scrollHeight - element.scrollTop - element.clientHeight <
			rowHeight * LOAD_MORE_ROWS
	)
		onLoadMore();
}
</script>

{#snippet avatar(space: SpaceRecord, name: string, isSelected: boolean)}
	<SpaceAvatar {name} profile={space.publicProfile} size={LIST_ROW_AVATAR[density]} />
	<span
		class="absolute -bottom-1 -right-1 flex h-[18px] w-[18px] items-center justify-center rounded-full border-2 border-bg-primary transition-[opacity,transform] duration-150 {isSelected ? 'bg-brand text-brand-contrast-fg' : 'bg-bg-elevated text-transparent ring-1 ring-inset ring-border-primary'} {isSelected || selecting ? 'opacity-100' : compact ? 'scale-90 opacity-0' : 'scale-90 opacity-0 group-hover/row:scale-100 group-hover/row:opacity-100 group-focus-within/row:opacity-100'}"
		aria-hidden="true"
	>
		<Check class="h-2.5 w-2.5" strokeWidth={3.5} />
	</span>
{/snippet}

<div
	bind:this={scroller}
	bind:clientHeight={viewportHeight}
	class="min-h-0 flex-1 overflow-x-hidden overflow-y-auto overscroll-y-contain py-1.5"
	onscroll={onScroll}
	use:scrollMemory={{ key: `spaces:${filter}`, ready: spaces.length > 0 }}
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
					use:longPress={{ onLongPress: () => onToggle(space.id) }}
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
									onclick={(event) => onToggle(space.id, event)}
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

<style>
	.space-row {
		-webkit-touch-callout: none;
		-webkit-user-select: none;
		user-select: none;
	}
</style>
