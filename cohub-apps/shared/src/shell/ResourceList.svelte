<script lang="ts">
import type { ResourceAppKind } from "@cohub/protocol";
import {
  AppWindow,
  CalendarClock,
  ChevronDown,
  CircleAlert,
  GitCommitHorizontal,
  ListTodo,
  LockKeyhole,
  Plus,
  RefreshCw,
  SquareArrowOutUpRight,
} from "lucide-svelte";
import { onMount, untrack } from "svelte";
import { m } from "$messages";
import { taskRunDuration, taskTypeLabel } from "$kit/task-run";
import { formatTimeAgo } from "$kit/time";
import type { ResourceScope } from "../browser-route";
import { TASK_FILTERS, type ResourceRow, type TaskFilter } from "../resource-list";
import { getLocale, runtime } from "../runtime.svelte";
import { appStatus, appVisibility, scheduleStatus, taskStatus } from "../status";
import Button from "../ui/Button.svelte";
import IconButton from "../ui/IconButton.svelte";
import Notice from "../ui/Notice.svelte";
import Skeleton from "../ui/Skeleton.svelte";
import StateView from "../ui/StateView.svelte";
import StatusBadge from "../ui/StatusBadge.svelte";
import type { ListController } from "./list.svelte";

type Props = {
  kind: ResourceAppKind;
  list: ListController;
  scope: ResourceScope | null;
  busy: boolean;
  shown: boolean;
  onScope: (scope: ResourceScope) => void;
  onOpen: (row: ResourceRow) => void;
  onCreate: () => void;
  onRun: (row: ResourceRow) => void;
};
let { kind, list, scope, busy, shown, onScope, onOpen, onCreate, onRun }: Props = $props();

const locale = $derived(getLocale());
let filter = $state<TaskFilter>("all");
let now = $state(Date.now());
let sentinel = $state<HTMLElement | null>(null);

const context = $derived(runtime.context);
const sourceSpace = $derived(context?.invocation?.spaceId);
const sourceSession = $derived(context?.invocation?.sessionId);
const creatable = $derived(scope?.kind === "space" && (kind === "checkpoint" || kind === "cronjob"));
const heading = $derived(
  {
    task: m.sidebar_tasks,
    checkpoint: m.sidebar_saves,
    cronjob: m.side_panel_tab_scheduled,
    app: m.side_panel_tab_apps,
  }[kind]({}, { locale }),
);
const spaceName = $derived(
  scope?.kind === "space"
    ? (list.spaceNames[scope.spaceId] ??
        (context?.shell?.space?.id === scope.spaceId ? context.shell.space.name : null) ??
        m.resource_app_space({}, { locale }))
    : m.resource_app_choose_space({}, { locale }),
);
const taskScope = $derived(
  scope?.kind === "mine" ? "mine" : scope?.kind === "space" && scope.sessionId ? "session" : "space",
);

$effect(() => {
  const next = scope;
  const value = filter;
  const viewer = runtime.viewer;
  untrack(() => list.query(next, value, viewer));
});
$effect(() => {
  const active = shown && runtime.active;
  untrack(() => list.setActive(active));
});
let grant = { key: "", allowed: false };
$effect(() => {
  const key = JSON.stringify([scope, runtime.viewer]);
  const allowed = list.allowed;
  if (grant.key === key && grant.allowed && !allowed) untrack(() => list.revoke());
  grant = { key, allowed };
});
$effect(() => {
  const element = sentinel;
  if (!element) return;
  const observer = new IntersectionObserver(
    (entries) => {
      if (entries.some((entry) => entry.isIntersecting) && list.cursor && !list.loadingMore && !list.refreshing)
        void list.load("append");
    },
    { rootMargin: "320px 0px" },
  );
  observer.observe(element);
  return () => observer.disconnect();
});
onMount(() => {
  const timer = setInterval(() => {
    if (runtime.active) now = Date.now();
  }, 30_000);
  return () => clearInterval(timer);
});

async function pickSpace() {
  if (busy) return;
  const spaceId = await list.pickSpace();
  if (spaceId) onScope({ kind: "space", spaceId });
}

function ago(value: string | null) {
  return value ? formatTimeAgo(Date.parse(value), now, locale) : "";
}

function rowTitle(row: ResourceRow) {
  switch (row.kind) {
    case "task":
      return row.action ? m.task_type_app_action({ action: row.action }, { locale }) : taskTypeLabel(row.taskType, locale);
    case "checkpoint":
      return row.description || m.resource_app_save_title({ id: row.commitHash.slice(0, 8) }, { locale });
    default:
      return row.title;
  }
}

const filterLabel = {
  all: m.resource_app_filter_all,
  active: m.resource_app_active,
  failed: m.resource_app_failed,
  completed: m.resource_app_completed,
} satisfies Record<TaskFilter, unknown>;

const chip =
  "inline-flex min-h-7 shrink-0 items-center rounded-full px-2.5 text-[12px] transition-colors pointer-coarse:min-h-9";
