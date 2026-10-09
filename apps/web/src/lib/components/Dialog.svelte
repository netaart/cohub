<script lang="ts">
import { X } from "lucide-svelte";
import { fade, scale, slide } from "svelte/transition";
import { dismissOnBack } from "$lib/back-layers.svelte";
import { getLocale } from "$lib/i18n/locale.svelte";
import {
	DURATION_MODAL_IN,
	DURATION_MODAL_OUT,
	svelteEaseIn,
	svelteEaseOut,
} from "$lib/motion.svelte";
import { m } from "$lib/paraglide/messages.js";

function portal(node: HTMLElement) {
	if (typeof document === "undefined") return {};
	document.body.appendChild(node);
	return {
		destroy() {
			node.remove();
		},
	};
}

const {
	open,
	onClose,
	title,
	children,
	footer,
	mobile = true,
	maxWidth = "480px",
	maxHeight = "70vh",
	scrollable = true,
}: {
	open: boolean;
	onClose: () => void;
	title?: string;
	children: import("svelte").Snippet;
	footer?: import("svelte").Snippet;
	mobile?: boolean;
	maxWidth?: string;
	maxHeight?: string;
	/** Keep the dialog body fixed when the content provides its own layout. */
	scrollable?: boolean;
} = $props();

const locale = $derived(getLocale());
dismissOnBack(
	() => open,
	() => onClose(),
);
const TRANSITION_IN = { duration: DURATION_MODAL_IN, easing: svelteEaseOut };
const TRANSITION_OUT = { duration: DURATION_MODAL_OUT, easing: svelteEaseIn };
const SCALE_TRANSITION_IN = { ...TRANSITION_IN, start: 0.95 };
const SCALE_TRANSITION_OUT = { ...TRANSITION_OUT, start: 0.95 };
</script>

{#if open}
  <div
    use:portal
    class="fixed inset-0 z-[var(--z-dialog)] flex items-end justify-center p-0 lg:items-center lg:p-4"
    in:fade={TRANSITION_IN}
    out:fade={TRANSITION_OUT}
    role="dialog"
    aria-modal="true"
  >
    <!-- Backdrop -->
    <div
      class="absolute inset-0 bg-overlay-scrim"
      onclick={onClose}
      aria-hidden="true"
    ></div>

    {#if mobile}
      <!-- Desktop: centered modal -->
      <div
        class="hidden lg:block relative w-full rounded-xl border border-border-subtle bg-bg-primary shadow-2xl overflow-hidden"
        style="max-width: {maxWidth}"
        in:scale|local={SCALE_TRANSITION_IN}
        out:scale|local={SCALE_TRANSITION_OUT}
      >
        {@render modalContent()}
      </div>

      <!-- Mobile: bottom sheet -->
      <div
        class="lg:hidden relative w-full max-w-[480px] rounded-t-xl border-t border-border-subtle bg-bg-primary shadow-2xl overflow-hidden"
        in:slide|local={{ axis: "y", ...TRANSITION_IN }}
        out:slide|local={{ axis: "y", ...TRANSITION_OUT }}
      >
        {@render mobileSheetContent()}
      </div>
    {:else}
      <!-- Desktop-only modal -->
      <div
        class="relative w-full rounded-xl border border-border-subtle bg-bg-primary shadow-2xl overflow-hidden"
        style="max-width: {maxWidth}"
        in:scale|local={SCALE_TRANSITION_IN}
        out:scale|local={SCALE_TRANSITION_OUT}
      >
        {@render modalContent()}
      </div>
    {/if}
  </div>
{/if}

{#snippet modalContent()}
  <div class="flex flex-col h-full" style="max-height: {maxHeight}">
    {#if title}
      <div class="h-9 flex items-center justify-between px-3 border-b border-border-subtle text-[10px] font-medium uppercase tracking-wider text-text-tertiary select-none shrink-0">
        <span>{title}</span>
        {@render closeButton()}
      </div>
    {/if}
    <div class:flex-1={true} class:min-h-0={true} class:overflow-y-auto={scrollable} class:overflow-hidden={!scrollable}>
      {@render children()}
    </div>
    {#if footer}
      {@render footer()}
    {/if}
  </div>
{/snippet}

{#snippet closeButton()}
  <button
    type="button"
    class="flex h-6 w-6 items-center justify-center rounded-[4px] text-text-tertiary transition-colors duration-100 hover:bg-bg-hover hover:text-text-secondary"
    onclick={onClose}
    title={m.dialog_close({}, { locale })}
    aria-label={m.dialog_close({}, { locale })}
  >
    <X class="h-3.5 w-3.5" />
  </button>
{/snippet}

{#snippet mobileSheetContent()}
  <div class="flex flex-col" style="max-height: {maxHeight}">
    {#if title}
      <div class="h-9 flex items-center justify-between px-3 border-b border-border-subtle text-[10px] font-medium uppercase tracking-wider text-text-tertiary select-none shrink-0">
        <span>{title}</span>
        {@render closeButton()}
      </div>
    {/if}
    <div class:flex-1={true} class:min-h-0={true} class:pb-safe={true} class:overflow-y-auto={scrollable} class:overflow-hidden={!scrollable}>
      {@render children()}
    </div>
    {#if footer}
      {@render footer()}
    {/if}
  </div>
{/snippet}
