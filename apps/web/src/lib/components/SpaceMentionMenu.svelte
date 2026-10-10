<script lang="ts">
import { CornerDownLeft, Loader2, SearchSlash } from "lucide-svelte";
import ListRowText from "$lib/components/list-page/ListRowText.svelte";
import { LIST_ROW_AVATAR } from "$lib/components/list-page/list-row";
import SpaceAvatar from "$lib/components/SpaceAvatar.svelte";
import {
	COMPOSER_MENU_LAYER,
	type ComposerMenuPlacement,
} from "$lib/composer-expansion";
import { getLocale } from "$lib/i18n/locale.svelte";
import type { SpaceMentionSuggestion } from "$lib/mentions/space";
import { m } from "$lib/paraglide/messages.js";

type Props = {
	open?: boolean;
	placement?: ComposerMenuPlacement;
	items?: SpaceMentionSuggestion[];
	query?: string;
	selectedIndex?: number;
	loading?: boolean;
	status?: string;
	onselect?: (item: SpaceMentionSuggestion) => void;
	onhighlight?: (index: number) => void;
};

const locale = $derived(getLocale());

let {
	open = false,
	placement = "above",
	items = [],
	query = "",
	selectedIndex = 0,
	loading = false,
	status = m.mention_another({}, { locale }),
	onselect,
	onhighlight,
}: Props = $props();

const layer = $derived(COMPOSER_MENU_LAYER[placement]);
let desktopListEl = $state<HTMLDivElement | null>(null);
let mobileListEl = $state<HTMLDivElement | null>(null);

const normalizedQuery = $derived(query.trim().toLowerCase());
const selectedItem = $derived(items[selectedIndex]);

function itemId(index: number) {
	return `space-mention-option-${index}`;
}

function highlightParts(text: string): Array<{ text: string; match: boolean }> {
	if (!normalizedQuery) return [{ text, match: false }];
	const lower = text.toLowerCase();
	const index = lower.indexOf(normalizedQuery);
	if (index === -1) return [{ text, match: false }];
	return [
		{ text: text.slice(0, index), match: false },
		{ text: text.slice(index, index + normalizedQuery.length), match: true },
		{ text: text.slice(index + normalizedQuery.length), match: false },
	].filter((part) => part.text.length > 0);
}

function hasOwnerProfile(item: SpaceMentionSuggestion) {
	return Boolean(item.ownerProfile?.userUuid);
}

function ownerLabel(item: SpaceMentionSuggestion) {
	return (
		item.ownerProfile?.displayName ??
		m.mention_creator_unavailable({}, { locale })
	);
}

function secondaryText(item: SpaceMentionSuggestion) {
	return item.description;
}

function scrollSelectedIntoView(container: HTMLDivElement | null) {
	if (!container || !open) return;
	container
		.querySelector<HTMLElement>(`#${itemId(selectedIndex)}`)
		?.scrollIntoView({ block: "nearest" });
}

$effect(() => {
	selectedIndex;
	items.length;
	open;
	requestAnimationFrame(() => {
		scrollSelectedIntoView(desktopListEl);
		scrollSelectedIntoView(mobileListEl);
	});
});
</script>

