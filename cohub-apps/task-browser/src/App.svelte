<script lang="ts">
import type { TaskRunRecord } from "@neta-art/cohub";
import { createCohubClient } from "@neta-art/cohub";
import {
  AlertCircle,
  Check,
  ChevronDown,
  FolderKey,
  Grid2X2,
  Image as ImageIcon,
  List,
  LoaderCircle,
  LockKeyhole,
  Maximize2,
  Play,
  RefreshCw,
  Volume2,
  X,
} from "@lucide/svelte";
import { onMount } from "svelte";
import { accessRequestFor } from "./access";
import { detailOutputSource } from "./media";
import { taskBrowserScopes, type TaskBrowserScope } from "./scope";
import {
  clearTaskCache,
  readTaskCache,
  writeTaskCache,
  type TaskPageInfo,
} from "./task-cache";
import {
  type GenerationOutput,
  type GenerationTask,
  mergeTaskRefresh,
  toGenerationTask,
} from "./task-output";

const client = createCohubClient();
const PAGE_SIZE = 30;
type StatusFilter = "all" | "active" | TaskRunRecord["status"];
type ViewMode = "gallery" | "list";
type LightboxItem = { task: GenerationTask; output: GenerationOutput; src: string };
type GalleryItem = { task: GenerationTask; output: GenerationOutput | null };
let scopes = $state<TaskBrowserScope[]>([{ kind: "mine" }]);
let selectedScope = $state<TaskBrowserScope>({ kind: "mine" });
let status = $state<StatusFilter>("all");
let view = $state<ViewMode>("gallery");
let tasks = $state<GenerationTask[]>([]);
let loading = $state(true);
let loadingMore = $state(false);
let refreshing = false;
let authorizing = $state(false);
let error = $state<string | null>(null);
let accessDenied = $state(false);
let pageInfo = $state<TaskPageInfo>({ hasMore: false, nextCursor: null });
let lightbox = $state<LightboxItem | null>(null);
let lightboxLoadingId = $state<string | null>(null);
let requestVersion = 0;
let appReady = $state(false);
let homeSpace = $state<{ id: string; name: string | null } | null>(null);
let sourceSpaceId = $state<string | null>(null);
let cacheIdentity = $state<{ appId: string; viewerId: string | null } | null>(null);
let authorizingSpace = $state(false);

const scopeLabel = (scope: TaskBrowserScope) =>
  scope.kind === "session" ? "Session" : scope.kind === "space" ? spaceDisplayName(scope.spaceId) ?? "Space" : "Mine";

function isSourceScope(scope: TaskBrowserScope) {
  return scope.kind === "session" || (scope.kind === "space" && scope.spaceId === sourceSpaceId);
}

const scopeTitle = (scope: TaskBrowserScope) => {
  if (scope.kind === "mine") return "Every generation task you own";
  const name = spaceDisplayName(scope.spaceId);
  if (scope.kind === "session") return name ? `Source session in ${name}` : "Source session that opened this app";
  if (isSourceScope(scope)) return name ? `Source Space: ${name}` : "Source Space that opened this app";
  return name ? `Tasks in ${name}` : "Tasks in the selected Space";
};

function taskFilters(scope: TaskBrowserScope, cursor?: string | null) {
  return {
    taskType: "generation",
    limit: PAGE_SIZE,
    ...(scope.kind === "session" ? { spaceId: scope.spaceId, sessionId: scope.sessionId } : {}),
    ...(scope.kind === "space" ? { spaceId: scope.spaceId } : {}),
    ...(status === "all" ? {} : { status }),
    ...(cursor ? { cursor } : {}),
  };
}

function messageFrom(error: unknown) {
  return error instanceof Error ? error.message : "Tasks could not be loaded.";
}

function isAccessError(cause: unknown) {
  const code = (cause as { status?: unknown } | null)?.status;
  return code === 401 || code === 403;
}

type LoadMode = "replace" | "append" | "refresh";

function taskQueryKey() {
  return `${scopeKey(selectedScope)}:${status}`;
}

