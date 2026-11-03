<script lang="ts">
import { onMount, tick, untrack } from "svelte";
import {
  writeResourceAppTarget,
  type ResourceAppKind,
  type ResourceAppTarget,
} from "@cohub/protocol";
import type { AppNavigationTarget } from "@cohub/protocol/app-navigation";
import type { AppRuntimeContext, Permission } from "@neta-art/cohub";
import { ChevronLeft, CircleAlert, FileQuestion, LockKeyhole, RefreshCw, SquareArrowOutUpRight } from "lucide-svelte";
import { m } from "$messages";
import { hasAccountScope, hasScopes, readScopes, resourceKey } from "../access";
import { readBrowserRoute, scopeHash, type ResourceScope } from "../browser-route";
import { client, nativeResourceUrl, openRelated, type ResourceDetail } from "../client";
import type { ResourceRow } from "../resource-list";
import ResourceView from "../ResourceView.svelte";
import { getLocale, runtime } from "../runtime.svelte";
import Button from "../ui/Button.svelte";
import FeedbackLayer from "../ui/FeedbackLayer.svelte";
import { feedback } from "../ui/feedback.svelte";
import IconButton from "../ui/IconButton.svelte";
import Notice from "../ui/Notice.svelte";
import Skeleton from "../ui/Skeleton.svelte";
import StateView from "../ui/StateView.svelte";
import type { ResourceViewModule } from "../view-types";
import { DetailController } from "./detail.svelte";
import { DraftController } from "./draft.svelte";
import { ListController } from "./list.svelte";
import ResourceList from "./ResourceList.svelte";
import { resourceTitle } from "./title";

let { kind, view }: { kind: ResourceAppKind; view: Promise<ResourceViewModule> } = $props();

const locale = $derived(getLocale());
const list = new ListController(untrack(() => kind));
const detail = new DetailController();
const draft = new DraftController();

let target = $state<ResourceAppTarget | null>(null);
let spaceId = $state("");
let scope = $state<ResourceScope | null>(null);
let invalidRoute = $state(false);
let busy = $state(false);
let failed = $state(false);
let navigationFallback = $state<string | null>(null);
let actionError = $state<"save_failed" | "error" | null>(null);
let routeKey = "";
let acceptedHash = "";
const scrollPositions = new Map<string, number>();

let updateDraft = $state(draft.bind());
let restored = $state(false);
let remount = $state(0);
let autoAccessKey = "";
const viewKey = $derived(target ? `${spaceId}:${target.kind}:${target.id}:${target.base ?? ""}:${remount}` : "");
const title = $derived(
  target && target.id !== "new"
    ? detail.detail
      ? resourceTitle(detail.detail, locale)
      : null
    : target
      ? kind === "cronjob"
        ? m.cron_new_scheduled({}, { locale })
        : m.cp_new_save({}, { locale })
      : categoryLabel(),
);

function categoryLabel() {
  return {
    task: m.sidebar_tasks,
    checkpoint: m.sidebar_saves,
    cronjob: m.sidebar_scheduled,
    app: m.sidebar_apps,
  }[kind]({}, { locale });
}

$effect(() => {
  if (!runtime.context || !title) return;
  document.title = title;
  client.app.window.setState({ title });
});
$effect(() => {
  detail.setActive(runtime.active);
});

function detailAccess(context: AppRuntimeContext | null) {
  return kind === "task" && scope?.kind === "mine"
    ? hasAccountScope(context, "user.taskrun.list")
    : hasScopes(context, spaceId, readScopes(kind));
}

async function authorize(scopes: Permission[], write = false) {
  const account = scopes.every((permission) => permission.startsWith("user."));
  const requested = spaceId;
  const result = await client.auth.authorize({
    target: account ? { kind: "account" } : { kind: "space", spaceId: requested },
    scopes,
    fallback: "none",
    reason: (write ? m.resource_app_write_reason : m.resource_app_access_reason)({}, { locale }),
  });
  return (
    result.status === "granted" &&
    (account
      ? result.target.kind === "account"
      : result.target.kind === "space" && result.target.spaceId === requested)
  );
}

async function requestAccess() {
  busy = true;
  try {
    const scopes: Permission[] = kind === "task" && scope?.kind === "mine" ? ["user.taskrun.list"] : readScopes(kind);
    if (await authorize(scopes)) await detail.refresh();
  } catch {
  } finally {
    busy = false;
  }
}

async function action(scopes: Permission[], run: () => Promise<void>, options: { write?: boolean } = {}) {
  const write = options.write ?? true;
  if (busy) return false;
  busy = true;
  actionError = null;
  const revision = detail.revision;
  if (write) client.app.window.setState({ status: "saving", dirty: true });
  try {
    if (!(await authorize(scopes, write)) || revision !== detail.revision) return false;
    await run();
    return true;
  } catch {
    if (revision === detail.revision) actionError = write ? "save_failed" : "error";
    return false;
  } finally {
    busy = false;
    client.app.window.setState({ status: "idle", dirty: draft.dirty });
  }
}

