<script lang="ts">
import {
	type GenerationOperation,
	generationOperations,
	type PublicGenerationDeclaration,
} from "@cohub/protocol/generation";
import { Check, ChevronDown, LoaderCircle } from "lucide-svelte";
import { tick } from "svelte";
import { floatNear, portal } from "$lib/actions/portal";
import { getLocale } from "$lib/i18n/locale.svelte";
import { m } from "$lib/paraglide/messages.js";

let {
	model,
	value,
	open = $bindable(false),
	disabled = false,
	loading = false,
	accepts = () => true,
	onchange,
}: {
	model: PublicGenerationDeclaration | null;
	value: string | undefined;
	open?: boolean;
	disabled?: boolean;
	loading?: boolean;
	/** Whether an operation fits the current inputs; unavailable ones stay visible but disabled. */
	accepts?: (operation: GenerationOperation) => boolean;
	onchange: (operation: GenerationOperation) => void;
} = $props();

const locale = $derived(getLocale());
const operations = $derived(model ? generationOperations(model) : []);
const selected = $derived(
	operations.find((operation) => operation.name === value) ?? null,
);
const title = $derived(m.generation_operation({}, { locale }));
let trigger = $state<HTMLButtonElement | null>(null);
let panel = $state<HTMLDivElement | null>(null);

function close() {
	open = false;
	trigger?.focus();
}

async function show() {
	open = true;
	await tick();
	(
		panel?.querySelector<HTMLButtonElement>(
			'[aria-checked="true"]:not(:disabled)',
		) ??
		panel?.querySelector<HTMLButtonElement>("button:not(:disabled)") ??
		panel
	)?.focus();
}

function choose(operation: GenerationOperation) {
	onchange(operation);
	close();
}

function navigate(event: KeyboardEvent) {
	if (event.key === "Escape") {
		event.preventDefault();
		event.stopPropagation();
		close();
		return;
	}
	if (event.key === "Tab") {
		open = false;
		return;
	}
	if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
	event.preventDefault();
	const items = Array.from(
		panel?.querySelectorAll<HTMLButtonElement>(
			'[role="menuitemradio"]:not(:disabled)',
		) ?? [],
	);
	if (items.length === 0) return;
	const index = items.indexOf(document.activeElement as HTMLButtonElement);
	const next =
		event.key === "Home"
			? 0
			: event.key === "End"
				? items.length - 1
				: (index + (event.key === "ArrowDown" ? 1 : -1) + items.length) %
					items.length;
	items[next]?.focus();
}
</script>

{#if model?.operations}
	<button
		bind:this={trigger}
		type="button"
		class="operation-trigger"
		class:is-unset={!selected}
		aria-expanded={open}
		aria-haspopup="menu"
		aria-label={title}
		{disabled}
		onclick={() => (open ? close() : void show())}
	>
		{#if loading}<LoaderCircle class="h-3 w-3 shrink-0 animate-spin" />{/if}
		<span class="truncate">{selected ? (selected.title ?? selected.name) : title}</span>
		<ChevronDown class="h-3 w-3 shrink-0 opacity-45" />
	</button>
	{#if open}
		<button type="button" class="operation-backdrop" aria-hidden="true" tabindex="-1" use:portal onclick={close}></button>
		<div
			bind:this={panel}
			class="operation-menu menu-surface"
			role="menu"
			aria-label={title}
			tabindex="-1"
			onkeydown={navigate}
			use:floatNear={{ getAnchor: () => trigger, placement: "top-start", width: 300, zIndex: 121 }}
		>
			{#each operations as operation (operation.name)}
				{@const available = accepts(operation)}
				<button
					type="button"
					class="operation-option"
					role="menuitemradio"
					aria-checked={operation.name === value}
					title={available
						? operation.description
						: m.generation_operation_incompatible({}, { locale })}
					disabled={!available}
					onclick={() => choose(operation)}
				>
					<span class="operation-content">
						<span class="operation-title">{operation.title ?? operation.name}</span>
						{#if operation.description}<span class="operation-detail">{operation.description}</span>{/if}
					</span>
					{#if operation.name === value}<Check class="h-4 w-4 shrink-0 text-brand" />{/if}
				</button>
			{/each}
		</div>
	{/if}
{/if}

<style>
	.operation-trigger {
		display: inline-flex;
		flex: 0 1 auto;
		min-width: 0;
		height: 28px;
		max-width: min(100%, 15rem);
		align-items: center;
		gap: 4px;
		border: 1px solid var(--border-subtle);
		border-radius: 999px;
		padding: 0 8px;
		font-size: 11px;
		color: var(--text-secondary);
		transition: background-color 100ms ease, color 100ms ease;
	}
	.operation-trigger:hover:not(:disabled) { background: var(--bg-hover); }
	.operation-trigger:focus-visible { outline: 2px solid var(--brand); outline-offset: 1px; }
	.operation-trigger:disabled { cursor: not-allowed; opacity: 0.5; }
	.operation-trigger[aria-expanded="true"] {
		border-color: transparent;
		background: var(--brand-bg);
		color: var(--brand-muted-fg);
	}
	.operation-trigger.is-unset { color: var(--text-tertiary); }
	.operation-backdrop { position: fixed; inset: 0; z-index: 120; cursor: default; }
	.operation-menu {
		max-width: calc(100vw - 16px);
		max-height: min(360px, calc(100dvh - 96px));
		overflow-y: auto;
		overscroll-behavior: contain;
		padding: 6px;
	}
	.operation-option {
		display: flex;
		width: 100%;
		align-items: center;
		gap: 10px;
		border-radius: 6px;
		padding: 7px 8px;
		text-align: left;
		cursor: pointer;
	}
	.operation-option:hover:not(:disabled), .operation-option:focus-visible { background: var(--bg-hover); }
	.operation-option:disabled { cursor: not-allowed; opacity: 0.4; }
	.operation-content { display: flex; min-width: 0; flex: 1; flex-direction: column; gap: 2px; }
	.operation-title { font-size: 12px; color: var(--text-primary); }
	.operation-detail {
		overflow: hidden;
		display: -webkit-box;
		-webkit-box-orient: vertical;
		-webkit-line-clamp: 2;
		line-clamp: 2;
		font-size: 11px;
		line-height: 1.35;
		color: var(--text-tertiary);
	}
	@media (pointer: coarse) {
		.operation-trigger { height: 36px; }
	}
</style>