async function fetchTasks(mode: LoadMode, version: number, cacheKey: string) {
  if (mode === "append") {
    loadingMore = true;
  } else if (mode === "refresh") {
    refreshing = true;
  }
  try {
    const response = await client.tasks.list(
      taskFilters(selectedScope, mode === "append" ? pageInfo.nextCursor : null),
    );
    if (version !== requestVersion) return;
    const next = (response.runs ?? []).map(toGenerationTask);
    if (mode === "replace") {
      tasks = next;
    } else if (mode === "append") {
      tasks = Array.from(
        new Map([...tasks, ...next].map((task) => [task.id, task])).values(),
      );
    } else {
      tasks = mergeTaskRefresh(tasks, next);
    }
    if (mode !== "refresh") {
      pageInfo = response.pageInfo ?? { hasMore: false, nextCursor: null };
    }
    writeTaskCache(cacheIdentity, cacheKey, { tasks, pageInfo });
  } catch (cause) {
    if (version !== requestVersion) return;
    if (isAccessError(cause)) {
      tasks = [];
      pageInfo = { hasMore: false, nextCursor: null };
      clearTaskCache(cacheIdentity, cacheKey);
      accessDenied = true;
      error = messageFrom(cause);
    } else {
      accessDenied = false;
      error = tasks.length > 0 && mode === "refresh"
        ? "Could not refresh tasks. Showing cached results."
        : messageFrom(cause);
    }
  } finally {
    if (version === requestVersion) {
      if (mode === "refresh") refreshing = false;
      loading = false;
      loadingMore = false;
    }
  }
}

async function load(mode: LoadMode = "replace") {
  if (mode === "refresh" && (loading || loadingMore || refreshing)) return;
  const version = ++requestVersion;
  const cacheKey = taskQueryKey();
  if (mode === "replace") {
    loading = true;
    refreshing = false;
    error = null;
    accessDenied = false;
    const cached = readTaskCache(cacheIdentity, cacheKey);
    if (cached) {
      tasks = cached.tasks;
      pageInfo = cached.pageInfo;
      loading = false;
      void fetchTasks("refresh", version, cacheKey);
      return;
    }
  }
  await fetchTasks(mode, version, cacheKey);
}

const accessHint = $derived.by(() => {
  if (selectedScope.kind === "mine") {
    return "Grant user.taskrun.list to list every generation task you own.";
  }
  const name = spaceDisplayName(selectedScope.spaceId);
  return `Grant taskrun.view on ${name ?? "this space"} to browse its tasks.`;
});

async function requestAccess() {
  authorizing = true;
  error = null;
  try {
    const request = accessRequestFor(selectedScope);
    const result = await client.auth.authorize({
      scopes: request.scopes,
      target: selectedScope.kind === "mine" ? { kind: "account" } : { kind: "space", spaceId: selectedScope.spaceId },
    });
    if (result.status !== "granted") {
      error = "Access was not granted.";
      return;
    }
    if (result.target.kind === "space" && selectedScope.kind !== "mine" && result.target.spaceId !== selectedScope.spaceId) {
      selectedScope = { kind: "space", spaceId: result.target.spaceId };
      resetResultsForQuery();
    }
    await load();
  } catch (cause) {
    error = messageFrom(cause);
  } finally {
    authorizing = false;
  }
}

function resetResultsForQuery() {
  tasks = [];
  pageInfo = { hasMore: false, nextCursor: null };
  accessDenied = false;
  error = null;
}

function selectScope(scope: TaskBrowserScope) {
  if (sameScope(scope, selectedScope)) return;
  selectedScope = scope;
  resetResultsForQuery();
  void load();
}

function selectStatus(next: StatusFilter) {
  if (next === status) return;
  status = next;
  resetResultsForQuery();
  void load();
}

function dateGroup(task: GenerationTask) {
  const date = new Date(task.createdAt);
  const now = new Date();
  if (date.toDateString() === now.toDateString()) return "Today";
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (date.toDateString() === yesterday.toDateString()) return "Yesterday";
  return date.toLocaleDateString(undefined, { month: "long", year: "numeric" });
}

