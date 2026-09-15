<script lang="ts">
/**
 * Source filter for the cross-space chats inbox.
 *
 * This filters `session.source` (where a chat came from), not the labels a user
 * assigns in a space. The list is the full source vocabulary — every origin is
 * always selectable, regardless of whether it has rows yet.
 */
import type { UserSessionSourceKey } from "@neta-art/cohub";
import { Check, ChevronDown } from "lucide-svelte";
import { onMount } from "svelte";
import { floatNear } from "$lib/actions/portal";

const {
	selected,
	onChange,
}: {
	selected: readonly UserSessionSourceKey[];
	onChange: (next: UserSessionSourceKey[]) => void;
} = $props();

const SOURCES: Array<{ key: UserSessionSourceKey; label: string }> = [
	{ key: "web", label: "Web App" },
	{ key: "public_api", label: "Public API" },
	{ key: "scheduled_task", label: "Scheduled Task" },
	{ key: "space_hook", label: "Hook" },
	{ key: "websocket", label: "Websocket" },
	{ key: "cli", label: "CLI" },
	{ key: "feishu", label: "Feishu" },
	{ key: "wechat", label: "WeChat" },
	{ key: "discord", label: "Discord" },
	{ key: "qq", label: "QQ" },
	{ key: "other", label: "Other" },
];

let open = $state(false);
let rootEl = $state<HTMLDivElement | null>(null);
let menuEl = $state<HTMLDivElement | null>(null);

const allSelected = $derived(selected.length === 0);
const selectionLabel = $derived.by(() => {
	if (allSelected) return "any";
	if (selected.length === 1) return sourceLabel(selected[0]);
	return `${selected.length} sources`;
});

function sourceLabel(key: string) {
	return SOURCES.find((source) => source.key === key)?.label ?? key;
}

function toggle(key: UserSessionSourceKey) {
	const next = selected.includes(key)
		? selected.filter((candidate) => candidate !== key)
		: [...selected, key];
	onChange(next);
}

function handlePointerDown(event: PointerEvent) {
	if (!open) return;
	const target = event.target as Node | null;
	if (rootEl?.contains(target ?? null) || menuEl?.contains(target ?? null))
		return;
	open = false;
}

function handleKeydown(event: KeyboardEvent) {
	if (event.key === "Escape") open = false;
}

onMount(() => {
	window.addEventListener("pointerdown", handlePointerDown);
	window.addEventListener("keydown", handleKeydown);
	return () => {
		window.removeEventListener("pointerdown", handlePointerDown);
		window.removeEventListener("keydown", handleKeydown);
	};
});
</script>

<div class="shrink-0" bind:this={rootEl}>
	<button
		type="button"
		class="inline-flex h-7 max-w-[160px] items-center gap-1 rounded-[6px] px-2 text-[12px] transition-colors {allSelected ? 'text-text-tertiary hover:bg-[var(--sidebar-item-hover-bg)] hover:text-text-secondary' : 'bg-[var(--sidebar-item-active-bg)] font-medium text-[var(--sidebar-item-active-fg)]'}"
		aria-haspopup="menu"
		aria-expanded={open}
		title="Filter chats by origin"
		onclick={() => {
			open = !open;
		}}
	>
		<span class="shrink-0 text-text-placeholder">From</span>
		<span class="truncate">{selectionLabel}</span>
		<ChevronDown class="h-3 w-3 shrink-0 transition-transform {open ? 'rotate-180' : ''}" />
	</button>
</div>

{#if open}
	<div
		bind:this={menuEl}
		class="rounded-[8px] border border-border-subtle bg-bg-elevated p-1 shadow-lg"
		use:floatNear={{
			getAnchor: () => rootEl,
			placement: "bottom-end",
			gap: 6,
			width: 200,
			zIndex: 120,
		}}
		role="menu"
		aria-label="Chat origins"
		tabindex="-1"
		onpointerdown={(event) => event.stopPropagation()}
	>
		<button
			type="button"
			class="flex w-full items-center gap-2 rounded-[6px] px-2 py-1.5 text-left text-[12px] text-text-secondary transition-colors hover:bg-bg-hover"
			role="menuitemcheckbox"
			aria-checked={allSelected}
			onclick={() => onChange([])}
		>
			<Check class="h-3 w-3 shrink-0 {allSelected ? 'opacity-100' : 'opacity-0'}" />
			All origins
		</button>
		<div class="my-1 h-px bg-border-subtle"></div>
		{#each SOURCES as source (source.key)}
			{@const active = selected.includes(source.key)}
			<button
				type="button"
				class="flex w-full items-center gap-2 rounded-[6px] px-2 py-1.5 text-left text-[12px] transition-colors hover:bg-bg-hover {active ? 'text-text-primary' : 'text-text-secondary'}"
				role="menuitemcheckbox"
				aria-checked={active}
				onclick={() => toggle(source.key)}
			>
				<Check class="h-3 w-3 shrink-0 {active ? 'opacity-100' : 'opacity-0'}" />
				<span class="min-w-0 flex-1 truncate">{source.label}</span>
			</button>
		{/each}
	</div>
{/if}
