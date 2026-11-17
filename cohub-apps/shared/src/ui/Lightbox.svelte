<script lang="ts">
import { ChevronLeft, ChevronRight, X } from "lucide-svelte";
import { m } from "$messages";
import { getLocale } from "../runtime.svelte.ts";

type Item = { src: string; alt: string };
type Props = { items: Item[]; index: number | null; onclose: () => void };
let { items, index = $bindable(), onclose }: Props = $props();

const locale = $derived(getLocale());
let dialog = $state<HTMLDialogElement | null>(null);
const item = $derived(index === null ? null : items[index]);

$effect(() => {
  if (!dialog) return;
  if (item && !dialog.open) dialog.showModal();
  else if (!item && dialog.open) dialog.close();
});

function step(delta: number) {
  if (index === null || items.length < 2) return;
  index = (index + delta + items.length) % items.length;
}
</script>

<dialog
  bind:this={dialog}
  class="m-0 h-dvh max-h-none w-screen max-w-none bg-transparent p-0 backdrop:bg-overlay-scrim"
  aria-label={item?.alt}
  oncancel={(event) => { event.preventDefault(); onclose(); }}
  onkeydown={(event) => { if (event.key === "ArrowRight") step(1); else if (event.key === "ArrowLeft") step(-1); }}
>
  {#if item}
    <button type="button" class="absolute inset-0 cursor-zoom-out" aria-label={m.common_close({}, { locale })} onclick={onclose}></button>
    <img src={item.src} alt={item.alt} class="pointer-events-none absolute inset-0 m-auto max-h-[92dvh] max-w-[94vw] animate-fade-in rounded-[6px] object-contain" />
    <button type="button" class="absolute top-3 right-3 flex h-9 w-9 items-center justify-center rounded-full bg-overlay-control text-overlay-control-text hover:bg-overlay-control-hover" aria-label={m.common_close({}, { locale })} onclick={onclose}><X class="h-4 w-4" /></button>
    {#if items.length > 1}
      <button type="button" class="absolute top-1/2 left-3 flex h-10 w-10 -translate-y-1/2 items-center justify-center rounded-full bg-overlay-control text-overlay-control-text hover:bg-overlay-control-hover" aria-label={m.resource_app_previous({}, { locale })} onclick={() => step(-1)}><ChevronLeft class="h-5 w-5" /></button>
      <button type="button" class="absolute top-1/2 right-3 flex h-10 w-10 -translate-y-1/2 items-center justify-center rounded-full bg-overlay-control text-overlay-control-text hover:bg-overlay-control-hover" aria-label={m.resource_app_next({}, { locale })} onclick={() => step(1)}><ChevronRight class="h-5 w-5" /></button>
      <span class="absolute bottom-4 left-1/2 -translate-x-1/2 rounded-full bg-overlay-control px-2.5 py-1 font-mono text-[11px] text-overlay-control-text">{(index ?? 0) + 1} / {items.length}</span>
    {/if}
  {/if}
</dialog>
