<script lang="ts">
import { X } from "lucide-svelte";
import type { Snippet } from "svelte";
import { tick, untrack } from "svelte";
import { floatNear } from "$lib/actions/portal";
import { getLocale } from "$lib/i18n/locale.svelte";
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
let button = $state<HTMLButtonElement | null>(null);
let panel = $state<HTMLElement | null>(null);
let pinned = $state(false);
let timer: ReturnType<typeof setTimeout> | undefined;
function cancelClose() {
	if (timer) clearTimeout(timer);
}
function preview(event: PointerEvent) {
	if (event.pointerType !== "mouse") return;
	cancelClose();
	open = true;
}
function scheduleClose() {
	cancelClose();
	if (!pinned)
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
	if (!trigger) {
		pinned = true;
		void tick().then(() => panel?.focus());
	}
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
	document.addEventListener("pointerdown", outside);
	document.addEventListener("focusin", outside);
	document.addEventListener("keydown", keydown, true);
	return () => {
		cancelClose();
		document.removeEventListener("pointerdown", outside);
		document.removeEventListener("focusin", outside);
		document.removeEventListener("keydown", keydown, true);
	};
});
</script>

{#if trigger}
  <button bind:this={button} type="button" class={`inline-flex min-h-8 items-center gap-1.5 rounded px-1 text-text-tertiary hover:bg-bg-hover focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-brand ${triggerClass}`}
    aria-label={title} aria-haspopup="dialog" aria-expanded={open} aria-controls={open ? id : undefined}
    onpointerenter={preview} onpointerleave={scheduleClose} onclick={toggle}>
    {@render trigger()}
  </button>
{/if}
{#if open}
  <div bind:this={panel} id={id} role="dialog" aria-labelledby={`${id}-title`} tabindex="-1"
    class="w-[min(340px,calc(100vw-16px))] max-h-[min(70dvh,540px)] overflow-y-auto rounded-lg border border-border-subtle bg-bg-primary p-3 text-[12px] font-normal text-text-secondary shadow-lg outline-none select-text"
    use:floatNear={{ getAnchor: () => button ?? anchor, placement: "bottom-end", gap: 6, zIndex: 130 }}
    onpointerenter={cancelClose} onpointerleave={scheduleClose}
    onfocusin={() => { pinned = true; cancelClose(); }}>
    <div class="mb-2 flex items-center justify-between gap-3">
      <h3 id={`${id}-title`} class="font-medium text-text-primary">{title}</h3>
      <button type="button" class="flex h-9 w-9 shrink-0 items-center justify-center rounded text-text-tertiary hover:bg-bg-hover focus-visible:ring-1 focus-visible:ring-brand" aria-label={m.dialog_close({}, { locale })} onclick={() => close(true)}><X size={16} /></button>
    </div>
    {@render children()}
  </div>
{/if}
