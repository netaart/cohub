<script lang="ts">
import { X } from "lucide-svelte";
import { dismissOnBack } from "$lib/back-layers.svelte";
import { getLocale } from "$lib/i18n/locale.svelte";
import { useCompactShell } from "$lib/layout/compact-shell.svelte";
import { overlay } from "$lib/motion";
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
const sheet = $derived(mobile && useCompactShell());
</script>

{#if open}
  <div
    use:portal
    class="fixed inset-0 z-[var(--z-dialog)] flex justify-center {sheet ? 'items-end' : 'items-center p-4'}"
    role="dialog"
    aria-modal="true"
  >
    <div
      class="dialog-backdrop absolute inset-0"
      onclick={onClose}
      aria-hidden="true"
      transition:overlay={{ drawer: sheet }}
    ></div>
    <div
      class="dialog-surface relative w-full"
      class:is-sheet={sheet}
      style="max-width: {sheet ? '480px' : maxWidth}"
      transition:overlay={{ kind: sheet ? "sheet" : "pop" }}
    >
      <div class="flex flex-col" class:h-full={!sheet} style="max-height: {maxHeight}">
        {#if title}
          <div class="h-9 flex items-center justify-between px-3 border-b border-border-subtle text-[10px] font-medium uppercase tracking-wider text-text-tertiary select-none shrink-0">
            <span>{title}</span>
            {@render closeButton()}
          </div>
        {/if}
        <div class="min-h-0 flex-1" class:pb-safe={sheet} class:overflow-y-auto={scrollable} class:overflow-hidden={!scrollable}>
          {@render children()}
        </div>
        {#if footer}
          {@render footer()}
        {/if}
      </div>
    </div>
  </div>
{/if}

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
