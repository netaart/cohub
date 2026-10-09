<script lang="ts">
import { X } from "lucide-svelte";
import type { Snippet } from "svelte";
import { tick, untrack } from "svelte";
import { floatNear } from "$lib/actions/portal";
import Sheet from "$lib/components/Sheet.svelte";
import { getLocale } from "$lib/i18n/locale.svelte";
import { useCompactShell } from "$lib/layout/compact-shell.svelte";
import { m } from "$lib/paraglide/messages.js";

let {
	title,
	open = $bindable(false),
	anchor,
	trigger,
	children,
	onopen,
	triggerClass = "",
}: {
	title: string;
	open?: boolean;
	anchor?: HTMLElement | null;
	trigger?: Snippet;
	children: Snippet;
	onopen?: () => void;
	triggerClass?: string;
} = $props();
const id = $props.id();
const locale = $derived(getLocale());
const compact = $derived(useCompactShell());
let button = $state<HTMLButtonElement | null>(null);
let panel = $state<HTMLElement | null>(null);
let pinned = $state(false);
let timer: ReturnType<typeof setTimeout> | undefined;

function cancelClose() {
	if (timer) clearTimeout(timer);
}

function preview(event: PointerEvent) {
	if (event.pointerType !== "mouse" || compact) return;
	cancelClose();
	open = true;
}

function scheduleClose() {
	cancelClose();
	if (!pinned && !compact)
		timer = setTimeout(() => {
			open = false;
		}, 160);
}

function close(restoreFocus = false) {
	cancelClose();
	open = false;
	pinned = false;
	if (restoreFocus) (button ?? anchor)?.focus();
}

async function toggle() {
	if (open && pinned) return close(true);
	cancelClose();
	pinned = true;
	open = true;
	await tick();
	panel?.focus();
}

$effect(() => {
	if (!open) {
		pinned = false;
		return;
	}
	untrack(() => onopen?.());
	if (!trigger) pinned = true;
	const compactMode = compact;

	function outside(event: Event) {
		const target = event.target;
		if (
			target instanceof Node &&
			!panel?.contains(target) &&
			!(button ?? anchor)?.contains(target)
		)
			close();
	}

	function keydown(event: KeyboardEvent) {
		if (event.key === "Escape") {
			event.preventDefault();
			event.stopPropagation();
			close(true);
		}
	}

	if (!compactMode) {
		document.addEventListener("pointerdown", outside);
		document.addEventListener("focusin", outside);
	}
	document.addEventListener("keydown", keydown, true);
	return () => {
		cancelClose();
		if (!compactMode) {
			document.removeEventListener("pointerdown", outside);
			document.removeEventListener("focusin", outside);
		}
		document.removeEventListener("keydown", keydown, true);
	};
});
</script>

{#snippet panelContent()}
	<div class="flex items-center justify-between gap-3 border-b border-border-subtle px-3 py-2.5">
		<h3 id={`${id}-title`} class="font-medium text-text-primary">{title}</h3>
		<button
			type="button"
			class="flex h-9 w-9 shrink-0 items-center justify-center rounded text-text-tertiary hover:bg-bg-hover focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-brand"
			aria-label={m.dialog_close({}, { locale })}
			onclick={() => close(true)}
		>
			<X size={16} />
		</button>
	</div>
	<div class="max-h-[min(72dvh,640px)] overflow-y-auto p-3 text-[12px] font-normal text-text-secondary select-text">
		{@render children()}
	</div>
{/snippet}

{#if trigger}
	<button
		bind:this={button}
		type="button"
		class={`relative -mx-1 inline-flex items-center gap-1 rounded px-1 text-inherit after:absolute after:-inset-y-1.5 after:inset-x-0 hover:bg-bg-hover focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-brand ${triggerClass}`}
		aria-label={title}
		aria-haspopup="dialog"
		aria-expanded={open}
		aria-controls={open ? id : undefined}
		onpointerenter={preview}
		onpointerleave={scheduleClose}
		onclick={toggle}
	>
		{@render trigger()}
	</button>
{/if}

{#if open && compact}
	<Sheet open={open} onClose={() => close(true)} maxWidth="480px">
		{#snippet children()}
			{@render panelContent()}
		{/snippet}
	</Sheet>
{:else if open}
	<div
		bind:this={panel}
		id={id}
		role="dialog"
		aria-labelledby={`${id}-title`}
		tabindex="-1"
		class="w-[min(360px,calc(100vw-16px))] max-h-[min(70dvh,540px)] overflow-y-auto rounded-lg border border-border-subtle bg-bg-primary text-[12px] font-normal text-text-secondary shadow-lg outline-none select-text"
		use:floatNear={{ getAnchor: () => button ?? anchor, placement: "bottom-end", gap: 6, zIndex: 130 }}
		onpointerenter={cancelClose}
		onpointerleave={scheduleClose}
		onfocusin={() => { pinned = true; cancelClose(); }}
	>
		{@render panelContent()}
	</div>
{/if}
