<script lang="ts">
import type { SpaceRecord } from "@neta-art/cohub";
import {
	Archive,
	ArchiveRestore,
	CircleCheck,
	Pin,
	PinOff,
	Settings,
	Tag,
} from "lucide-svelte";
import { tick } from "svelte";
import AdaptivePopover from "$lib/components/list-page/AdaptivePopover.svelte";
import { getLocale } from "$lib/i18n/locale.svelte";
import { m } from "$lib/paraglide/messages.js";
import { buildSpaceSettingsRoute } from "$lib/space-routes";

const {
	space,
	name,
	anchor,
	onPin,
	onArchive,
	onLabel,
	onSelect,
	onClose,
}: {
	space: SpaceRecord | null;
	name: string;
	anchor: HTMLElement | null;
	onPin: (space: SpaceRecord) => void;
	onArchive: (space: SpaceRecord) => void;
	onLabel: (space: SpaceRecord) => void;
	onSelect: (space: SpaceRecord) => void;
	onClose: () => void;
} = $props();

const locale = $derived(getLocale());
let menu = $state<HTMLElement | null>(null);

function items() {
	return Array.from(
		menu?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [],
	);
}

const openId = $derived(space?.id ?? null);

$effect(() => {
	if (!openId) return;
	void tick().then(() => items()[0]?.focus({ preventScroll: true }));
});

function onKeydown(event: KeyboardEvent) {
	const list = items();
	const index = list.indexOf(document.activeElement as HTMLElement);
	const next =
		event.key === "ArrowDown"
			? (index + 1) % list.length
			: event.key === "ArrowUp"
				? (index - 1 + list.length) % list.length
				: event.key === "Home"
					? 0
					: event.key === "End"
						? list.length - 1
						: null;
	if (next === null) return;
	event.preventDefault();
	list[next]?.focus();
}

function run(action: (space: SpaceRecord) => void) {
	if (space) action(space);
}
</script>

<AdaptivePopover open={space !== null} {anchor} {onClose} label={name} width={200} placement="bottom-end">
	{#if space}
		<div bind:this={menu} class="flex flex-col" role="menu" tabindex="-1" aria-label={name} onkeydown={onKeydown}>
			<button type="button" class="menu-option" role="menuitem" onclick={() => run(onPin)}>
				{#if space.isPinned}<PinOff class="h-3.5 w-3.5" />{:else}<Pin class="h-3.5 w-3.5" />{/if}
				<span>{space.isPinned ? m.command_unpin({}, { locale }) : m.command_pin({}, { locale })}</span>
			</button>
			<button type="button" class="menu-option" role="menuitem" onclick={() => run(onArchive)}>
				{#if space.isArchived}<ArchiveRestore class="h-3.5 w-3.5" />{:else}<Archive class="h-3.5 w-3.5" />{/if}
				<span>{space.isArchived ? m.spaces_unarchive({}, { locale }) : m.spaces_archive({}, { locale })}</span>
			</button>
			<button type="button" class="menu-option" role="menuitem" onclick={() => run(onLabel)}>
				<Tag class="h-3.5 w-3.5" />
				<span>{m.spaces_label_add({}, { locale })}…</span>
			</button>
			{#if space.relation !== "public"}
				<a href={buildSpaceSettingsRoute(space.id)} class="menu-option" role="menuitem" onclick={onClose}>
					<Settings class="h-3.5 w-3.5" />
					<span>{m.sidebar_space_settings({}, { locale })}</span>
				</a>
			{/if}
			<div class="mx-1 my-1 h-px bg-border-subtle" role="separator"></div>
			<button type="button" class="menu-option" role="menuitem" onclick={() => run(onSelect)}>
				<CircleCheck class="h-3.5 w-3.5" />
				<span>{m.spaces_select({}, { locale })}</span>
			</button>
		</div>
	{/if}
</AdaptivePopover>

<style>
	.menu-option {
		display: flex;
		min-height: 30px;
		width: 100%;
		align-items: center;
		gap: 8px;
		border-radius: 6px;
		padding: 0 8px;
		text-align: left;
		font-size: 12px;
		color: var(--text-secondary);
		transition: background-color 90ms, color 90ms;
	}

	.menu-option:hover,
	.menu-option:focus-visible {
		background: var(--bg-hover);
		color: var(--text-primary);
		outline: none;
	}
</style>
