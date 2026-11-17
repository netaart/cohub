<script lang="ts">
import { mediaPreviewCandidates } from "@neta-art/cohub/media";
import { CalendarClock, GitCommitHorizontal, LayoutDashboard, MessageSquare } from "lucide-svelte";
import { onMount, untrack } from "svelte";
import { m } from "$messages";
import MediaImage from "$kit/MediaImage.svelte";
import MediaVideo from "$kit/MediaVideo.svelte";
import {
  appActionInput,
  checkpointIdFromTaskRun,
  formatDurationMs,
  generationBlockLabel,
  generationBlockMeta,
  generationBlockSource,
  generationBlockText,
  generationOutputBlocks,
  runCommandPayload,
  runCommandResultMeta,
  saveCheckpointProgressLabel,
  taskAttemptsLabel,
  taskContextLabel,
  taskIsStreaming,
  taskOutputContent,
  taskRunDuration,
} from "$kit/task-run.ts";
import { formatDateTime } from "$kit/time.ts";
import { getLocale, runtime } from "../../shared/src/runtime.svelte.ts";
import { resourceTitle } from "../../shared/src/shell/title.ts";
import { taskStatus } from "../../shared/src/status.ts";
import Button from "../../shared/src/ui/Button.svelte";
import CodeBlock from "../../shared/src/ui/CodeBlock.svelte";
import CopyButton from "../../shared/src/ui/CopyButton.svelte";
import Lightbox from "../../shared/src/ui/Lightbox.svelte";
import Notice from "../../shared/src/ui/Notice.svelte";
import Section from "../../shared/src/ui/Section.svelte";
import StatusBadge from "../../shared/src/ui/StatusBadge.svelte";
import type { ViewProps } from "../../shared/src/view-types.ts";
import ContentFlow from "./ContentFlow.svelte";

let { detail, spaceId, navigateRelated }: ViewProps = $props();

const OUTPUT_PREVIEW_SIZE = 1536;

const locale = $derived(getLocale());
const run = $derived(detail?.kind === "task" ? detail.data.run : null);
const progress = $derived(detail?.kind === "task" ? detail.data.progress : null);
const boards = $derived(detail?.kind === "task" ? (detail.data.boards ?? []) : []);
const streaming = $derived(run ? taskIsStreaming(run) : false);
const status = $derived(run ? taskStatus(run.status, locale) : null);
const command = $derived(run?.taskType === "run_command" ? runCommandPayload(run) : null);
const commandMeta = $derived(run ? runCommandResultMeta(run) : null);
const actionInput = $derived(run ? appActionInput(run) : null);
const checkpointId = $derived(checkpointIdFromTaskRun(run));
const generation = $derived(run ? generationOutputBlocks(run) : []);
const output = $derived(run ? taskOutputContent(run, progress) : []);
const images = $derived(
  generation.flatMap((block, index) => {
    const src = block.type === "image" ? generationBlockSource(block) : null;
    return src ? [{ index, item: { src, alt: generationBlockLabel(block, index) } }] : [];
  }),
);
let lightbox = $state<number | null>(null);

let now = $state(Date.now());
onMount(() => {
  const timer = setInterval(() => {
    if (streaming && runtime.active) now = Date.now();
  }, 1000);
  return () => clearInterval(timer);
});
const duration = $derived.by(() => {
  if (!run) return "—";
  if (run.finishedAt || !run.startedAt) return taskRunDuration(run, locale);
  return formatDurationMs(Math.max(0, now - Date.parse(run.startedAt)), locale);
});

// Like Web: a Save watched to completion continues to its Checkpoint, once.
let watched = untrack(() => streaming);
let followed = false;
$effect(() => {
  if (!run) return;
  if (streaming) watched = true;
  else if (watched && !followed && run.taskType === "save_checkpoint" && run.status === "completed" && checkpointId) {
    followed = true;
    void navigateRelated({ kind: "checkpoint", spaceId, checkpointId });
  }
});

const linkClass =
  "inline-flex min-h-6 items-center gap-1 text-text-secondary transition-colors hover:text-brand";
</script>

