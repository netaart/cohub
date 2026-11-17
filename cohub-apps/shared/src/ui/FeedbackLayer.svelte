<script lang="ts">
import { feedback } from "./feedback.svelte.ts";

let dialog = $state<HTMLDialogElement | null>(null);
const request = $derived(feedback.confirm);

$effect(() => {
  if (!dialog) return;
  if (request && !dialog.open) dialog.showModal();
  else if (!request && dialog.open) dialog.close();
});
</script>

<dialog
  bind:this={dialog}
  class="m-auto w-[min(24rem,calc(100vw-2rem))] rounded-[10px] border border-border-subtle bg-bg-surface p-0 text-text-primary shadow-2xl shadow-shadow-medium backdrop:bg-overlay-scrim open:animate-fade-in"
  aria-labelledby="confirm-title"
  oncancel={(event) => { event.preventDefault(); feedback.settle(false); }}
  onclick={(event) => { if (event.target === dialog) feedback.settle(false); }}
>
  {#if request}
    <form method="dialog" class="space-y-4 p-5" onsubmit={(event) => { event.preventDefault(); feedback.settle(true); }}>
      <div class="space-y-1.5">
        <h2 id="confirm-title" class="text-[14px] font-semibold">{request.title}</h2>
        {#if request.message}<p class="text-[12px] leading-5 text-text-tertiary">{request.message}</p>{/if}
      </div>
      <div class="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
        <button type="button" class="inline-flex min-h-9 items-center justify-center rounded-[5px] border border-border-subtle px-3 text-[12px] text-text-secondary transition-colors hover:bg-bg-hover hover:text-text-primary pointer-coarse:min-h-10" onclick={() => feedback.settle(false)}>{request.cancelLabel}</button>
        <!-- svelte-ignore a11y_autofocus -->
        <button type="submit" autofocus class="inline-flex min-h-9 items-center justify-center rounded-[5px] px-3 text-[12px] font-medium transition-colors pointer-coarse:min-h-10 {request.danger ? 'bg-error text-error-fg hover:bg-error/90' : 'bg-brand text-brand-contrast-fg hover:bg-brand-hover'}">{request.confirmLabel}</button>
      </div>
    </form>
  {/if}
</dialog>

<div class="pointer-events-none fixed inset-x-0 bottom-4 z-50 flex justify-center px-4 pb-[env(safe-area-inset-bottom)]" aria-live="polite">
  {#if feedback.toast}
    {#key feedback.toast.id}
      <div class="animate-fade-in rounded-full bg-text-primary px-3.5 py-2 text-[12px] font-medium text-bg-primary shadow-lg shadow-shadow-medium" role="status">{feedback.toast.message}</div>
    {/key}
  {/if}
</div>
