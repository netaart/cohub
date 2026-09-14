<script lang="ts">
/**
 * Source filter for the cross-space chats inbox.
 *
 * This filters `session.source` (where a chat came from), not the labels a user
 * assigns in a space. Options come from the server: `sourceCounts` reports which
 * kinds the account actually has, so the list never offers a kind with nothing
 * behind it.
 */
import type { UserSessionSourceKey } from "@neta-art/cohub";
import { Check, ChevronDown } from "lucide-svelte";
import { onMount } from "svelte";
import { floatNear } from "$lib/actions/portal";

const {
	selected,
	counts,
	onChange,
}: {
	selected: readonly UserSessionSourceKey[];
	counts: Array<{ key: string; count: number }>;
	onChange: (next: UserSessionSourceKey[]) => void;
} = $props();

const SOURCE_LABELS: Record<string, string> = {
	web: "Web App",
	public_api: "Public API",
	scheduled_task: "Scheduled Task",
	space_hook: "Hook",
	websocket: "Websocket",
	cli: "CLI",
	feishu: "Feishu",
	wechat: "WeChat",
	discord: "Discord",
	qq: "QQ",
	other: "Other",
};

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
	return SOURCE_LABELS[key] ?? key;
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
		{#each counts as item (item.key)}
			{@const active = selected.includes(item.key as UserSessionSourceKey)}
			<button
				type="button"
				class="flex w-full items-center gap-2 rounded-[6px] px-2 py-1.5 text-left text-[12px] transition-colors hover:bg-bg-hover {active ? 'text-text-primary' : 'text-text-secondary'}"
				role="menuitemcheckbox"
				aria-checked={active}
				onclick={() => toggle(item.key as UserSessionSourceKey)}
			>
				<Check class="h-3 w-3 shrink-0 {active ? 'opacity-100' : 'opacity-0'}" />
				<span class="min-w-0 flex-1 truncate">{sourceLabel(item.key)}</span>
				<span class="shrink-0 text-[11px] text-text-placeholder">{item.count}</span>
			</button>
		{/each}
	</div>
{/if}
