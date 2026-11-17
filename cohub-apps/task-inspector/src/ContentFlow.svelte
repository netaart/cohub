<script lang="ts">
import type { ContentBlock } from "@cohub/protocol/core";
import { Brain, ChevronRight, CircleAlert, Wrench } from "lucide-svelte";
import { displaySafeJson } from "$kit/task-run.ts";
import { getLocale } from "../../shared/src/runtime.svelte.ts";

type Props = { content: ContentBlock[]; streaming: boolean; terminal?: boolean };
let { content, streaming, terminal = false }: Props = $props();
const locale = $derived(getLocale());

type ToolResult = Extract<ContentBlock, { type: "tool_result" }>;
const results = $derived(
  new Map(
    content
      .filter((block): block is ToolResult => block.type === "tool_result")
      .map((block) => [block.tool_use_id, block]),
  ),
);
const paired = $derived(
  new Set(content.flatMap((block) => (block.type === "tool_use" && results.has(block.id) ? [block.id] : []))),
);

function resultText(result: ToolResult) {
  return typeof result.content === "string"
    ? result.content
    : result.content.map((block) => (block.type === "text" ? block.text : displaySafeJson(block, { locale }))).join("\n");
}
</script>

{#snippet details(icon: typeof Wrench, title: string, body: string, tone: "default" | "error" = "default", open = false)}
  {@const Icon = icon}
  <details class="group rounded-[7px] bg-bg-elevated/30" {open}>
    <summary class="flex min-h-9 list-none items-center gap-2 px-3 py-2 text-[12px] text-text-secondary [&::-webkit-details-marker]:hidden">
      <ChevronRight class="h-3.5 w-3.5 shrink-0 text-text-placeholder transition-transform group-open:rotate-90" />
      <Icon class="h-3.5 w-3.5 shrink-0 {tone === 'error' ? 'text-error-soft' : 'text-text-placeholder'}" />
      <span class="min-w-0 truncate font-mono">{title}</span>
    </summary>
    <pre class="max-h-[40vh] overflow-auto border-t border-border-subtle/40 px-3 py-2.5 font-mono text-[12px] leading-relaxed whitespace-pre-wrap break-all text-text-secondary [scrollbar-width:thin]">{body}</pre>
  </details>
{/snippet}

<div class="space-y-3">
  {#each content as block, index (index)}
    {#if block.type === "text"}
      <div class="whitespace-pre-wrap break-words text-text-secondary [overflow-wrap:anywhere] {terminal ? 'max-h-[60vh] overflow-auto rounded-[7px] bg-bg-elevated/35 px-3 py-2.5 font-mono text-[12px] leading-relaxed [scrollbar-width:thin]' : 'text-[13px] leading-6'}">{block.text}{#if streaming && index === content.length - 1}<span class="ml-0.5 inline-block h-3.5 w-1.5 translate-y-0.5 animate-pulse bg-text-tertiary"></span>{/if}</div>
    {:else if block.type === "thinking"}
      {@render details(Brain, block.thinking.split("\n")[0]?.slice(0, 120) || "…", block.thinking)}
    {:else if block.type === "tool_use"}
      {@const result = results.get(block.id)}
      {@render details(
        result?.is_error ? CircleAlert : Wrench,
        block.name,
        `${displaySafeJson(block.input, { locale })}${result ? `\n\n→ ${resultText(result)}` : ""}`,
        result?.is_error ? "error" : "default",
      )}
    {:else if block.type === "tool_result"}
      {#if !paired.has(block.tool_use_id)}{@render details(block.is_error ? CircleAlert : Wrench, block.tool_use_id, resultText(block), block.is_error ? "error" : "default")}{/if}
    {:else if block.type === "shell_command"}
      <pre class="rounded-[7px] bg-bg-elevated/35 px-3 py-2.5 font-mono text-[12px] whitespace-pre-wrap break-words text-text-primary">$ {block.command}</pre>
    {:else if block.type === "system_note"}
      <p class="text-[12px] text-text-tertiary">{block.text}</p>
    {:else if block.type === "image"}
      <img src={block.source.type === "url" ? block.source.url : `data:${block.source.media_type};base64,${block.source.data}`} alt="" loading="lazy" decoding="async" class="max-h-[60vh] max-w-full rounded-[6px] object-contain" />
    {/if}
  {/each}
</div>
