<script lang="ts">
import type { CheckpointDiffFileResponse, CheckpointDiffSummary, CheckpointRecord } from "@neta-art/cohub";
import { isUuid } from "@cohub/protocol";
import { Activity, BarChart3, ChevronDown, GitCommitHorizontal, LoaderCircle, Network, Rocket } from "lucide-svelte";
import { onDestroy, untrack } from "svelte";
import { m } from "$messages";
import CheckpointDiffPanel from "$kit/CheckpointDiffPanel.svelte";
import { asRecord, intlTag } from "$kit/core.ts";
import { formatDiffBytes } from "$kit/diff.ts";
import { formatShortDateTime } from "$kit/time.ts";
import { client, webUrl } from "../../shared/src/client.ts";
import { getLocale } from "../../shared/src/runtime.svelte.ts";
import { resourceTitle } from "../../shared/src/shell/title.ts";
import Button from "../../shared/src/ui/Button.svelte";
import CopyButton from "../../shared/src/ui/CopyButton.svelte";
import Popover from "../../shared/src/ui/Popover.svelte";
import Section from "../../shared/src/ui/Section.svelte";
import type { ViewProps } from "../../shared/src/view-types.ts";
import CheckpointCreate from "./CheckpointCreate.svelte";
import CheckpointFiles from "./CheckpointFiles.svelte";

let props: ViewProps = $props();
const { target, spaceId } = untrack(() => props);

const locale = $derived(getLocale());
const checkpoint = $derived(props.detail?.kind === "checkpoint" ? props.detail.data : null);
const base = untrack(() => (target.base && isUuid(target.base) ? target.base : null));
const sourceTaskId = $derived.by(() => {
  const value = asRecord(checkpoint?.meta)?.sourceTaskRunId;
  return typeof value === "string" && value.trim() ? value : null;
});
const stats = $derived(asRecord(asRecord(checkpoint?.meta)?.stats));

let tab = $state<"changes" | "files">("changes");
let filesVisited = $state(false);
let diff = $state<CheckpointDiffSummary | null>(null);
let diffLoading = $state(true);
let diffError = $state<string | null>(null);
let compareOpen = $state(false);
let options = $state<CheckpointRecord[] | null>(null);
let optionsLoading = $state(false);
let disposed = false;
onDestroy(() => (disposed = true));

const api = client.space(spaceId).checkpoints(target.id);

async function loadDiff() {
  diffLoading = true;
  diffError = null;
  try {
    const result = await api.diff.summary({ base });
    if (!disposed) diff = result;
  } catch {
    if (!disposed) diffError = m.cdp_load_failed({}, { locale });
  } finally {
    if (!disposed) diffLoading = false;
  }
}

async function loadDiffFile(path: string): Promise<CheckpointDiffFileResponse | null> {
  try {
    return await api.diff.file(path, { base });
  } catch {
    return null;
  }
}

async function loadOptions() {
  if (options || optionsLoading) return;
  optionsLoading = true;
  try {
    const result = await client.space(spaceId).checkpoints.list({ limit: 30 });
    if (!disposed) options = result.checkpoints.filter((item) => item.id !== target.id);
  } catch {
    if (!disposed) options = [];
  } finally {
    if (!disposed) optionsLoading = false;
  }
}

function compareWith(id: string | null) {
  compareOpen = false;
  if (id !== base) props.openDetail(target.id, id ?? undefined);
}