function goHash(hash: string) {
  if (busy || !draft.persist()) return;
  scrollPositions.set(acceptedHash, window.scrollY);
  if (location.hash !== hash) location.hash = hash;
}

function routeParams() {
  return new URLSearchParams(scopeHash(scope).slice(1));
}

function openRow(row: ResourceRow) {
  const params = routeParams();
  if (row.spaceId) params.set("space", row.spaceId);
  else params.delete("space");
  writeResourceAppTarget(params, { kind, id: row.id });
  goHash(`#${params}`);
}

function openDetail(id: string, base?: string) {
  const params = routeParams();
  if (spaceId) params.set("space", spaceId);
  writeResourceAppTarget(params, { kind, id, ...(base ? { base } : {}) });
  goHash(`#${params}`);
}

function createResource() {
  if (scope?.kind !== "space") return;
  const params = routeParams();
  writeResourceAppTarget(params, { kind, id: "new" });
  goHash(`#${params}`);
}

function back() {
  goHash(scopeHash(scope));
}

function removed(message: string) {
  if (target) list.remove(target.id);
  draft.update(null);
  feedback.notify(message);
  goHash(scopeHash(scope));
}

function discardDraft() {
  draft.update(null);
  restored = false;
  remount += 1;
}

function setDetail(next: ResourceDetail) {
  detail.set(next);
}

async function navigateRelated(next: AppNavigationTarget) {
  const revision = detail.revision;
  navigationFallback = null;
  try {
    const fallback = await openRelated(next);
    if (revision === detail.revision) navigationFallback = fallback;
  } catch {
    if (revision === detail.revision) actionError = "error";
  }
}

async function navigate() {
  const context = runtime.context;
  if (!context) return;
  const route = readBrowserRoute(location.hash, kind, context);
  const nextKey = JSON.stringify([context.viewer?.userUuid, route]);
  if (nextKey === routeKey) return;
  if (busy || !draft.persist()) {
    history.replaceState(history.state, "", `${location.pathname}${location.search}${acceptedHash}`);
    return;
  }
  if (!location.hash && route.scope && !route.invalid)
    history.replaceState(history.state, "", `${location.pathname}${location.search}${scopeHash(route.scope)}`);
  acceptedHash = location.hash;
  routeKey = nextKey;
  if (context.invocation?.surface === "app" && acceptedHash)
    void client.navigation.open({ kind: "app", ref: context.app.id, launch: { hash: acceptedHash } }).catch(() => {});

  navigationFallback = null;
  actionError = null;
  scope = route.scope;
  invalidRoute = route.invalid;
  target = route.target;
  spaceId = route.spaceId;
  restoreScroll();
  if (!target) {
    detail.close();
    draft.reset();
    return;
  }
  const key = resourceKey(context, spaceId, kind, target.id, target.base);
  draft.load(key);
  updateDraft = draft.bind();
  restored = draft.dirty;
  detail.open(spaceId, target, key, detailAccess(context));
}

function restoreScroll() {
  const hash = acceptedHash;
  void tick().then(() => {
    if (hash === acceptedHash) window.scrollTo({ top: scrollPositions.get(hash) ?? 0, behavior: "instant" });
  });
}

$effect(() => {
  if (!detail.denied || !target || (kind !== "task" && kind !== "checkpoint" && kind !== "app")) return;
  if (autoAccessKey === viewKey) return;
  autoAccessKey = viewKey;
  void requestAccess();
});

function applyContext(next: AppRuntimeContext | null) {
  const previous = runtime.context;
  const identityChanged = previous?.viewer?.userUuid !== next?.viewer?.userUuid;
  const lostAccess = Boolean(target && detailAccess(previous) && !detailAccess(next));
  if (identityChanged) {
    scrollPositions.clear();
    busy = false;
  }
  runtime.context = next;
  runtime.locale = next?.locale === "zh-CN" ? "zh-CN" : "en";
  runtime.shown = next?.window?.visible ?? true;
  if (!next) {
    failed = true;
    return;
  }
  failed = false;
  if (lostAccess) detail.revoke();
  void navigate();
}

onMount(() => {
  const stopContext = client.app.onContextChanged(applyContext);
  const stopAppearance = client.app.appearance.sync();
  const stopClose = client.app.window.onBeforeClose(() => !busy && draft.persist());
  void client.context().then(applyContext, () => (failed = true));
  const visibility = () => {
    runtime.foreground = document.visibilityState === "visible";
  };
  const unload = (event: BeforeUnloadEvent) => {
    if (busy || !draft.persist()) event.preventDefault();
  };
  const saveScroll = () => {
    if (location.hash === acceptedHash) scrollPositions.set(acceptedHash, window.scrollY);
  };
  window.addEventListener("scroll", saveScroll, { passive: true });
  window.addEventListener("hashchange", navigate);
  window.addEventListener("beforeunload", unload);
  document.addEventListener("visibilitychange", visibility);
  return () => {
    draft.persist();
    detail.dispose();
    list.dispose();
    stopContext();
    stopAppearance();
    stopClose();
    window.removeEventListener("scroll", saveScroll);
    window.removeEventListener("hashchange", navigate);
    window.removeEventListener("beforeunload", unload);
    document.removeEventListener("visibilitychange", visibility);
  };
});
</script>

