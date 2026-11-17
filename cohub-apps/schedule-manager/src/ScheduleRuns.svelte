<script lang="ts">
import type { TaskRunRecord } from "@neta-art/cohub";
import { onDestroy, onMount, untrack } from "svelte";
import { m } from "$messages";
import { asRecord } from "$kit/core.ts";
import { mergeTaskRunRecord, taskRunDuration, type TaskRunRealtimePatch } from "$kit/task-run.ts";
import { formatShortDateTime } from "$kit/time.ts";
import { client, subscribeSpace } from "../../shared/src/client.ts";
import { getLocale, runtime } from "../../shared/src/runtime.svelte.ts";
import { taskStatus } from "../../shared/src/status.ts";
import Button from "../../shared/src/ui/Button.svelte";
import Notice from "../../shared/src/ui/Notice.svelte";
import StatusBadge from "../../shared/src/ui/StatusBadge.svelte";
import { eyebrowClass } from "../../shared/src/ui/classes.ts";
import type { ViewProps } from "../../shared/src/view-types.ts";

type Props = Pick<ViewProps, "spaceId" | "authorize" | "navigateRelated"> & { jobId: string };
let { spaceId, jobId, authorize, navigateRelated }: Props = $props();

const locale = $derived(getLocale());
let runs = $state<TaskRunRecord[]>([]);
let cursor = $state<string | null>(null);
let loaded = $state(false);
let loading = $state(false);
let failed = $state(false);
let section = $state<HTMLElement | null>(null);
let hidden = $state(true);
let disposed = false;
let stopEvents: (() => void) | null = null;
let refreshTimer: ReturnType<typeof setTimeout> | null = null;

$effect(() => {
  const active = runtime.active;
  if (active && hidden) {
    hidden = false;
    if (loaded) untrack(() => void load("latest"));
  } else if (!active) hidden = true;
});

async function load(mode: "first" | "more" | "latest") {
  if (loading) return;
  loading = true;
  failed = false;
  try {
    if (!(await authorize(["taskrun.view"]))) throw new Error("denied");
    const result = await client.cronJobs.runs(jobId, { limit: 20, cursor: mode === "more" ? cursor : null });
    if (disposed) return;
    const merged = mode === "first" ? result.runs : [...runs, ...result.runs];
    const unique = [...new Map(merged.map((run) => [run.id, run])).values()];
    runs = mode === "more" ? unique : unique.sort((a, b) => runTime(b) - runTime(a));
    if (mode !== "latest") cursor = result.pageInfo.hasMore ? result.pageInfo.nextCursor : null;
    loaded = true;
    follow();
  } catch {
    if (!disposed) failed = true;
  } finally {
    if (!disposed) loading = false;
  }
}

function runTime(run: TaskRunRecord) {
  return Date.parse(run.scheduledAt ?? run.createdAt ?? "") || 0;
}

function follow() {
  if (stopEvents) return;
  stopEvents = subscribeSpace(spaceId, (event) => {
    const task = asRecord(asRecord(event.payload)?.task);
    if (!task || task.cronJobId !== jobId || !runtime.active) return;
    if (event.type === "task.created") {
      if (refreshTimer) clearTimeout(refreshTimer);
      refreshTimer = setTimeout(() => void load("latest"), 400);
    } else if (event.type === "task.updated") {
      // Patch in place so a running run keeps its scheduled position.
      if (runs.some((run) => run.id === task.id))
        runs = runs.map((run) =>
          run.id === task.id ? mergeTaskRunRecord(run, task as TaskRunRealtimePatch, spaceId) : run,
        );
    }
  });
}

onMount(() => {
  const observer = new IntersectionObserver(
    (entries) => {
      if (entries.some((entry) => entry.isIntersecting)) {
        observer.disconnect();
        void load("first");
      }
    },
    { rootMargin: "200px 0px" },
  );
  if (section) observer.observe(section);
  return () => observer.disconnect();
});
onDestroy(() => {
  disposed = true;
  stopEvents?.();
  if (refreshTimer) clearTimeout(refreshTimer);
});
</script>

<section bind:this={section} class="border-t border-border-subtle/70 pt-6" aria-labelledby="schedule-runs">
  <div class="mb-3">
    <h2 id="schedule-runs" class={eyebrowClass}>{m.cron_runs({}, { locale })}</h2>
    <p class="mt-1 text-[12px] text-text-tertiary">{loaded ? m.cron_runs_loaded({ count: runs.length }, { locale }) : m.cron_runs_not_loaded({}, { locale })}</p>
  </div>
  {#if failed}
    <Notice class="mb-2">{m.resource_app_error({}, { locale })}{#snippet action()}<Button variant="ghost" onclick={() => load(loaded ? "latest" : "first")}>{m.common_retry({}, { locale })}</Button>{/snippet}</Notice>
  {/if}
  {#if !loaded}
    {#if !failed}
    <div class="space-y-1.5" aria-busy="true">{#each Array(3) as _, index}<div class="h-10 animate-pulse rounded bg-bg-elevated/40" style:opacity={1 - index * 0.25}></div>{/each}</div>
    {/if}
  {:else if runs.length}
    <ul class="divide-y divide-border-subtle/50">
      {#each runs as run (run.id)}
        {@const status = taskStatus(run.status, locale)}
        <li>
          <button type="button" class="grid w-full grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1 rounded-[5px] px-1 py-2.5 text-left text-[12px] transition-colors hover:bg-bg-hover/70 sm:grid-cols-[110px_150px_80px_minmax(0,1fr)]" onclick={() => navigateRelated({ kind: "task", spaceId, taskRunId: run.id })}>
            <StatusBadge tone={status.tone} label={status.label} live={status.live} />
            <span class="justify-self-end font-mono text-text-placeholder sm:justify-self-start">{formatShortDateTime(run.scheduledAt ?? run.createdAt, locale)}</span>
            <span class="hidden font-mono text-text-placeholder sm:block">{taskRunDuration(run, locale)}</span>
            <span class="col-span-2 truncate text-[11px] sm:col-span-1 {run.errorMessage ? 'text-error-soft' : 'text-text-placeholder'}" title={run.errorMessage ?? run.id}>{run.errorMessage ?? run.id}</span>
          </button>
        </li>
      {/each}
    </ul>
    {#if cursor}<div class="mt-3"><Button variant="ghost" loading={loading} onclick={() => load("more")}>{m.cron_load_more({}, { locale })}</Button></div>{/if}
  {:else}
    <p class="py-6 text-[13px] text-text-tertiary">{m.cron_empty_runs({}, { locale })}</p>
  {/if}
</section>