{#if run && status && detail}
  <article class="space-y-6 px-4 py-5 sm:space-y-8 sm:px-6">
    <header class="space-y-3 border-b border-border-subtle/70 pb-5">
      <h1 class="text-[24px] font-semibold tracking-tight break-words text-text-primary sm:text-[28px]">{resourceTitle(detail, locale)}</h1>
      <div class="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <StatusBadge tone={status.tone} label={status.label} live={status.live} />
        {#if run.userProfile?.displayName}
          <span class="inline-flex min-w-0 items-center gap-1.5 text-[11px] text-text-tertiary">
            {#if run.userProfile.avatarUrl}<img src={run.userProfile.avatarUrl} alt="" class="h-4 w-4 rounded-full object-cover" loading="lazy" />{/if}
            <span class="truncate">{run.userProfile.displayName}</span>
          </span>
        {/if}
        <CopyButton value={run.id} label={m.copy_task_id({}, { locale })} />
      </div>
      <div class="flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px] text-text-tertiary">
        {#if run.cronJobId}
          <button type="button" class={linkClass} onclick={() => navigateRelated({ kind: "cronjob", spaceId, cronjobId: run.cronJobId! })}><CalendarClock class="h-3.5 w-3.5" />{taskContextLabel(run, locale)}</button>
        {:else}
          <span>{taskContextLabel(run, locale)}</span>
        {/if}
        <span class="text-text-placeholder">·</span>
        <span>{taskAttemptsLabel(run, locale)}</span>
        {#if run.sessionId}
          <span class="text-text-placeholder">·</span>
          <button type="button" class={linkClass} onclick={() => navigateRelated({ kind: "session", spaceId, sessionId: run.sessionId! })}><MessageSquare class="h-3.5 w-3.5" />{m.resource_app_open_session({}, { locale })}</button>
        {/if}
      </div>
    </header>

    {#if run.errorMessage}
      <Notice title={m.task_section_error({}, { locale })}>{run.errorMessage}</Notice>
    {/if}

    {#if command?.command}
      <Section label={m.task_section_command({}, { locale })}>
        <div class="rounded-[8px] bg-bg-elevated/35 px-4 py-3">
          <pre class="font-mono text-[13px] leading-relaxed whitespace-pre-wrap break-words text-text-primary sm:text-[14px]">{command.command}</pre>
          <div class="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[12px] text-text-tertiary">
            <span class="font-mono">{command.cwd}</span>
            {#if commandMeta?.exitCode !== null && commandMeta?.exitCode !== undefined}<span class="font-mono {commandMeta.exitCode === 0 ? '' : 'text-error-soft'}">exit {commandMeta.exitCode}</span>{/if}
            {#if commandMeta?.durationMs !== null}<span>{formatDurationMs(commandMeta?.durationMs ?? null, locale)}</span>{/if}
          </div>
        </div>
      </Section>
    {/if}

    {#if actionInput !== null}
      <CodeBlock label={m.task_section_input({}, { locale })} value={actionInput} />
    {/if}

    {#if boards.length}
      <Section label={m.task_section_boards({}, { locale })} icon={LayoutDashboard}>
        <ul class="divide-y divide-border-subtle/60 rounded-[8px] bg-bg-elevated/35">
          {#each boards as board (board.boardId)}
            <li class="flex min-h-11 items-center gap-3 px-4 py-2.5">
              <span class="min-w-0 flex-1 truncate text-[13px] text-text-primary">{board.title || m.task_board_untitled({}, { locale })}</span>
              {#if board.itemIds.length > 1}<span class="shrink-0 font-mono text-[11px] text-text-tertiary">{m.task_board_items({ count: board.itemIds.length }, { locale })}</span>{/if}
            </li>
          {/each}
        </ul>
      </Section>
    {/if}

    {#if run.taskType === "save_checkpoint"}
      {@const stage = saveCheckpointProgressLabel(progress, locale)}
      <section class="flex flex-col gap-3 rounded-[8px] bg-bg-elevated/35 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
        <div class="min-w-0">
          <div class="text-[11px] font-medium uppercase tracking-wider text-text-placeholder">{m.task_section_checkpoint({}, { locale })}</div>
          <div class="mt-1 text-[13px] text-text-secondary">{checkpointId ? m.save_checkpoint_ready({}, { locale }) : (stage ?? m.task_waiting_checkpoint({}, { locale }))}</div>
        </div>
        {#if checkpointId}
          <Button variant="brand" icon={GitCommitHorizontal} block onclick={() => navigateRelated({ kind: "checkpoint", spaceId, checkpointId: checkpointId! })}>{m.task_view_checkpoint({}, { locale })}</Button>
        {/if}
      </section>
    {/if}

    {#if generation.length}
      <Section label={m.task_section_output({}, { locale })}>
        <div class="space-y-3">
          {#each generation as block, index (index)}
            {@const text = generationBlockText(block)}
            {@const src = generationBlockSource(block)}
            {@const meta = generationBlockMeta(block)}
            <figure class="rounded-[8px] bg-bg-elevated/35 p-3">
              <figcaption class="mb-2 flex items-center justify-between gap-3 text-[11px] text-text-tertiary">
                <span class="truncate">{generationBlockLabel(block, index)}</span>
                {#if meta}<span class="shrink-0 font-mono text-text-placeholder">{meta}</span>{/if}
              </figcaption>
              {#if text !== null}
                <div class="text-[13px] leading-6 whitespace-pre-wrap break-words text-text-secondary">{text}</div>
              {:else if block.type === "image" && src}
                <button type="button" class="block w-full cursor-zoom-in" aria-label={generationBlockLabel(block, index)} onclick={() => (lightbox = images.findIndex((image) => image.index === index))}>
                  <MediaImage candidates={mediaPreviewCandidates({ type: "image", url: src }, { size: OUTPUT_PREVIEW_SIZE })} alt={generationBlockLabel(block, index)} class="max-h-[60vh] w-full rounded-[6px] object-contain" />
                </button>
              {:else if block.type === "video" && src}
                <MediaVideo {src} controls playsinline class="max-h-[60vh] w-full rounded-[6px]" size={OUTPUT_PREVIEW_SIZE}><track kind="captions" label={m.track_generated_video({}, { locale })} /></MediaVideo>
              {:else if block.type === "audio" && src}
                <audio {src} controls preload="metadata" class="w-full"></audio>
              {:else}
                <pre class="max-h-[40vh] overflow-auto font-mono text-[12px] whitespace-pre-wrap break-all text-text-secondary">{JSON.stringify(block, null, 2)}</pre>
              {/if}
            </figure>
          {/each}
        </div>
      </Section>
    {:else if output.length}
      <Section label={m.task_section_output({}, { locale })}><ContentFlow content={output} {streaming} terminal={run.taskType === "run_command"} /></Section>
    {:else if streaming}
      {#if progress !== null && progress !== undefined && run.taskType !== "save_checkpoint"}
        <CodeBlock label={m.task_section_progress({}, { locale })} value={progress} maxStringLength={12_000} />
      {:else}
        <p class="flex items-center gap-2 py-2 text-[13px] text-text-tertiary"><StatusBadge tone="info" live />{m.task_waiting_output({}, { locale })}</p>
      {/if}
    {/if}

    <dl class="grid grid-cols-2 gap-x-8 gap-y-4 sm:grid-cols-4">
      {#each [[m.task_section_scheduled({}, { locale }), formatDateTime(run.scheduledAt, locale)], [m.task_section_started({}, { locale }), formatDateTime(run.startedAt, locale)], [m.task_section_finished({}, { locale }), formatDateTime(run.finishedAt, locale)], [m.task_section_duration({}, { locale }), duration]] as [label, value] (label)}
        <div class="min-w-0 space-y-1">
          <dt class="text-[11px] font-medium uppercase tracking-wider text-text-placeholder">{label}</dt>
          <dd class="font-mono text-[13px] tabular-nums text-text-primary">{value}</dd>
        </div>
      {/each}
    </dl>

    <CodeBlock label={m.task_section_payload({}, { locale })} value={run.payload} copyLabel={m.task_copy_payload({}, { locale })} />
    {#if run.result !== null && run.result !== undefined}
      <CodeBlock label={m.task_section_result({}, { locale })} value={run.result} copyLabel={m.task_copy_result({}, { locale })} collapsed={generation.length > 0 || output.length > 0} />
    {/if}
  </article>

  <Lightbox items={images.map((image) => image.item)} bind:index={lightbox} onclose={() => (lightbox = null)} />
{/if}