const groups = $derived.by(() => {
  const grouped = new Map<string, GalleryItem[]>();
  for (const task of tasks) {
    const key = dateGroup(task);
    const group = grouped.get(key) ?? [];
    if (task.outputs.length === 0) {
      group.push({ task, output: null });
    } else {
      group.push(...task.outputs.map((output) => ({ task, output })));
    }
    grouped.set(key, group);
  }
  return [...grouped.entries()];
});

function relativeTime(value: string) {
  const elapsed = Date.now() - Date.parse(value);
  if (!Number.isFinite(elapsed) || elapsed < 0) return "now";
  const minutes = Math.floor(elapsed / 60_000);
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return new Date(value).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function statusLabel(taskStatus: TaskRunRecord["status"]) {
  if (taskStatus === "pending") return "Queued";
  if (taskStatus === "running") return "Running";
  if (taskStatus === "completed") return "Completed";
  return "Failed";
}

async function openOutput(task: GenerationTask, output: GenerationOutput) {
  if (output.type === "text") return;
  let src = output.url;
  if (!src && output.deferred) {
    lightboxLoadingId = task.id;
    try {
      const detail = await client.tasks.get(task.id);
      src = detailOutputSource(detail.run.result, output.index);
    } catch (cause) {
      error = messageFrom(cause);
    } finally {
      lightboxLoadingId = null;
    }
  }
  if (src) lightbox = { task, output, src };
}

function closeLightbox() {
  lightbox = null;
}

function applyRuntimeContext(context: Awaited<ReturnType<typeof client.context>>) {
  appReady = Boolean(context?.app?.id);
  homeSpace = context?.space ? { id: context.space.id, name: context.space.name ?? null } : null;
  sourceSpaceId = context?.invocation?.spaceId ?? null;
  cacheIdentity = context?.app?.id
    ? { appId: context.app.id, viewerId: context.viewer?.userUuid ?? null }
    : null;
}

let spaceNames = $state<Record<string, string>>({});

function spaceDisplayName(spaceId: string) {
  if (homeSpace && spaceId === homeSpace.id) return homeSpace.name || null;
  return spaceNames[spaceId] ?? null;
}

async function resolveSpaceName(spaceId: string) {
  if (spaceDisplayName(spaceId)) return;
  try {
    const space = await client.space(spaceId).get();
    if (space?.name) spaceNames = { ...spaceNames, [spaceId]: space.name };
  } catch {
    // Cosmetic only — keep the generic label.
  }
}

async function requestSpaceAccess() {
  authorizingSpace = true;
  error = null;
  try {
    const result = await client.auth.authorize({
      target: { kind: "pick-space" },
      scopes: ["taskrun.view"],
      reason: "Browse generation tasks in a Space you choose.",
      alwaysAsk: true,
    });
    if (result.status !== "granted" || result.target.kind !== "space") return;
    const space = { kind: "space", spaceId: result.target.spaceId } as const;
    scopes = [
      ...scopes.filter((scope) => !(scope.kind === "space" && scope.spaceId === space.spaceId)),
      space,
    ];
    if (result.target.name) spaceNames = { ...spaceNames, [space.spaceId]: result.target.name };
    selectedScope = space;
    resetResultsForQuery();
    await load();
  } catch (cause) {
    error = messageFrom(cause);
  } finally {
    authorizingSpace = false;
  }
}

function scopeKey(scope: TaskBrowserScope) {
  if (scope.kind === "session") return `${scope.kind}:${scope.spaceId}:${scope.sessionId}`;
  if (scope.kind === "space") return `${scope.kind}:${scope.spaceId}`;
  return scope.kind;
}

function sameScope(left: TaskBrowserScope, right: TaskBrowserScope) {
  return scopeKey(left) === scopeKey(right);
}

onMount(() => {
  let poll: ReturnType<typeof setInterval> | null = null;
  void client.context().then((runtimeContext) => {
    applyRuntimeContext(runtimeContext);
    sourceSpaceId = runtimeContext?.invocation?.spaceId ?? null;
    scopes = taskBrowserScopes(runtimeContext?.invocation);
    selectedScope = scopes[0] ?? { kind: "mine" };
    if (selectedScope.kind !== "mine") void resolveSpaceName(selectedScope.spaceId);
    void load();
  }).catch((cause) => {
    loading = false;
    error = messageFrom(cause);
  });
  const stopContextWatch = client.app.onContextChanged((context) => applyRuntimeContext(context));

  const refreshVisibleActiveTasks = () => {
    if (document.visibilityState === "visible" && tasks.some((task) => task.status === "pending" || task.status === "running")) {
      void load("refresh");
    }
  };
  poll = setInterval(refreshVisibleActiveTasks, 5_000);
  document.addEventListener("visibilitychange", refreshVisibleActiveTasks);
  return () => {
    if (poll) clearInterval(poll);
    stopContextWatch();
    document.removeEventListener("visibilitychange", refreshVisibleActiveTasks);
  };
});
</script>

<svelte:window
  onkeydown={(event) => {
    if (event.key !== "Escape") return;
    closeLightbox();
  }}
/>

<div class="shell">
  <header class="toolbar">
    <div class="scope-control" aria-label="Task scope">
      {#each scopes as scope (scopeKey(scope))}
        <button
          type="button"
          class:active={sameScope(selectedScope, scope)}
          class:source-scope={isSourceScope(scope)}
          title={scopeTitle(scope)}
          onclick={() => selectScope(scope)}
        >{scopeLabel(scope)}</button>
      {/each}
    </div>

    <div class="toolbar-actions">
      {#if appReady}
        <button
          class="icon-button"
          type="button"
          title="Choose another Space"
          aria-label="Choose another Space"
          disabled={authorizingSpace}
          onclick={requestSpaceAccess}
        >
          {#if authorizingSpace}<LoaderCircle class="spin" />{:else}<FolderKey />{/if}
        </button>
      {/if}
      <label class="status-select">
        <span class="sr-only">Status</span>
        <select value={status} onchange={(event) => selectStatus(event.currentTarget.value as StatusFilter)}>
          <option value="all">All</option>
          <option value="active">Active</option>
          <option value="completed">Completed</option>
          <option value="failed">Failed</option>
        </select>
        <ChevronDown aria-hidden="true" />
      </label>
      <div class="view-control" aria-label="View">
        <button type="button" class:active={view === "gallery"} title="Gallery" onclick={() => (view = "gallery")}><Grid2X2 /><span class="sr-only">Gallery</span></button>
        <button type="button" class:active={view === "list"} title="List" onclick={() => (view = "list")}><List /><span class="sr-only">List</span></button>
      </div>
      <button class="icon-button" type="button" title="Refresh" aria-label="Refresh" disabled={loading} onclick={() => load()}>
        <RefreshCw class={loading ? "spin" : ""} />
      </button>
    </div>
  </header>

  <main>
    {#if loading && tasks.length === 0}
      <div class="center-state"><LoaderCircle class="spin" /><span>Loading tasks</span></div>
    {:else if accessDenied}
      <div class="center-state access-state">
        <LockKeyhole />
        <strong>Task access required</strong>
        <small>{accessHint}</small>
        <button type="button" disabled={authorizing} onclick={requestAccess}>
          {#if authorizing}<LoaderCircle class="spin" />{/if}
          Authorize
        </button>
      </div>
    {:else if error && tasks.length === 0}
      <div class="center-state error-state">
        <AlertCircle />
        <strong>Could not load tasks</strong>
        <small>{error}</small>
        <button type="button" onclick={() => load()}>Retry</button>
      </div>
    {:else if tasks.length === 0}
      <div class="center-state empty-state"><ImageIcon /><strong>No generation tasks</strong></div>
    {:else}
      {#if error}<div class="inline-error"><AlertCircle />{error}</div>{/if}
      <div class:list-view={view === "list"} class:gallery-view={view === "gallery"}>
        {#each groups as [label, items] (label)}
          <section class="task-group">
            <div class="group-heading"><h2>{label}</h2><span>{items.length}</span></div>
            <div class="task-grid">
              {#each items as item (`${item.task.id}:${item.output?.index ?? "status"}`)}
                {@const task = item.task}
                {@const output = item.output}
                <article class="task-card">
                  <button
                    type="button"
                    class="task-preview"
                    disabled={!output || output.type === "text" || lightboxLoadingId === task.id}
                    onclick={() => output && openOutput(task, output)}
                  >
                    {#if lightboxLoadingId === task.id}
                      <LoaderCircle class="spin preview-loader" />
                    {:else if output?.type === "image" && output.url}
                      <img src={output.url} alt={output.label ?? task.prompt ?? "Generated image"} loading="lazy" />
                    {:else if output?.type === "video" && (output.poster || output.url)}
                      {#if output.poster}<img src={output.poster} alt={output.label ?? "Generated video"} loading="lazy" />{:else}<video src={output.url ?? undefined} muted preload="metadata"></video>{/if}
                      <span class="play"><Play /></span>
                    {:else if output?.type === "audio"}
                      <div class="media-placeholder"><Volume2 /><span>Audio</span></div>
                    {:else if output?.deferred}
                      <div class="media-placeholder"><ImageIcon /><span>Media ready</span></div>
                    {:else if output?.text}
                      <p class="text-output">{output.text}</p>
                    {:else}
                      <div class="media-placeholder"><ImageIcon /><span>{statusLabel(task.status)}</span></div>
                    {/if}
                    {#if output && task.outputCount > 1}<span class="output-count">{output.index + 1}/{task.outputCount}</span>{/if}
                    {#if output && output.type !== "text"}<span class="expand"><Maximize2 /></span>{/if}
                  </button>
                  <div class="task-meta">
                    <div class="task-title" title={task.prompt ?? task.model ?? "Generation"}>{task.prompt ?? task.model ?? "Generation"}</div>
                    <div class="task-subline">
                      <span class="status status-{task.status}">{#if task.status === "completed"}<Check />{:else if task.status === "failed"}<AlertCircle />{:else}<LoaderCircle class={task.status === "running" ? "spin" : ""} />{/if}{statusLabel(task.status)}</span>
                      {#if task.model}<span class="model" title={task.model}>{task.model}</span>{/if}
                      <time datetime={task.createdAt}>{relativeTime(task.createdAt)}</time>
                    </div>
                  </div>
                </article>
              {/each}
            </div>
          </section>
        {/each}
      </div>
      {#if pageInfo.hasMore}
        <button class="load-more" type="button" disabled={loadingMore} onclick={() => load("append")}>
          {#if loadingMore}<LoaderCircle class="spin" />{/if}
          Load more
        </button>
      {/if}
    {/if}
  </main>
</div>

{#if lightbox}
  <div
    class="lightbox"
    role="dialog"
    aria-modal="true"
    aria-label={lightbox.output.label ?? "Generation output"}
    tabindex="-1"
    onclick={(event) => event.currentTarget === event.target && closeLightbox()}
    onkeydown={(event) => event.key === "Escape" && closeLightbox()}
  >
    <button class="lightbox-close" type="button" aria-label="Close" onclick={closeLightbox}><X /></button>
    <div class="lightbox-content">
      {#if lightbox.output.type === "image"}
        <img src={lightbox.src} alt={lightbox.output.label ?? lightbox.task.prompt ?? "Generation output"} />
      {:else if lightbox.output.type === "video"}
        <video src={lightbox.src} poster={lightbox.output.poster ?? undefined} controls autoplay><track kind="captions" label="Generated video" /></video>
      {:else if lightbox.output.type === "audio"}
        <audio src={lightbox.src} controls autoplay></audio>
      {/if}
      <div class="lightbox-caption">
        <strong>{lightbox.task.prompt ?? lightbox.output.label ?? "Generation"}</strong>
        {#if lightbox.task.model}<span>{lightbox.task.model}</span>{/if}
      </div>
    </div>
  </div>
{/if}
