<script lang="ts">
import { type HarnessKind, harnessLabel } from "@cohub/protocol/runtime";
import { Check, ChevronDown } from "lucide-svelte";
import { tick } from "svelte";
import { floatNear, portal } from "$lib/actions/portal";
import { harnessOptions } from "$lib/features/space/runtime-status-view";
import { getLocale } from "$lib/i18n/locale.svelte";
import { m } from "$lib/paraglide/messages.js";
import HarnessIcon from "./HarnessIcon.svelte";

type Harness = HarnessKind;
const {
	value,
	available,
	online,
	disabled = false,
	onchange,
	onopen,
}: {
	value: Harness;
	available: Harness[];
	online: boolean;
	disabled?: boolean;
	onchange: (value: Harness) => void;
	onopen?: () => void;
} = $props();
const locale = $derived(getLocale());
let open = $state(false);
let trigger = $state<HTMLButtonElement | null>(null);
let panel = $state<HTMLDivElement | null>(null);
const options = $derived(harnessOptions(value, available, online));
const local = $derived(value !== "cohub");
function close() {
	open = false;
	trigger?.focus();
}
async function show() {
	open = true;
	onopen?.();
	await tick();
	const selected = panel?.querySelector<HTMLButtonElement>(
		'[aria-checked="true"]:not(:disabled)',
	);
	(
		selected ??
		panel?.querySelector<HTMLButtonElement>("button:not(:disabled)") ??
		panel
	)?.focus();
}
function navigate(event: KeyboardEvent) {
	if (event.key === "Escape") {
		event.preventDefault();
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

<button bind:this={trigger} type="button" class="harness-trigger" {disabled} aria-haspopup="menu" aria-expanded={open} aria-label={`${m.runtime_harness({}, { locale })}: ${harnessLabel(value)}`} title={local ? m.runtime_local({}, { locale }) : m.runtime_cloud({}, { locale })} onclick={() => open ? close() : void show()}>
	<HarnessIcon harness={value} size={14} />
	<span>{harnessLabel(value)}</span>
	{#if local && !online}<span class="offline-dot" aria-label={m.runtime_offline({}, { locale })}></span>{/if}
	<ChevronDown class="h-3 w-3 shrink-0 opacity-50" />
</button>
{#if open}
	<button type="button" class="harness-backdrop" aria-hidden="true" tabindex="-1" use:portal onclick={close}></button>
	<div bind:this={panel} class="harness-menu menu-surface" role="menu" aria-label={m.runtime_harness({}, { locale })} tabindex="-1" onkeydown={navigate} use:floatNear={{ getAnchor: () => trigger, placement: "top-start", width: 264, zIndex: 121 }}>
		<p class="menu-heading">{m.runtime_harness({}, { locale })}</p>
		{#each options as harness, index}
			{@const isLocal = harness !== "cohub"}
			{@const unavailable = isLocal && (!online || !available.includes(harness))}
			{#if index === 1}<div class="menu-separator" role="separator"></div><p class="menu-heading">{m.runtime_local_execution({}, { locale })}</p>{/if}
			<button type="button" class="harness-option" class:compact={isLocal && !unavailable} role="menuitemradio" aria-checked={value === harness} disabled={unavailable} onclick={() => { onchange(harness); close(); }}>
				<HarnessIcon {harness} size={20} />
				<span class="option-content"><span class="option-title">{harnessLabel(harness)}</span>{#if !isLocal}<span class="option-detail">{m.runtime_cloud_execution({}, { locale })}</span>{:else if unavailable}<span class="option-detail">{online ? m.runtime_not_connected({}, { locale }) : m.runtime_offline({}, { locale })}</span>{/if}</span>
				{#if value === harness}<Check class="h-4 w-4 shrink-0 text-brand" />{/if}
			</button>
		{/each}
	</div>
{/if}

<style>
.harness-trigger { display: inline-flex; flex: 0 0 auto; height: 28px; align-items: center; gap: 5px; padding: 0 8px; border: 1px solid var(--border-subtle); border-radius: 999px; color: var(--text-tertiary); font-size: 11px; cursor: pointer; }
.harness-trigger:hover { background: var(--bg-hover); color: var(--text-secondary); }
.harness-trigger:focus-visible, .harness-option:focus-visible { outline: 2px solid var(--brand); outline-offset: 2px; }
.harness-trigger:disabled { opacity: .5; cursor: not-allowed; }
.offline-dot { width: 5px; height: 5px; border-radius: 50%; background: var(--color-warning); }
.harness-backdrop { position: fixed; inset: 0; z-index: 120; cursor: default; }
.harness-menu { padding: 6px; max-width: calc(100vw - 16px); }
.menu-heading { padding: 6px 8px; color: var(--text-tertiary); font-size: 11px; }
.harness-option { display: flex; width: 100%; min-height: 52px; align-items: center; gap: 10px; padding: 8px; border-radius: 6px; text-align: left; cursor: pointer; }
.harness-option.compact { min-height: 36px; padding-block: 6px; }
.menu-separator { height: 1px; margin: 4px 2px; background: var(--border-subtle); }
.harness-option:hover:not(:disabled), .harness-option:focus-visible { background: var(--bg-hover); }
.harness-option:disabled { opacity: .5; cursor: not-allowed; }
.option-content { display: flex; flex: 1; flex-direction: column; gap: 2px; }
.option-title { color: var(--text-primary); font-size: 13px; }
.option-detail { color: var(--text-tertiary); font-size: 12px; }
@media (pointer: coarse) { .harness-trigger { min-height: 36px; } }
</style>
