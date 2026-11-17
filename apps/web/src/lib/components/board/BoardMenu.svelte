<script lang="ts" module>
import type { Pencil as BoardMenuIcon } from "lucide-svelte";

export type BoardMenuItem =
	| {
			id: string;
			label: string;
			icon?: typeof BoardMenuIcon;
			checked?: boolean;
			danger?: boolean;
			disabled?: boolean;
			run: () => void;
	  }
	| { id: string; separator: true };
</script>

<script lang="ts">
import { Check } from "lucide-svelte";
import { onMount } from "svelte";
import { floatNear } from "#lib/actions/portal.ts";

const {
	anchor,
	items,
	label,
	placement = "top-start",
	onClose,
}: {
	anchor: HTMLElement;
	items: readonly BoardMenuItem[];
	label: string;
	placement?: "top-start" | "bottom-start" | "bottom-end";
	onClose: () => void;
} = $props();

let menu = $state<HTMLDivElement | null>(null);
const checkable = $derived(
	items.some((item) => "checked" in item && item.checked !== undefined),
);

function choose(item: Extract<BoardMenuItem, { run: unknown }>) {
	if (item.disabled) return;
	onClose();
	item.run();
}

onMount(() => {
	const down = (event: PointerEvent) => {
		const target = event.target as Node;
		if (!menu?.contains(target) && !anchor.contains(target)) onClose();
	};
	const key = (event: KeyboardEvent) => {
		if (event.key !== "Escape") return;
		event.stopPropagation();
		onClose();
		anchor.focus();
	};
	document.addEventListener("pointerdown", down, true);
	document.addEventListener("keydown", key, true);
	menu?.querySelector<HTMLElement>("[role^='menuitem']:not(:disabled)")?.focus();
	return () => {
		document.removeEventListener("pointerdown", down, true);
		document.removeEventListener("keydown", key, true);
	};
});

function step(event: KeyboardEvent) {
	if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
	event.preventDefault();
	const entries = [
		...(menu?.querySelectorAll<HTMLElement>(
			"[role^='menuitem']:not(:disabled)",
		) ?? []),
	];
	const index = entries.indexOf(document.activeElement as HTMLElement);
	const next =
		entries[
			(index + (event.key === "ArrowDown" ? 1 : -1) + entries.length) %
				entries.length
		];
	next?.focus();
}
</script>

<div
	bind:this={menu}
	class="board-menu menu-surface"
	role="menu"
	tabindex="-1"
	aria-label={label}
	use:floatNear={{ getAnchor: () => anchor, placement, gap: 6, zIndex: 130 }}
	onkeydown={step}
>
	{#each items as item (item.id)}
		{#if "separator" in item}
			<div class="board-menu-separator" role="separator"></div>
		{:else}
			<button
				type="button"
				class="board-menu-item"
				class:board-menu-item--danger={item.danger}
				role={item.checked === undefined ? "menuitem" : "menuitemcheckbox"}
				aria-checked={item.checked}
				disabled={item.disabled}
				onclick={() => choose(item)}
			>
				{#if checkable}
					<span class="board-menu-check">{#if item.checked}<Check class="h-3.5 w-3.5" />{/if}</span>
				{/if}
				{#if item.icon}<item.icon class="h-3.5 w-3.5" />{/if}
				<span class="board-menu-label">{item.label}</span>
			</button>
		{/if}
	{/each}
</div>

<style>
	.board-menu {
		min-width: 176px;
		max-width: 280px;
		max-height: min(360px, 60vh);
		overflow-y: auto;
		padding: 4px;
	}
	.board-menu-item {
		display: flex;
		width: 100%;
		align-items: center;
		gap: 8px;
		border-radius: 6px;
		padding: 7px 8px;
		color: var(--text-secondary);
		font-size: 12px;
		font-weight: 500;
		text-align: left;
	}
	.board-menu-item:hover:not(:disabled),
	.board-menu-item:focus-visible {
		background: var(--bg-hover);
		color: var(--text-primary);
		outline: none;
	}
	.board-menu-item:disabled { opacity: 0.45; }
	.board-menu-item--danger:hover:not(:disabled) {
		background: var(--color-error-bg);
		color: var(--error-700);
	}
	.board-menu-check {
		display: inline-flex;
		width: 14px;
		flex-shrink: 0;
		color: var(--brand-muted-fg);
	}
	.board-menu-label {
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.board-menu-separator {
		height: 1px;
		margin: 4px 6px;
		background: var(--border-subtle);
	}
	@media (pointer: coarse) {
		.board-menu-item { min-height: 40px; font-size: 13px; }
	}
</style>