{#snippet owner(item: SpaceMentionSuggestion)}
	{#if hasOwnerProfile(item)}
		<span class="min-w-0 truncate">{m.mention_by({}, { locale })} {ownerLabel(item)}</span>
	{:else}
		<span class="min-w-0 truncate text-text-placeholder">{m.mention_creator_unavailable({}, { locale })}</span>
	{/if}
{/snippet}

{#if open}
	<div class={`pointer-events-none absolute inset-x-0 z-40 hidden ${layer.desktop}`} role="presentation">
		<div class={`pointer-events-auto mx-1 w-[min(580px,calc(100vw-3rem))] ${layer.card} overflow-hidden rounded-[18px] border border-border-subtle/90 bg-bg-content shadow-[0_18px_60px_rgba(15,23,42,0.18)] outline-none transition-all duration-150 ease-out motion-safe:animate-in motion-safe:fade-in motion-safe:slide-in-from-bottom-1`} role="listbox" aria-label={m.mention_aria({}, { locale })} aria-activedescendant={selectedItem ? itemId(selectedIndex) : undefined} tabindex="-1">
			<div class="flex items-center justify-between gap-3 border-b border-border-subtle/70 px-3 py-2.5">
				<div class="min-w-0">
					<div class="text-[12px] font-medium leading-4 text-text-primary">{m.mention_spaces({}, { locale })}</div>
					<div class="mt-0.5 truncate text-[11px] leading-4 text-text-tertiary">{status}</div>
				</div>
				<div class="flex shrink-0 items-center gap-1.5 rounded-full border border-border-subtle bg-bg-primary px-2 py-1 text-[10px] text-text-tertiary">
					{#if loading}
						<Loader2 class="h-3 w-3 animate-spin text-brand" />
					{:else}
						<span>{m.mention_tab({}, { locale })}</span><span class="text-text-placeholder">{m.mention_or({}, { locale })}</span><CornerDownLeft class="h-3 w-3" />
					{/if}
				</div>
			</div>

			<div bind:this={desktopListEl} class="max-h-[320px] min-h-0 overflow-y-auto py-1.5" data-drawer-swipe-ignore>
				{#if loading && items.length === 0}
					<div class="flex items-center gap-2 px-3 py-3 text-[12px] text-text-tertiary"><Loader2 class="h-3.5 w-3.5 animate-spin text-brand" /><span>{m.mention_searching_spaces({}, { locale })}</span></div>
				{:else if items.length === 0}
					<div class="px-4 py-7 text-center">
						<div class="mx-auto flex h-9 w-9 items-center justify-center rounded-full border border-border-subtle bg-bg-primary text-text-tertiary"><SearchSlash class="h-4 w-4" /></div>
						<div class="mt-3 text-[12px] font-medium text-text-primary">{m.mention_none({}, { locale })}</div>
						<div class="mt-1 text-[11px] text-text-tertiary">{m.mention_hint_public({}, { locale })}</div>
					</div>
				{:else}
					<div class="px-2">
						<div class="px-2 pb-1 pt-1 text-[10px] font-medium uppercase tracking-[0.16em] text-text-placeholder">{m.mention({}, { locale })}</div>
						<div class="space-y-0.5">
							{#each items as item, index (item.spaceId)}
								{@const active = index === selectedIndex}
								{@const description = secondaryText(item)}
								<button id={itemId(index)} type="button" role="option" aria-selected={active} data-density="compact" class={`group relative flex h-[var(--list-row-height)] w-full items-center gap-[var(--list-row-gap)] rounded-[11px] px-2.5 text-left transition-colors duration-100 ${active ? 'bg-brand/7' : 'hover:bg-bg-hover'}`} onpointerenter={() => onhighlight?.(index)} onpointerdown={(event) => event.preventDefault()} onclick={() => onselect?.(item)}>
									<span class={`absolute left-0 top-2 bottom-2 w-0.5 rounded-full transition-opacity ${active ? 'bg-brand opacity-100' : 'opacity-0'}`}></span>
									<SpaceAvatar name={item.name} profile={item.spaceProfile} seed={item.spaceId} size={LIST_ROW_AVATAR.compact} />
									<ListRowText tooltip={item.name}>
										{#snippet title()}{#each highlightParts(item.name) as part}<span class={part.match ? 'text-brand' : ''}>{part.text}</span>{/each}{/snippet}
										{#snippet badge()}<span class="shrink-0 text-[10px] uppercase tracking-[0.12em] text-text-placeholder">{m.mention_space({}, { locale })}</span>{/snippet}
										{#snippet lead()}{@render owner(item)}{#if description}<span class="text-text-placeholder">·</span>{/if}{/snippet}
										{#snippet subtitle()}{description}{/snippet}
									</ListRowText>
									<span class={`flex h-5 w-5 shrink-0 items-center justify-center rounded border border-border-subtle text-text-tertiary transition-opacity ${active ? 'opacity-100' : 'opacity-0'}`}><CornerDownLeft class="h-3 w-3" /></span>
								</button>
							{/each}
						</div>
					</div>
				{/if}
			</div>
		</div>
	</div>

	<div class={`absolute inset-x-0 z-40 md:hidden ${layer.mobile}`}>
		<div class={`pointer-events-auto mx-1 ${layer.card} overflow-hidden rounded-[22px] border border-border-subtle bg-bg-content shadow-[0_18px_50px_rgba(15,23,42,0.24)] transition-all duration-150 motion-safe:animate-in motion-safe:fade-in motion-safe:slide-in-from-bottom-1`}>
			<div class="border-b border-border-subtle px-4 py-3">
				<div class="flex items-center justify-between gap-3">
					<div class="min-w-0"><div class="text-[12px] font-medium text-text-primary">{m.mention_spaces({}, { locale })}</div><div class="mt-0.5 truncate text-[11px] text-text-tertiary">{status}</div></div>
					{#if loading}<Loader2 class="h-3.5 w-3.5 shrink-0 animate-spin text-brand" />{/if}
				</div>
			</div>
			<div bind:this={mobileListEl} class="max-h-[min(45vh,360px)] min-h-0 overflow-y-auto py-1" data-drawer-swipe-ignore>
				{#if items.length === 0}
					<div class="px-4 py-6 text-center"><div class="text-[12px] font-medium text-text-primary">{m.mention_none({}, { locale })}</div><div class="mt-1 text-[11px] text-text-tertiary">{m.mention_hint_typing({}, { locale })}</div></div>
				{:else}
					{#each items as item, index (item.spaceId)}
						{@const active = index === selectedIndex}
						<button id={itemId(index)} type="button" data-density="compact" class={`flex h-[var(--list-row-height)] w-full items-center gap-[var(--list-row-gap)] px-4 text-left transition-colors active:bg-bg-hover ${active ? 'bg-brand/7' : ''}`} onpointerdown={(event) => event.preventDefault()} onclick={() => onselect?.(item)}>
							<SpaceAvatar name={item.name} profile={item.spaceProfile} seed={item.spaceId} size={LIST_ROW_AVATAR.compact} />
							<ListRowText title={item.name} tooltip={item.name}>
								{#snippet lead()}{@render owner(item)}{/snippet}
							</ListRowText>
						</button>
					{/each}
				{/if}
			</div>
		</div>
	</div>
{/if}
