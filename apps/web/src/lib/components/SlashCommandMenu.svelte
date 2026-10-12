<script lang="ts">
import type { SkillCatalogEntry } from "@neta-art/cohub";
import { CornerDownLeft, Loader2, SearchSlash } from "lucide-svelte";
import {
	COMPOSER_MENU_LAYER,
	type ComposerMenuPlacement,
} from "$lib/composer-expansion";
import { getLocale } from "$lib/i18n/locale.svelte";
import { m } from "$lib/paraglide/messages.js";

export type SlashCommandMenuItem = {
	kind: "prompt" | "skill";
	name: string;
	description: string;
	scope: SkillCatalogEntry["scope"];
	source?: SkillCatalogEntry["source"];
	argumentHint?: string;
	category?: string;
	matchScore?: number;
};

type GroupedCommand = {
	label: string;
	items: Array<{ item: SlashCommandMenuItem; index: number }>;
};

type Props = {
	items?: SlashCommandMenuItem[];
	query?: string;
	open?: boolean;
	placement?: ComposerMenuPlacement;
	selectedIndex?: number;
	loading?: boolean;
	onselect?: (item: SlashCommandMenuItem) => void;
	onhighlight?: (index: number) => void;
};

let {
	items = [],
	query = "",
	open = false,
	placement = "above",
	selectedIndex = 0,
	loading = false,
	onselect,
	onhighlight,
}: Props = $props();

const layer = $derived(COMPOSER_MENU_LAYER[placement]);
let desktopListEl = $state<HTMLDivElement | null>(null);
let mobileListEl = $state<HTMLDivElement | null>(null);

const locale = $derived(getLocale());
const normalizedQuery = $derived(query.trim().toLowerCase());
const selectedItem = $derived(items[selectedIndex]);
const groupedCommands = $derived.by<GroupedCommand[]>(() => {
	const groups = new Map<
		string,
		Array<{ item: SlashCommandMenuItem; index: number }>
	>();
	items.forEach((item, index) => {
		const label =
			item.kind === "skill"
				? commandSourceLabel(item)
				: item.category || item.scope || "Commands";
		const group = groups.get(label) ?? [];
		group.push({ item, index });
		groups.set(label, group);
	});
	return [...groups.entries()].map(([label, groupItems]) => ({
		label,
		items: groupItems,
	}));
});

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

function itemId(index: number) {
	return `slash-command-option-${index}`;
}

function commandLabel(item: SlashCommandMenuItem) {
	return item.kind === "skill" ? `skill:${item.name}` : item.name;
}

function commandSourceLabel(item: SlashCommandMenuItem) {
	if (item.kind !== "skill") return item.category ?? item.scope;
	if (item.category) return item.category;
	if (item.source?.type === "mod")
		return m.slash_mod({ slug: item.source.mountSlug }, { locale });
	return m.slash_skill({ scope: item.scope }, { locale });
}

function commandScopeLabel(item: SlashCommandMenuItem) {
	return commandSourceLabel(item);
}

function itemKey(item: SlashCommandMenuItem) {
	return `${item.kind}:${item.name}`;
}

