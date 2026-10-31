<script lang="ts">
import type { GenerationParameterSpec } from "@cohub/protocol/generation";
import { Settings2 } from "lucide-svelte";
import { tick } from "svelte";
import { floatNear, portal } from "$lib/actions/portal";
import GenerationParameterFields from "$lib/components/composer/GenerationParameterFields.svelte";
import { getLocale } from "$lib/i18n/locale.svelte";
import { m } from "$lib/paraglide/messages.js";

const {
	parameters,
	values,
	disabled = false,
	invalid = false,
	onchange,
	onclear,
}: {
	parameters: Readonly<Record<string, GenerationParameterSpec>>;
	values: Readonly<Record<string, unknown>>;
	disabled?: boolean;
	/** A configured value is out of range; the send button names which. */
	invalid?: boolean;
	onchange: (name: string, value: unknown) => void;
	onclear: (name: string) => void;
} = $props();

const locale = $derived(getLocale());
let open = $state(false);
let trigger: HTMLButtonElement | null = $state(null);
let panel: HTMLDivElement | null = $state(null);
const configured = $derived(Object.keys(values).length > 0);

function close() {
	open = false;
	trigger?.focus();
}

async function show() {
	open = true;
	await tick();
	focusables()[0]?.focus();
}

function focusables() {
	return Array.from(
		panel?.querySelectorAll<HTMLElement>("input, select, button") ?? [],
	).filter((element) => !element.hasAttribute("disabled"));
}

/** The panel is portalled to the end of the document, so Tab leaves it for the gear. */
function handleKeydown(event: KeyboardEvent) {
	if (!open) return;
	if (event.key === "Escape") {
		event.preventDefault();
		close();
		return;
	}
	if (event.key !== "Tab" || !panel?.contains(document.activeElement)) return;
	const items = focusables();
	const edge = event.shiftKey ? items[0] : items.at(-1);
	if (document.activeElement !== edge) return;
	event.preventDefault();
	close();
}
</script>

<svelte:window onkeydown={handleKeydown} />

{#if Object.keys(parameters).length > 0}
	<button
		bind:this={trigger}
		type="button"
		class="gear relative flex h-8.5 w-8.5 shrink-0 items-center justify-center rounded-full text-text-tertiary transition-colors hover:bg-bg-hover hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand disabled:cursor-not-allowed disabled:opacity-50 {open ? 'bg-bg-hover text-text-primary' : ''}"
		{disabled}
		title={m.board_generation_settings({}, { locale })}
		aria-label={m.board_generation_settings({}, { locale })}
		aria-expanded={open}
		aria-haspopup="true"
		onclick={() => (open ? close() : void show())}
	>
		<Settings2 class="h-[17px] w-[17px]" />
		{#if invalid}<span class="absolute right-1.5 top-1.5 h-1.5 w-1.5 rounded-full bg-error-soft" aria-hidden="true"></span>
		{:else if configured}<span class="absolute right-1.5 top-1.5 h-1.5 w-1.5 rounded-full bg-brand" aria-hidden="true"></span>{/if}
	</button>
	{#if open}
		<button type="button" class="backdrop" aria-hidden="true" tabindex="-1" use:portal onclick={close}></button>
		<div
			bind:this={panel}
			class="panel menu-surface"
			role="group"
			aria-label={m.board_generation_settings({}, { locale })}
			use:floatNear={{ getAnchor: () => trigger, placement: "top-start", gap: 6, width: Math.min(300, Math.max(0, (typeof window === "undefined" ? 300 : window.innerWidth) - 16)), zIndex: 121 }}
		>
			<GenerationParameterFields {parameters} {values} {onchange} {onclear} />
		</div>
	{/if}
{/if}

<style>
	.backdrop {
		position: fixed;
		inset: 0;
		z-index: 120;
		cursor: default;
	}
	.panel {
		max-height: min(50dvh, 320px);
		overflow-y: auto;
		padding: 4px;
	}
	@media (pointer: coarse) {
		/* Same visual size as its neighbours; the hit area reaches 44px. */
		.gear::before {
			content: "";
			position: absolute;
			inset: -5px;
		}
	}
</style>
