<script lang="ts">
import type { GenerationParameterSpec } from "@cohub/protocol/generation";
import { Settings2 } from "lucide-svelte";
import { tick } from "svelte";
import { floatNear, portal } from "$lib/actions/portal";
import GenerationParameterField from "$lib/components/generation/GenerationParameterField.svelte";
import {
	type GenerationParameterValues,
	generationParameterLabel,
} from "$lib/generation-parameters";
import { getLocale } from "$lib/i18n/locale.svelte";
import { m } from "$lib/paraglide/messages.js";

let {
	entries,
	values,
	open = $bindable(false),
	disabled = false,
	onchange,
}: {
	entries: readonly [string, GenerationParameterSpec][];
	values: Readonly<GenerationParameterValues>;
	open?: boolean;
	disabled?: boolean;
	onchange: (name: string, value: unknown) => void;
} = $props();

const locale = $derived(getLocale());
const title = $derived(m.board_generation_settings({}, { locale }));
const setCount = $derived(
	entries.filter(([name]) => values[name] !== undefined).length,
);
let trigger = $state<HTMLButtonElement | null>(null);
let panel = $state<HTMLDivElement | null>(null);

function close() {
	open = false;
	trigger?.focus();
}

async function toggle() {
	if (open) return close();
	open = true;
	await tick();
	panel?.querySelector<HTMLElement>("input, select, button")?.focus();
}

function handlePanelKeydown(event: KeyboardEvent) {
	if (event.key !== "Escape") return;
	event.preventDefault();
	event.stopPropagation();
	close();
}
</script>

<button
	bind:this={trigger}
	type="button"
	class="settings-trigger"
	aria-expanded={open}
	aria-haspopup="dialog"
	aria-label={title}
	{title}
	{disabled}
	onclick={() => void toggle()}
>
	<Settings2 class="h-3.5 w-3.5 shrink-0" />
	{#if setCount > 0}<span class="tabular-nums">{setCount}</span>{/if}
</button>
{#if open}
	<button type="button" class="settings-backdrop" aria-hidden="true" tabindex="-1" use:portal onclick={close}></button>
	<div
		bind:this={panel}
		class="settings-panel menu-surface"
		role="dialog"
		aria-label={title}
		tabindex="-1"
		onkeydown={handlePanelKeydown}
		use:floatNear={{ getAnchor: () => trigger, placement: "top-start", width: 320, zIndex: 121 }}
	>
		{#each entries as [name, spec] (name)}
			<div class="parameter-row" title={spec.description}>
				<span class="parameter-label">{generationParameterLabel(name)}</span>
				<GenerationParameterField
					{name}
					{spec}
					value={values[name]}
					onchange={(value) => onchange(name, value)}
				/>
			</div>
		{/each}
	</div>
{/if}

<style>
	.settings-trigger {
		display: inline-flex;
		flex: 0 0 auto;
		height: 28px;
		min-width: 28px;
		align-items: center;
		justify-content: center;
		gap: 4px;
		border: 1px solid var(--border-subtle);
		border-radius: 999px;
		padding: 0 8px;
		font-size: 11px;
		color: var(--text-tertiary);
		transition: background-color 100ms ease, color 100ms ease;
	}
	.settings-trigger:hover:not(:disabled) { background: var(--bg-hover); color: var(--text-secondary); }
	.settings-trigger:focus-visible { outline: 2px solid var(--brand); outline-offset: 1px; }
	.settings-trigger:disabled { cursor: not-allowed; opacity: 0.5; }
	.settings-trigger[aria-expanded="true"] { background: var(--brand-bg); color: var(--brand-muted-fg); }
	.settings-backdrop { position: fixed; inset: 0; z-index: 120; cursor: default; }
	.settings-panel {
		max-width: calc(100vw - 16px);
		max-height: min(360px, calc(100dvh - 96px));
		overflow-y: auto;
		overscroll-behavior: contain;
		padding: 6px;
	}
	.parameter-row {
		display: grid;
		grid-template-columns: minmax(0, 1fr) minmax(120px, 1.25fr);
		align-items: center;
		gap: 10px;
		padding: 4px 6px;
	}
	.parameter-label {
		min-width: 0;
		overflow-wrap: anywhere;
		font-size: 11px;
		text-transform: capitalize;
		color: var(--text-secondary);
	}
	@media (pointer: coarse) {
		.settings-trigger { height: 36px; min-width: 36px; }
		.parameter-label { font-size: 12px; }
	}
	@media (max-width: 420px) {
		.parameter-row { grid-template-columns: minmax(0, 1fr); gap: 4px; }
	}
</style>
