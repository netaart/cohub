<script lang="ts">
import StatusGlyph from "$lib/components/StatusGlyph.svelte";

type Props = {
	title?: string;
	content: string;
	isStreaming?: boolean;
};

const { title = "Thinking", content, isStreaming = false }: Props = $props();
let expanded = $state(false);
</script>

<div class="rounded-md border border-warning-soft/20 bg-warning-bg overflow-hidden">
  <button
    type="button"
    class="w-full px-3 py-2.5 flex items-center justify-between gap-3 text-left cursor-pointer hover:bg-warning-bg/80 transition-colors"
    onclick={() => (expanded = !expanded)}
  >
    <div>
      <div class="text-[10px] uppercase tracking-[0.18em] font-medium text-warning-soft">{title}</div>
      <div class="mt-1 text-xs text-warning-soft/80 flex items-center gap-2">
        <span>{expanded ? 'Hide reasoning' : 'Show reasoning'}</span>
        {#if isStreaming}
          <span class="inline-flex items-center gap-1 text-[10px] text-warning-soft/60">
            <StatusGlyph tone="warning" motion="active" class="[--status-glyph-size:6px]" />
            streaming
          </span>
        {/if}
      </div>
    </div>

    <div class="text-warning-soft text-xs">{expanded ? '▾' : '▸'}</div>
  </button>

  {#if expanded}
    <pre class="px-3 pb-3 whitespace-pre-wrap break-words text-[12px] leading-6 text-text-secondary border-t border-warning-soft/10">{content}</pre>
  {/if}
</div>