<main class="mx-auto min-h-dvh w-full max-w-5xl">
  {#if target}
    <header class="sticky top-0 z-20 flex h-11 items-center justify-between gap-2 border-b border-border-subtle/70 bg-bg-content px-2 sm:px-4">
      <button type="button" class="inline-flex min-h-8 min-w-0 items-center gap-1 rounded-[5px] pr-2 pl-1 text-[12px] font-medium text-text-tertiary transition-colors hover:bg-bg-hover hover:text-text-primary disabled:opacity-50 pointer-coarse:min-h-10" disabled={busy} onclick={back}>
        <ChevronLeft class="h-4 w-4 shrink-0" />
        <span class="truncate">{categoryLabel()}</span>
      </button>
      <div class="flex items-center gap-0.5">
        {#if target.id !== "new" && kind === "checkpoint"}
          <IconButton icon={SquareArrowOutUpRight} label={m.resource_app_more_actions_hint({}, { locale })} href={nativeResourceUrl(spaceId, target)} />
        {/if}
        {#if target.id !== "new"}
          <IconButton icon={RefreshCw} label={m.resource_app_retry({}, { locale })} spinning={detail.refreshing} disabled={busy || detail.refreshing} onclick={() => void detail.refresh()} />
        {/if}
      </div>
    </header>
  {/if}

  {#if runtime.context && !invalidRoute}
    <div hidden={Boolean(target)}>
      <ResourceList {kind} {list} {scope} {busy} shown={!target} onScope={(next) => goHash(scopeHash(next))} onOpen={openRow} onCreate={createResource} onRun={(row) => void navigateRelated({ kind: "app", ref: row.id })} />
    </div>
  {/if}

  {#if target}
    <div class="space-y-2 px-4 pt-3 empty:hidden sm:px-6">
      {#if navigationFallback}
        <Notice tone="info">{m.resource_app_navigation_failed({}, { locale })}{#snippet action()}<Button variant="ghost" href={navigationFallback ?? undefined} icon={SquareArrowOutUpRight}>{m.resource_app_open({}, { locale })}</Button>{/snippet}</Notice>
      {/if}
      {#if draft.failed}<Notice>{m.resource_app_draft_failed({}, { locale })}</Notice>
      {:else if restored && draft.dirty}
        <Notice tone="info">{m.resource_app_draft_restored({}, { locale })}{#snippet action()}<Button variant="ghost" disabled={busy} onclick={discardDraft}>{m.resource_app_discard({}, { locale })}</Button>{/snippet}</Notice>
      {/if}
      {#if actionError}<Notice>{(actionError === "save_failed" ? m.resource_app_save_failed : m.resource_app_error)({}, { locale })}</Notice>{/if}
      {#if detail.error === "stale"}
        <Notice tone="info">{m.resource_app_stale({}, { locale })}{#snippet action()}<Button variant="ghost" icon={RefreshCw} loading={detail.refreshing} onclick={() => void detail.refresh()}>{m.common_retry({}, { locale })}</Button>{/snippet}</Notice>
      {/if}
    </div>
  {/if}

  {#if failed || invalidRoute}
    <StateView icon={CircleAlert} title={m.resource_app_error({}, { locale })} />
  {:else if target}
    {#if detail.denied}
      <StateView icon={LockKeyhole} title={m.resource_app_denied({}, { locale })} description={m.resource_app_denied_hint({}, { locale })}>
        {#snippet action()}<Button variant="primary" loading={busy} onclick={requestAccess}>{m.resource_app_access({}, { locale })}</Button>{/snippet}
      </StateView>
    {:else if detail.missing}
      <StateView icon={FileQuestion} title={m.resource_app_not_found({}, { locale })} description={m.resource_app_not_found_hint({}, { locale })}>
        {#snippet action()}<Button variant="outline" icon={ChevronLeft} onclick={back}>{m.resource_app_back_list({}, { locale })}</Button>{/snippet}
      </StateView>
    {:else if detail.error === "error" && !detail.detail}
      <StateView icon={CircleAlert} title={m.resource_app_error({}, { locale })}>
        {#snippet action()}<Button variant="outline" icon={RefreshCw} loading={detail.refreshing} onclick={() => void detail.refresh()}>{m.common_retry({}, { locale })}</Button>{/snippet}
      </StateView>
    {:else if detail.loading && !detail.detail}
      <div aria-busy="true" aria-label={m.resource_app_loading({}, { locale })}><Skeleton variant="detail" /></div>
    {:else}
      {#key viewKey}
        <ResourceView {view} {target} {spaceId} detail={detail.detail} {busy} draft={draft.value} {action} {authorize} {updateDraft} {setDetail} refresh={() => detail.refresh()} {openDetail} {back} {removed} {navigateRelated} />
      {/key}
    {/if}
  {/if}
</main>

<FeedbackLayer />
