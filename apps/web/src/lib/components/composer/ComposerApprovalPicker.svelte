<script lang="ts">
import type { CodexApprovalMode } from "@cohub/protocol";
import { Check, ChevronDown, Shield } from "lucide-svelte";
import { tick } from "svelte";
import { floatNear, portal } from "$lib/actions/portal";
import { CODEX_APPROVAL_CHOICES } from "$lib/codex-approval-mode";
import { getLocale } from "$lib/i18n/locale.svelte";
import { m } from "$lib/paraglide/messages.js";

const {
	value,
	invalid = false,
	supportedModes,
	disabled = false,
	onchange,
	onopen,
}: {
	value?: CodexApprovalMode;
	invalid?: boolean;
	supportedModes?: CodexApprovalMode[];
	disabled?: boolean;
	onchange: (value: CodexApprovalMode) => void;
	onopen?: () => void;
} = $props();

const locale = $derived(getLocale());
let open = $state(false);
let trigger = $state<HTMLButtonElement | null>(null);
let panel = $state<HTMLDivElement | null>(null);
const labels = $derived({
	inherit: {
		label: m.runtime_codex_approval_inherit({}, { locale }),
		detail: m.runtime_codex_approval_local_detail({}, { locale }),
	},
	read_only: {
		label: m.runtime_codex_approval_read_only({}, { locale }),
		detail: m.runtime_codex_approval_read_only_detail({}, { locale }),
	},
	auto: {
		label: m.runtime_codex_approval_auto({}, { locale }),
		detail: m.runtime_codex_approval_auto_detail({}, { locale }),
	},
	full_access: {
		label: m.runtime_codex_approval_full_access({}, { locale }),
		detail: m.runtime_codex_approval_full_access_detail({}, { locale }),
	},
});
const options = $derived(
	CODEX_APPROVAL_CHOICES.map((value) => ({ value, ...labels[value] })),
);
const selectedLabel = $derived(
	invalid
		? m.runtime_codex_approval_invalid_label({}, { locale })
		: (options.find((option) => option.value === value)?.label ??
				m.runtime_codex_approval_inherit({}, { locale })),
);
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

<button bind:this={trigger} type="button" class="harness-trigger" {disabled} aria-haspopup="menu" aria-expanded={open} aria-label={`${m.runtime_codex_approval({}, { locale })}: ${selectedLabel}`} title={selectedLabel} onclick={() => open ? close() : void show()}>
	<Shield class="h-3 w-3 shrink-0" />
	<span>{value || invalid ? selectedLabel : m.runtime_codex_approval({}, { locale })}</span>
	<ChevronDown class="h-3 w-3 shrink-0 opacity-50" />
</button>
{#if open}
	<button type="button" class="harness-backdrop" aria-hidden="true" tabindex="-1" use:portal onclick={close}></button>
	<div bind:this={panel} class="harness-menu" role="menu" aria-label={m.runtime_codex_approval({}, { locale })} tabindex="-1" onkeydown={navigate} use:floatNear={{ getAnchor: () => trigger, placement: "top-start", width: 288, zIndex: 121 }}>
		<p class="menu-heading">{m.runtime_codex_approval({}, { locale })}</p>
		{#if invalid}
			<p class="menu-note" role="alert">{m.runtime_codex_approval_invalid({}, { locale })}</p>
		{:else if !supportedModes?.length || (value && !supportedModes.includes(value))}
			<p class="menu-note" role="status">{m.runtime_codex_approval_unsupported({}, { locale })}</p>
		{:else}
			<p class="menu-note">{value ? m.runtime_codex_approval_next_turn({}, { locale }) : m.runtime_codex_approval_inherit_detail({}, { locale })}</p>
		{/if}
		{#each options as option}
			<button type="button" class="harness-option" role="menuitemradio" aria-checked={value === option.value} disabled={!supportedModes?.includes(option.value)} onclick={() => { onchange(option.value); close(); }}>
				<span class="option-content"><span class="option-title">{option.label}</span><span class="option-detail">{option.detail}</span></span>
				{#if value === option.value}<Check class="h-4 w-4 shrink-0 text-brand" />{/if}
			</button>
		{/each}
	</div>
{/if}

<style>
.harness-trigger { display: inline-flex; flex: 0 0 auto; height: 28px; align-items: center; gap: 5px; padding: 0 8px; border: 1px solid var(--border-subtle); border-radius: 999px; color: var(--text-tertiary); font-size: 11px; cursor: pointer; }
.harness-trigger:hover { background: var(--bg-hover); color: var(--text-secondary); }
.harness-trigger:focus-visible, .harness-option:focus-visible { outline: 2px solid var(--brand); outline-offset: 2px; }
.harness-trigger:disabled { opacity: .5; cursor: not-allowed; }
.menu-note { padding: 2px 8px 8px; color: var(--text-tertiary); font-size: 12px; line-height: 1.5; }
.harness-backdrop { position: fixed; inset: 0; z-index: 120; cursor: default; }
.harness-menu { padding: 6px; max-width: calc(100vw - 16px); border: 1px solid var(--border-subtle); border-radius: 10px; background: var(--bg-elevated); box-shadow: 0 8px 24px color-mix(in srgb, var(--overlay-scrim-strong) 18%, transparent); }
.menu-heading { padding: 6px 8px; color: var(--text-tertiary); font-size: 11px; }
.harness-option { display: flex; width: 100%; min-height: 52px; align-items: center; gap: 10px; padding: 8px; border-radius: 6px; text-align: left; cursor: pointer; }
.harness-option:hover:not(:disabled), .harness-option:focus-visible { background: var(--bg-hover); }
.harness-option:disabled { opacity: .5; cursor: not-allowed; }
.option-content { display: flex; flex: 1; flex-direction: column; gap: 2px; }
.option-title { color: var(--text-primary); font-size: 13px; }
.option-detail { color: var(--text-tertiary); font-size: 12px; }
@media (pointer: coarse) { .harness-trigger { min-height: 36px; } }
</style>