function stat(key: string) {
  const value = stats?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
function count(value: number | null) {
  return value === null ? "—" : value.toLocaleString(intlTag(locale));
}
function optionLabel(item: CheckpointRecord) {
  return item.description?.trim() || item.commitHash.slice(0, 12);
}

let started = false;
$effect(() => {
  if (checkpoint && !started) {
    started = true;
    void loadDiff();
  }
});

const tabClass = (active: boolean) =>
  `relative inline-flex min-h-9 items-center px-1 text-[12px] font-medium transition-colors pointer-coarse:min-h-11 ${active ? "text-text-primary after:absolute after:inset-x-0 after:-bottom-px after:h-0.5 after:rounded-full after:bg-brand" : "text-text-tertiary hover:text-text-secondary"}`;
const linkClass = "font-mono text-[12px] break-all text-brand transition-colors hover:text-brand-hover";
</script>

{#if target.id === "new"}
  <CheckpointCreate {...props} />
{:else if checkpoint && props.detail}
  <article class="space-y-6 px-4 py-5 sm:space-y-7 sm:px-6">
    <header class="flex flex-col gap-4 border-b border-border-subtle/70 pb-5 lg:flex-row lg:items-start lg:justify-between">
      <div class="min-w-0 space-y-2.5">
        <div class="flex flex-wrap items-center gap-2">
          <span class="inline-flex items-center gap-1.5 rounded-full bg-brand-muted px-2 py-1 text-[10px] font-medium uppercase tracking-wider text-brand"><GitCommitHorizontal class="h-3 w-3" />{m.common_save({}, { locale })}</span>
          <time class="font-mono text-[11px] text-text-placeholder" datetime={checkpoint.createdAt}>{formatShortDateTime(checkpoint.createdAt, locale)}</time>
        </div>
        <h1 class="text-[22px] leading-snug font-semibold tracking-tight break-words text-text-primary sm:text-[26px]">{resourceTitle(props.detail, locale)}</h1>
        <div class="flex flex-wrap items-center gap-x-3 gap-y-1">
          <CopyButton value={checkpoint.id} label={m.cp_copy_id({}, { locale })} />
          <CopyButton value={checkpoint.commitHash} text={checkpoint.commitHash.slice(0, 12)} label={m.cp_copy_commit_hash({}, { locale })} />
        </div>
      </div>
      <Button variant="brand" icon={Rocket} block href={webUrl(`/spaces/new?checkpointId=${encodeURIComponent(checkpoint.id)}`)}>{m.cp_new_space({}, { locale })}</Button>
    </header>

    <div class="flex items-center gap-5 border-b border-border-subtle/70" role="tablist">
      <button type="button" role="tab" aria-selected={tab === "changes"} class={tabClass(tab === "changes")} onclick={() => (tab = "changes")}>{m.resource_app_changes({}, { locale })}</button>
      <button type="button" role="tab" aria-selected={tab === "files"} class={tabClass(tab === "files")} onclick={() => { tab = "files"; filesVisited = true; }}>{m.resource_app_files({}, { locale })}</button>
    </div>

    <div hidden={tab !== "changes"}>
      <div class="grid gap-6 lg:grid-cols-[minmax(0,1fr)_240px] lg:gap-8">
        <div class="min-w-0 space-y-3">
          <div class="flex flex-wrap items-center gap-x-3 gap-y-1">
            {#if base && base !== checkpoint.parentCheckpointId}
              <span class="text-[12px] text-text-tertiary">{m.cp_comparing_against({}, { locale })} <button type="button" class={linkClass} onclick={() => props.openDetail(base)}>{base.slice(0, 8)}</button></span>
              <button type="button" class="text-[11px] text-text-placeholder transition-colors hover:text-text-secondary" onclick={() => compareWith(null)}>{m.cp_reset({}, { locale })}</button>
            {:else if checkpoint.parentCheckpointId}
              <span class="text-[12px] text-text-placeholder">{m.cp_vs_parent({}, { locale })}</span>
            {/if}
            <div class="ml-auto">
              <Popover bind:open={compareOpen} label={m.cp_compare_against({}, { locale })} onopen={loadOptions} triggerClass="inline-flex min-h-7 items-center gap-1 rounded-[5px] px-2 text-[11px] text-text-tertiary transition-colors hover:bg-bg-hover hover:text-text-secondary pointer-coarse:min-h-9">
                {#snippet trigger()}{m.cp_compare({}, { locale })}<ChevronDown class="h-3 w-3" />{/snippet}
                <div class="border-b border-border-subtle/60 px-2.5 py-1.5 text-[10px] font-medium uppercase tracking-wider text-text-placeholder">{m.cp_compare_against({}, { locale })}</div>
                {#if checkpoint.parentCheckpointId}
                  <button type="button" class="flex w-full items-center justify-between gap-2 px-2.5 py-2 text-left text-[12px] text-text-secondary hover:bg-bg-hover" onclick={() => compareWith(null)}>
                    <span>{m.cp_parent_default({}, { locale })}</span>
                    {#if !base}<span class="text-[10px] text-brand">{m.cp_active({}, { locale })}</span>{/if}
                  </button>
                {/if}
                <div class="max-h-60 overflow-y-auto overscroll-contain [scrollbar-width:thin]">
                  {#if optionsLoading && !options}
                    <div class="flex items-center gap-2 px-2.5 py-3 text-[12px] text-text-tertiary"><LoaderCircle class="h-3.5 w-3.5 animate-spin" />{m.common_loading({}, { locale })}</div>
                  {:else if !options?.length}
                    <div class="px-2.5 py-3 text-[12px] text-text-tertiary">{m.cp_no_other_saves({}, { locale })}</div>
                  {:else}
                    {#each options as item (item.id)}
                      <button type="button" class="flex w-full min-w-0 flex-col gap-0.5 px-2.5 py-2 text-left hover:bg-bg-hover {base === item.id ? 'bg-bg-active' : ''}" onclick={() => compareWith(item.id)}>
                        <span class="truncate text-[12px] text-text-secondary">{optionLabel(item)}</span>
                        <span class="font-mono text-[10px] text-text-placeholder">{formatShortDateTime(item.createdAt, locale)}</span>
                      </button>
                    {/each}
                  {/if}
                </div>
              </Popover>
            </div>
          </div>
          <CheckpointDiffPanel
            {locale}
            summary={diff}
            loading={diffLoading}
            error={diffError}
            emptyLabel={checkpoint.parentCheckpointId || base ? m.cp_no_changes_from_parent({}, { locale }) : m.cp_initial_save({}, { locale })}
            cacheKey={`${checkpoint.id}:${base ?? "parent"}`}
            loadFile={loadDiffFile}
          />
        </div>

        <aside class="space-y-6">
          <Section label={m.cp_stats({}, { locale })} icon={BarChart3}>
            <div class="grid grid-cols-3 gap-3 lg:grid-cols-1 lg:gap-2">
              {#each [[m.cp_files({}, { locale }), count(stat("fileCount"))], [m.cp_changed({}, { locale }), count(stat("changedFileCount"))], [m.cp_size({}, { locale }), formatDiffBytes(stat("fileBytes"))]] as [label, value] (label)}
                <div class="min-w-0 lg:flex lg:items-baseline lg:justify-between">
                  <div class="text-[10px] uppercase tracking-wider text-text-placeholder">{label}</div>
                  <div class="mt-1 font-mono text-[15px] font-semibold tabular-nums text-text-primary lg:mt-0 lg:text-[13px]">{value}</div>
                </div>
              {/each}
            </div>
            <div class="mt-3 grid grid-cols-2 gap-x-4 gap-y-1.5 border-t border-border-subtle/60 pt-3 text-[12px]">
              {#each [[m.cp_added({}, { locale }), "addedFileCount"], [m.cp_modified({}, { locale }), "modifiedFileCount"], [m.cp_deleted({}, { locale }), "deletedFileCount"], [m.cp_renamed({}, { locale }), "renamedFileCount"]] as [label, key] (key)}
                <div class="flex items-center justify-between gap-2"><span class="text-text-tertiary">{label}</span><span class="font-mono tabular-nums text-text-secondary">{count(stat(key))}</span></div>
              {/each}
            </div>
          </Section>

          <Section label={m.cp_lineage({}, { locale })} icon={Network}>
            <dl class="grid grid-cols-[64px_minmax(0,1fr)] gap-x-3 gap-y-2 text-[12px]">
              <dt class="text-text-tertiary">{m.cp_parent({}, { locale })}</dt>
              <dd>{#if checkpoint.parentCheckpointId}<button type="button" class={linkClass} onclick={() => props.openDetail(checkpoint.parentCheckpointId!)}>{checkpoint.parentCheckpointId.slice(0, 8)}</button>{:else}<span class="text-text-secondary">{m.cp_root_save({}, { locale })}</span>{/if}</dd>
              <dt class="text-text-tertiary">{m.cp_forks({}, { locale })}</dt>
              <dd class="font-mono tabular-nums text-text-secondary">{checkpoint.forkCount}</dd>
            </dl>
            {#if sourceTaskId}
              <button type="button" class="mt-3 inline-flex min-h-7 items-center gap-1.5 text-[12px] text-text-tertiary transition-colors hover:text-brand" onclick={() => props.navigateRelated({ kind: "task", spaceId, taskRunId: sourceTaskId! })}><Activity class="h-3.5 w-3.5" />{m.cp_view_save_task({}, { locale })}</button>
            {/if}
          </Section>
        </aside>
      </div>
    </div>

    {#if filesVisited}
      <div hidden={tab !== "files"}><CheckpointFiles {spaceId} checkpointId={checkpoint.id} /></div>
    {/if}
  </article>
{/if}