function scrollSelectedIntoView(container: HTMLDivElement | null) {
	if (!container || !open) return;
	const active = container.querySelector<HTMLElement>(
		`#${itemId(selectedIndex)}`,
	);
	active?.scrollIntoView({ block: "nearest" });
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

{#if open}
	<div
		class={`pointer-events-none absolute inset-x-0 z-40 hidden ${layer.desktop}`}
		role="presentation"
	>
		<div
			class={`pointer-events-auto mx-1 w-[min(560px,calc(100vw-3rem))] ${layer.card} overflow-hidden rounded-[18px] border border-border-subtle/90 bg-bg-content shadow-[0_18px_60px_rgba(15,23,42,0.18)] outline-none transition-all duration-150 ease-out motion-safe:animate-in motion-safe:fade-in motion-safe:slide-in-from-bottom-1`}
			role="listbox"
			aria-label={m.slash_aria({}, { locale })}
			aria-activedescendant={selectedItem ? itemId(selectedIndex) : undefined}
			tabindex="-1"
		>
			<div class="flex items-center justify-between gap-3 border-b border-border-subtle/70 px-3 py-2.5">
				<div class="min-w-0">
					<div class="text-[12px] font-medium leading-4 text-text-primary">{m.slash_commands({}, { locale })}</div>
					<div class="mt-0.5 truncate text-[11px] leading-4 text-text-tertiary">
						{#if normalizedQuery}
							{m.slash_filtering({ q: normalizedQuery }, { locale })}
						{:else}
							{m.slash_narrow({}, { locale })}
						{/if}
					</div>
				</div>
				<div class="flex shrink-0 items-center gap-1.5 rounded-full border border-border-subtle bg-bg-primary px-2 py-1 text-[10px] text-text-tertiary">
					<span>{m.slash_tab({}, { locale })}</span>
					<span class="text-text-placeholder">{m.slash_or({}, { locale })}</span>
					<CornerDownLeft class="h-3 w-3" />
				</div>
			</div>

			<div bind:this={desktopListEl} class="max-h-[320px] min-h-0 overflow-y-auto py-1.5" data-drawer-swipe-ignore>
				{#if loading && items.length === 0}
					<div class="flex items-center gap-2 px-3 py-3 text-[12px] text-text-tertiary">
						<Loader2 class="h-3.5 w-3.5 animate-spin text-brand" />
						<span>{m.slash_loading({}, { locale })}</span>
					</div>
				{:else if items.length === 0}
					<div class="px-4 py-7 text-center">
						<div class="mx-auto flex h-9 w-9 items-center justify-center rounded-full border border-border-subtle bg-bg-primary text-text-tertiary">
							<SearchSlash class="h-4 w-4" />
						</div>
						<div class="mt-3 text-[12px] font-medium text-text-primary">{m.slash_none({}, { locale })}</div>
						<div class="mt-1 text-[11px] text-text-tertiary">{m.slash_hint_msg({}, { locale })}</div>
					</div>
				{:else}
					{#each groupedCommands as group (group.label)}
						<div class="px-2 pb-1 pt-1 first:pt-0">
							<div class="px-2 pb-1 pt-1 text-[10px] font-medium uppercase tracking-[0.16em] text-text-placeholder">
								{group.label}
							</div>
							<div class="space-y-0.5">
								{#each group.items as entry (itemKey(entry.item))}
									{@const active = entry.index === selectedIndex}
									{@const label = commandLabel(entry.item)}
									<button
										id={itemId(entry.index)}
										type="button"
										role="option"
										aria-selected={active}
										class={`group relative flex w-full items-center gap-3 rounded-[11px] px-2.5 py-2 text-left transition-colors duration-100 ${active ? 'bg-brand/7 text-text-primary' : 'text-text-secondary hover:bg-bg-hover hover:text-text-primary'}`}
										onpointerenter={() => onhighlight?.(entry.index)}
										onpointerdown={(event) => event.preventDefault()}
										onclick={() => onselect?.(entry.item)}
									>
										<span class={`absolute left-0 top-2 bottom-2 w-0.5 rounded-full transition-opacity ${active ? 'bg-brand opacity-100' : 'opacity-0'}`}></span>
										<span class={`flex h-7 w-7 shrink-0 items-center justify-center rounded-[8px] border text-[13px] font-semibold transition-colors ${active ? 'border-brand/25 bg-brand/10 text-brand' : 'border-border-subtle bg-bg-primary text-text-tertiary group-hover:text-text-secondary'}`}>/</span>
										<span class="min-w-0 flex-1">
											<span class="flex min-w-0 items-baseline gap-2">
												<span class="truncate text-[13px] font-medium leading-5">
													<span class="text-text-tertiary">/</span>{#each highlightParts(label) as part}<span class={part.match ? 'text-brand' : ''}>{part.text}</span>{/each}
												</span>
												{#if entry.item.argumentHint}
													<span class="truncate text-[11px] leading-4 text-text-tertiary">{entry.item.argumentHint}</span>
												{/if}
											</span>
											<span class="mt-0.5 block truncate text-[11px] leading-4 text-text-tertiary">{entry.item.description}</span>
										</span>
										<span class="flex shrink-0 items-center gap-2">
											{#if commandScopeLabel(entry.item)}
												<span class="rounded-full border border-border-subtle px-1.5 py-0.5 text-[10px] leading-3 text-text-tertiary">{commandScopeLabel(entry.item)}</span>
											{/if}
											<span class={`flex h-5 w-5 items-center justify-center rounded border border-border-subtle text-text-tertiary transition-opacity ${active ? 'opacity-100' : 'opacity-0'}`}>
												<CornerDownLeft class="h-3 w-3" />
											</span>
										</span>
									</button>
								{/each}
							</div>
						</div>
					{/each}
				{/if}
			</div>
		</div>
	</div>

	<div class={`absolute inset-x-0 z-40 md:hidden ${layer.mobile}`}>
		<div class={`pointer-events-auto mx-1 ${layer.card} overflow-hidden rounded-[22px] border border-border-subtle bg-bg-content shadow-[0_18px_50px_rgba(15,23,42,0.24)] transition-all duration-150 motion-safe:animate-in motion-safe:fade-in motion-safe:slide-in-from-bottom-1`}>
			<div class="border-b border-border-subtle px-4 py-3">
				<div class="flex items-center justify-between gap-3">
					<div class="min-w-0">
						<div class="text-[12px] font-medium text-text-primary">{m.slash_commands({}, { locale })}</div>
						<div class="mt-0.5 truncate text-[11px] text-text-tertiary">
							{normalizedQuery ? `Filtering /${normalizedQuery}` : '{m.slash_tap_insert({}, { locale })}'}
						</div>
					</div>
					{#if loading}
						<Loader2 class="h-3.5 w-3.5 shrink-0 animate-spin text-brand" />
					{/if}
				</div>
			</div>
			<div bind:this={mobileListEl} class="max-h-[min(45vh,360px)] min-h-0 overflow-y-auto py-1" data-drawer-swipe-ignore>
				{#if loading && items.length === 0}
					<div class="flex min-h-16 items-center gap-2 px-4 py-3 text-[12px] text-text-tertiary">
						<Loader2 class="h-3.5 w-3.5 animate-spin text-brand" />
						<span>{m.slash_loading({}, { locale })}</span>
					</div>
				{:else if items.length === 0}
					<div class="px-4 py-6 text-center">
						<div class="text-[12px] font-medium text-text-primary">{m.slash_none({}, { locale })}</div>
						<div class="mt-1 text-[11px] text-text-tertiary">{m.slash_hint_msg_mobile({}, { locale })}</div>
					</div>
				{:else}
					{#each items as item, index (itemKey(item))}
						{@const active = index === selectedIndex}
						{@const label = commandLabel(item)}
						<button
							id={itemId(index)}
							type="button"
							class={`flex min-h-14 w-full items-center gap-3 px-4 py-3 text-left transition-colors active:bg-bg-hover ${active ? 'bg-brand/7' : ''}`}
							onpointerdown={(event) => event.preventDefault()}
							onclick={() => onselect?.(item)}
						>
							<span class={`flex h-8 w-8 shrink-0 items-center justify-center rounded-[9px] border text-[13px] font-semibold ${active ? 'border-brand/25 bg-brand/10 text-brand' : 'border-border-subtle bg-bg-primary text-text-tertiary'}`}>/</span>
							<span class="min-w-0 flex-1">
								<span class="flex min-w-0 items-baseline gap-2 text-[13px] text-text-primary">
									<span class="shrink-0 font-medium"><span class="text-text-tertiary">/</span>{label}</span>
									{#if item.argumentHint}
										<span class="truncate text-[12px] text-text-tertiary">{item.argumentHint}</span>
									{/if}
								</span>
								<span class="mt-0.5 block truncate text-[11px] text-text-tertiary">{item.description}</span>
							</span>
							{#if commandScopeLabel(item)}
								<span class="shrink-0 rounded-full border border-border-subtle px-1.5 py-0.5 text-[10px] text-text-tertiary">{commandScopeLabel(item)}</span>
							{/if}
						</button>
					{/each}
				{/if}
			</div>
		</div>
	</div>
{/if}