const chipState = (active: boolean) =>
  active ? "bg-bg-active text-text-primary" : "text-text-tertiary hover:bg-bg-hover hover:text-text-secondary";
</script>

<section class="px-3 pt-5 pb-10 sm:px-6" aria-labelledby="resource-list-heading">
  <header class="mb-4 flex items-start justify-between gap-3 px-1">
    <div class="min-w-0 flex-1">
      <h1 id="resource-list-heading" class="text-[22px] font-semibold tracking-tight text-text-primary">{heading}</h1>
      {#if kind !== "task" || scope?.kind !== "mine"}
        <button type="button" class="-ml-1.5 mt-1 inline-flex min-h-7 max-w-full items-center gap-1 rounded-[5px] px-1.5 text-[12px] text-text-tertiary transition-colors hover:bg-bg-hover hover:text-text-primary disabled:opacity-50 pointer-coarse:min-h-9" disabled={busy || list.authorizing} onclick={pickSpace} title={m.resource_app_choose_space({}, { locale })}>
          <span class="truncate">{spaceName}</span><ChevronDown class="h-3.5 w-3.5 shrink-0" />
        </button>
      {/if}
    </div>
    <div class="flex shrink-0 items-center gap-1">
      {#if scope}<IconButton icon={RefreshCw} label={m.resource_app_retry({}, { locale })} spinning={list.refreshing} disabled={busy || list.refreshing} onclick={() => void list.load("refresh")} />{/if}
      {#if creatable}<Button variant="primary" icon={Plus} disabled={busy} onclick={onCreate}>{kind === "cronjob" ? m.resource_app_new_schedule({}, { locale }) : m.cp_new_save({}, { locale })}</Button>{/if}
    </div>
  </header>

  {#if kind === "task"}
    <div class="mb-3 flex flex-col gap-2 px-1 sm:flex-row sm:items-center sm:justify-between">
      <div class="flex gap-1 overflow-x-auto [scrollbar-width:none]" role="tablist" aria-label={m.resource_app_scope({}, { locale })}>
        {#if sourceSpace}
          <button type="button" role="tab" aria-selected={taskScope === "space"} class="{chip} {chipState(taskScope === 'space')}" disabled={busy} onclick={() => onScope({ kind: "space", spaceId: sourceSpace! })}>{m.resource_app_space({}, { locale })}</button>
          {#if sourceSession}
            <button type="button" role="tab" aria-selected={taskScope === "session"} class="{chip} {chipState(taskScope === 'session')}" disabled={busy} onclick={() => onScope({ kind: "space", spaceId: sourceSpace!, sessionId: sourceSession })}>{m.resource_app_session({}, { locale })}</button>
          {/if}
        {/if}
        <button type="button" role="tab" aria-selected={taskScope === "mine"} class="{chip} {chipState(taskScope === 'mine')}" disabled={busy} onclick={() => onScope({ kind: "mine" })}>{m.resource_app_mine({}, { locale })}</button>
      </div>
      <div class="flex gap-1 overflow-x-auto [scrollbar-width:none]" role="radiogroup" aria-label={m.resource_app_status({}, { locale })}>
        {#each TASK_FILTERS as value (value)}
          <button type="button" role="radio" aria-checked={filter === value} class="{chip} {filter === value ? 'text-text-primary underline decoration-brand decoration-2 underline-offset-[6px]' : 'text-text-tertiary hover:text-text-secondary'}" onclick={() => (filter = value)}>{filterLabel[value]({}, { locale })}</button>
        {/each}
      </div>
    </div>
  {/if}

  {#if list.error === "stale"}<Notice tone="info" class="mb-2">{m.resource_app_stale({}, { locale })}</Notice>{/if}

  {#if !scope}
    <StateView icon={LockKeyhole} title={m.resource_app_choose_space_hint({}, { locale })}>
      {#snippet action()}<Button variant="primary" loading={list.authorizing} onclick={pickSpace}>{m.resource_app_choose_space({}, { locale })}</Button>{/snippet}
    </StateView>
  {:else if list.denied}
    <StateView icon={LockKeyhole} title={m.resource_app_denied({}, { locale })} description={m.resource_app_denied_hint({}, { locale })}>
      {#snippet action()}<Button variant="primary" loading={list.authorizing} onclick={() => void list.requestAccess()}>{m.resource_app_access({}, { locale })}</Button>{/snippet}
    </StateView>
  {:else if list.loading && !list.rows.length}
    <div aria-busy="true" aria-label={m.resource_app_loading({}, { locale })}><Skeleton variant="rows" /></div>
  {:else if list.error === "error" && !list.rows.length}
    <StateView icon={CircleAlert} title={m.resource_app_list_error({}, { locale })}>
      {#snippet action()}<Button variant="outline" icon={RefreshCw} loading={list.refreshing} onclick={() => void list.load("replace")}>{m.common_retry({}, { locale })}</Button>{/snippet}
    </StateView>
  {:else if !list.rows.length}
    {@const empty = {
      task: { icon: ListTodo, title: filter === "all" ? m.resource_app_empty_tasks({}, { locale }) : m.resource_app_empty_filtered({}, { locale }), hint: m.resource_app_empty_tasks_hint({}, { locale }) },
      checkpoint: { icon: GitCommitHorizontal, title: m.resource_app_empty_saves({}, { locale }), hint: m.resource_app_empty_saves_hint({}, { locale }) },
      cronjob: { icon: CalendarClock, title: m.resource_app_empty_schedules({}, { locale }), hint: m.resource_app_empty_schedules_hint({}, { locale }) },
      app: { icon: AppWindow, title: m.resource_app_empty_apps({}, { locale }), hint: m.resource_app_empty_apps_hint({}, { locale }) },
    }[kind]}
    <StateView icon={empty.icon} title={empty.title} description={empty.hint}>
      {#snippet action()}{#if creatable}<Button variant="outline" icon={Plus} disabled={busy} onclick={onCreate}>{kind === "cronjob" ? m.resource_app_new_schedule({}, { locale }) : m.cp_new_save({}, { locale })}</Button>{/if}{/snippet}
    </StateView>
  {:else}
    <ul class="divide-y divide-border-subtle/50" aria-label={heading}>
      {#each list.rows as row (row.id)}
        <li class="group/row flex items-center gap-1 [content-visibility:auto] [contain-intrinsic-size:auto_58px]">
          <button type="button" class="flex min-h-[58px] min-w-0 flex-1 items-center gap-3 rounded-[6px] px-2 py-2.5 text-left transition-colors hover:bg-bg-hover/70 disabled:opacity-60" disabled={busy} onclick={() => onOpen(row)}>
            <span class="flex w-3.5 shrink-0 justify-center">
              {#if row.kind === "task"}{@const status = taskStatus(row.status, locale)}<StatusBadge tone={status.tone} live={status.live} />
              {:else if row.kind === "cronjob"}<StatusBadge tone={scheduleStatus(row.enabled, locale).tone} />
              {:else if row.kind === "app"}<StatusBadge tone={appStatus(row.status, locale).tone} />
              {:else}<GitCommitHorizontal class="h-3.5 w-3.5 text-text-placeholder" />{/if}
            </span>
            <span class="min-w-0 flex-1">
              <span class="block truncate text-[13px] font-medium text-text-primary">{rowTitle(row)}</span>
              <span class="mt-0.5 flex min-w-0 items-center gap-1.5 text-[12px] text-text-tertiary">
                {#if row.kind === "task"}
                  {@const status = taskStatus(row.status, locale)}
                  <span class="shrink-0">{status.label}</span>
                  {#if row.status === "failed" && row.errorMessage}<span class="text-text-placeholder">·</span><span class="truncate text-error-soft">{row.errorMessage}</span>
                  {:else if row.finishedAt}<span class="text-text-placeholder">·</span><span class="shrink-0 font-mono text-[11px]">{taskRunDuration(row, locale)}</span>{/if}
                {:else if row.kind === "checkpoint"}
                  <span class="shrink-0 font-mono text-[11px]">{row.commitHash.slice(0, 8)}</span>
                  {#if row.changedFiles !== null}<span class="text-text-placeholder">·</span><span class="truncate">{row.changedFiles === 1 ? m.cdp_files_one({ count: row.changedFiles }, { locale }) : m.cdp_files_many({ count: row.changedFiles }, { locale })}</span>{/if}
                {:else if row.kind === "cronjob"}
                  <span class="shrink-0 font-mono text-[11px]">{row.cronExpression}</span><span class="text-text-placeholder">·</span><span class="truncate">{row.timezone}</span>
                  {#if !row.enabled}<span class="text-text-placeholder">·</span><span class="shrink-0">{m.cron_paused({}, { locale })}</span>{/if}
                {:else}
                  <span class="truncate font-mono text-[11px]">{row.slug}</span><span class="text-text-placeholder">·</span><span class="shrink-0 font-mono text-[11px]">v{row.latestVersion}</span><span class="text-text-placeholder">·</span><span class="shrink-0">{appVisibility(row.visibility, locale).label}</span>
                {/if}
              </span>
            </span>
            <time class="shrink-0 self-start pt-0.5 text-[11px] tabular-nums text-text-placeholder" datetime={row.createdAt ?? undefined}>{ago(row.createdAt)}</time>
          </button>
          {#if row.kind === "app"}
            <IconButton icon={SquareArrowOutUpRight} label={m.resource_app_open({}, { locale })} disabled={busy || row.status === "disabled"} onclick={() => onRun(row)} />
          {/if}
        </li>
      {/each}
    </ul>
    {#if list.cursor}
      <div bind:this={sentinel} class="flex justify-center pt-4">
        <Button variant="ghost" loading={list.loadingMore} onclick={() => void list.load("append")}>{m.resource_app_more({}, { locale })}</Button>
      </div>
    {/if}
  {/if}
</section>
