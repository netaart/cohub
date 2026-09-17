<script lang="ts">
import type { AppRecord, AppVersionRecord } from "@neta-art/cohub";
import {
	Check,
	Copy,
	ExternalLink,
	Loader2,
	MessageSquare,
	PanelRight,
	Pencil,
	Power,
	Rocket,
	Trash2,
} from "lucide-svelte";
import { onDestroy, onMount } from "svelte";
import CenteredLoading from "$lib/components/CenteredLoading.svelte";
import {
	APPS_CHANGED_EVENT,
	type AppsChangedDetail,
} from "$lib/features/app/app-realtime";
import { getLocale } from "$lib/i18n/locale.svelte";
import { m } from "$lib/paraglide/messages.js";
import {
	buildSpaceSessionRoute,
	buildSpaceSessionTurnRoute,
} from "$lib/space-routes";
import { authStore } from "$lib/stores/auth.svelte";
import { formatDateTime } from "../space-utils";
import AppPromotions from "./AppPromotions.svelte";
import AppViewStats from "./AppViewStats.svelte";
import { createAppDetailController } from "./app-detail-controller.svelte";
import {
	APP_SCOPE_GROUPS,
	APP_SCOPE_OPTIONS,
	appStatusTone,
} from "./app-utils";

type Props = {
	spaceId: string;
	routeAppId: string | null;
	ownerUsername: string | null;
	spaceSlug: string | null;
	canEditSpace: boolean;
	/** Whether the viewer may create Apps and publish new versions (builder capability). */
	canPublishApp: boolean;
	/** Whether the viewer may change an App's configuration, status, and stats (builder capability). */
	canManageApp: boolean;
	onDetailLoaded?: (app: AppRecord | null) => void;
	/** Show this app in the workspace window pane, beside the detail page. */
	onPreviewApp?: (app: AppRecord) => void;
};

let {
	spaceId,
	routeAppId,
	ownerUsername,
	spaceSlug,
	canEditSpace,
	canPublishApp,
	canManageApp,
	onDetailLoaded,
	onPreviewApp,
}: Props = $props();

const locale = $derived(getLocale());

const appDetailController = createAppDetailController({
	getSpaceId: () => spaceId,
	getRouteAppId: () => routeAppId,
	getOwnerUsername: () => ownerUsername,
	getSpaceSlug: () => spaceSlug,
	getCanViewStats: () => canManageApp,
	onDetailLoaded: (app) => onDetailLoaded?.(app),
});

const appDetail = $derived(appDetailController.detail);
// Hosts delete any App; builders only the Apps they published themselves.
const canDeleteApp = $derived(
	canEditSpace || (canManageApp && appDetail?.userUuid === authStore.userUuid),
);
const appDetailLoading = $derived(appDetailController.loading);
const appDetailError = $derived(appDetailController.error);
const appActionInProgress = $derived(appDetailController.actionInProgress);
const appDeleteInProgress = $derived(appDetailController.deleteInProgress);
const appFormSubmitting = $derived(appDetailController.formSubmitting);
const appFormError = $derived(appDetailController.formError);
const appCopiedId = $derived(appDetailController.copiedId);
const appCopiedPublicRoute = $derived(appDetailController.copiedPublicRoute);
const appVersions = $derived(appDetailController.versions);
const appVersionsLoading = $derived(appDetailController.versionsLoading);
const appVersionsError = $derived(appDetailController.versionsError);
const appPublishSubmitting = $derived(appDetailController.publishSubmitting);
const appPublishError = $derived(appDetailController.publishError);
const workHideCohubBar = $derived(
	appDetail?.meta?.presentation?.hideCohubBar === true,
);
const workCanToggleHideCohubBar = $derived(
	appDetailController.hideCohubBarAllowed ||
		appDetailController.formHideCohubBar,
);
const workStats = $derived(appDetailController.stats);
const workStatsLoading = $derived(appDetailController.statsLoading);
const workStatsError = $derived(appDetailController.statsError);

/** Deep link into the session (and turn) that produced a version, when visible. */
function versionSessionRoute(
	source: AppVersionRecord["source"],
): string | null {
	const session = source?.session;
	if (!session) return null;
	return source?.turnSequence !== undefined
		? buildSpaceSessionTurnRoute(spaceId, session.id, source.turnSequence)
		: buildSpaceSessionRoute(spaceId, session.id);
}

$effect(() => {
	appDetailController.syncRoute();
});

onMount(() => {
	const handleWorksChanged = (event: Event) => {
		const detail = (event as CustomEvent<AppsChangedDetail>).detail;
		if (detail?.spaceId !== spaceId) return;
		if (detail.app || detail.version || detail.deletedAppId) {
			appDetailController.applyAppsChanged(detail);
			return;
		}
		appDetailController.refresh();
	};
	window.addEventListener(APPS_CHANGED_EVENT, handleWorksChanged);
	return () =>
		window.removeEventListener(APPS_CHANGED_EVENT, handleWorksChanged);
});

onDestroy(() => {
	appDetailController.dispose();
});
</script>

{#snippet CopyIdMetaItem(id: string, copied: boolean, onCopy: () => void, label = "Copy ID")}
	<button
		type="button"
		class="inline-flex min-h-6 min-w-0 max-w-full items-center gap-1.5 font-mono text-[11px] text-text-placeholder transition-colors hover:text-text-secondary"
		onclick={onCopy}
		title={label}
	>
		<span class="truncate">{id}</span>
		{#if copied}
			<Check class="h-3 w-3 shrink-0 text-success-soft" />
		{:else}
			<Copy class="h-3 w-3 shrink-0" />
		{/if}
	</button>
{/snippet}

<div class="flex-1 min-h-0 overflow-y-auto px-4 py-5 sm:px-6 lg:px-8">
  <div class="max-w-5xl">
  {#if appDetailLoading && appDetail?.id !== routeAppId}
    <CenteredLoading label="Loading app…" size="panel" />
  {:else if appDetailError}
    <div class="rounded-md border border-error-soft/30 bg-error-bg p-3 text-[12px] font-mono text-error-soft break-all">{appDetailError}</div>
  {:else if appDetail && appDetail.id === routeAppId}
    {@const publicRoute = appDetailController.publicRoute(appDetail)}
    <div class="space-y-6 sm:space-y-8">
      <header class="flex flex-col gap-4 border-b border-border-subtle/70 pb-5 lg:flex-row lg:items-start lg:justify-between">
        <div class="min-w-0 space-y-3">
          <div>
            <h1 class="font-mono text-[24px] font-semibold tracking-tight text-text-primary break-all sm:text-[30px]">{appDetail.slug}</h1>
            <div class="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1.5">
              <span class="inline-flex items-center gap-1.5 text-[11px] font-medium {appStatusTone(appDetail.status)}">
                <span class="h-1.5 w-1.5 rounded-full {appDetail.status === 'published' ? 'bg-status-running' : appDetail.status === 'disabled' ? 'bg-status-error' : 'bg-text-placeholder'}"></span>
                {appDetail.status}
              </span>
              <span class="inline-flex items-center gap-1.5 text-[11px] font-medium text-text-tertiary">
                <span class="h-1.5 w-1.5 rounded-full {appDetail.visibility === 'public' ? 'bg-brand' : 'bg-text-placeholder'}"></span>
                {appDetail.visibility === 'public' ? 'public' : 'space access'}
              </span>
              {@render CopyIdMetaItem(appDetail.id, appCopiedId, () => void appDetailController.copyId(appDetail!.id), 'Copy app ID')}
              <span class="font-mono text-[11px] text-text-placeholder">{appDetail.targetType}:{appDetail.targetRef}</span>
            </div>
          </div>
        </div>
        <div class="flex shrink-0 flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center">
          {#if onPreviewApp && appDetail.status === 'published'}
            <button type="button" class="inline-flex min-h-9 w-full items-center justify-center gap-1.5 rounded-[5px] bg-brand-muted px-3 py-2 text-[12px] font-medium text-brand transition-colors hover:bg-brand-muted-hover sm:w-auto" onclick={() => onPreviewApp?.(appDetail!)}>
              <PanelRight class="h-3.5 w-3.5" />
              <span>Open</span>
            </button>
          {/if}
          {#if publicRoute && appDetail.status === 'published'}
            <a href={publicRoute} target="_blank" rel="noopener" class="inline-flex min-h-9 w-full items-center justify-center gap-1.5 rounded-[5px] bg-bg-elevated px-3 py-2 text-[12px] font-medium text-text-secondary transition-colors hover:bg-bg-hover hover:text-text-primary sm:w-auto">
              <ExternalLink class="h-3.5 w-3.5" />
              <span>{m.app_view_new_tab({}, { locale })}</span>
            </a>
          {/if}
          {#if canManageApp}
          <button type="button" class="inline-flex min-h-9 w-full items-center justify-center gap-1.5 rounded-[5px] bg-bg-elevated px-3 py-2 text-[12px] font-medium text-text-secondary transition-colors hover:bg-bg-hover hover:text-text-primary sm:w-auto" onclick={() => { appDetailController.syncFormFromDetail(); appDetailController.editMode = !appDetailController.editMode; }}>
            <Pencil class="h-3.5 w-3.5" />
            <span>{appDetailController.editMode ? m.close_edit({}, { locale }) : m.common_edit({}, { locale })}</span>
          </button>
          <button type="button" class="inline-flex min-h-9 w-full items-center justify-center gap-1.5 rounded-[5px] bg-bg-elevated px-3 py-2 text-[12px] font-medium transition-colors hover:bg-bg-hover disabled:opacity-50 sm:w-auto {appDetail.status === 'published' ? 'text-status-running' : 'text-text-secondary'}" onclick={() => appDetailController.toggleStatus(appDetail!.status === 'published' ? 'disabled' : 'published')} disabled={appActionInProgress}>
            {#if appActionInProgress}<Loader2 class="h-3.5 w-3.5 animate-spin" />{:else if appDetail.status === 'published'}<Power class="h-3.5 w-3.5" />{:else}<Rocket class="h-3.5 w-3.5" />{/if}
            <span>{appDetail.status === 'published' ? 'Disable' : 'Publish'}</span>
          </button>
          {/if}
          {#if canDeleteApp}
          <button type="button" class="inline-flex min-h-9 w-full items-center justify-center gap-1.5 rounded-[5px] px-3 py-2 text-[12px] font-medium text-text-tertiary transition-colors hover:bg-bg-hover hover:text-error-soft disabled:opacity-50 sm:w-auto" onclick={appDetailController.deleteApp} disabled={appActionInProgress || appDeleteInProgress}>
            {#if appDeleteInProgress}<Loader2 class="h-3.5 w-3.5 animate-spin" />{:else}<Trash2 class="h-3.5 w-3.5" />{/if}
            <span>{appDeleteInProgress ? 'Deleting…' : 'Delete'}</span>
          </button>
          {/if}
        </div>
      </header>

      {#if !appDetailController.editMode}
        {#if canManageApp}
          <AppViewStats
            stats={workStats}
            loading={workStatsLoading}
            error={workStatsError}
            onRetry={() => void appDetailController.loadStats(appDetail.id)}
          />
        {/if}
        {#if canEditSpace && publicRoute && appDetail.status === 'published'}
          <AppPromotions appId={appDetail.id} publicRoute={publicRoute} />
        {/if}
      {/if}

      {#if appDetailController.editMode}
        <form onsubmit={appDetailController.submitUpdate} class="space-y-6">
          <section class="grid gap-6 lg:grid-cols-[minmax(0,1fr)_280px]">
            <div class="min-w-0 space-y-5">
              <div class="space-y-1.5">
                <label class="block text-[10px] font-medium uppercase tracking-wider text-text-tertiary" for="app-edit-slug">Slug</label>
                <input id="app-edit-slug" type="text" bind:value={appDetailController.formSlug} class="w-full rounded-[6px] border border-border-subtle bg-bg-input px-3 py-2 font-mono text-[13px] text-text-primary transition-colors focus:border-brand/50 focus:outline-none" />
              </div>
              <div class="grid gap-4 sm:grid-cols-[160px_minmax(0,1fr)]">
                <div class="space-y-1.5">
                  <label class="block text-[10px] font-medium uppercase tracking-wider text-text-tertiary" for="app-edit-target-type">Target</label>
                  <select id="app-edit-target-type" bind:value={appDetailController.formTargetType} class="w-full rounded-[6px] border border-border-subtle bg-bg-input px-3 py-2 text-[13px] text-text-primary transition-colors focus:border-brand/50 focus:outline-none">
                    <option value="file">File</option>
                    <option value="directory">Directory</option>
                    <option value="port">Port</option>
                  </select>
                </div>
                <div class="space-y-1.5">
                  <label class="block text-[10px] font-medium uppercase tracking-wider text-text-tertiary" for="app-edit-target-ref">Reference</label>
                  <input id="app-edit-target-ref" type="text" bind:value={appDetailController.formTargetRef} class="w-full rounded-[6px] border border-border-subtle bg-bg-input px-3 py-2 font-mono text-[13px] text-text-primary transition-colors focus:border-brand/50 focus:outline-none" />
                </div>
              </div>
              <div class="grid gap-4 sm:grid-cols-2">
                <div class="space-y-1.5">
                  <label class="block text-[10px] font-medium uppercase tracking-wider text-text-tertiary" for="app-edit-status">Status</label>
                  <select id="app-edit-status" bind:value={appDetailController.formStatus} class="w-full rounded-[6px] border border-border-subtle bg-bg-input px-3 py-2 text-[13px] text-text-primary transition-colors focus:border-brand/50 focus:outline-none">
                    <option value="published">Published</option>
                    <option value="disabled">Disabled</option>
                  </select>
                </div>
                <div class="space-y-1.5">
                  <label class="block text-[10px] font-medium uppercase tracking-wider text-text-tertiary" for="app-edit-visibility">Access</label>
                  <select id="app-edit-visibility" bind:value={appDetailController.formVisibility} class="w-full rounded-[6px] border border-border-subtle bg-bg-input px-3 py-2 text-[13px] text-text-primary transition-colors focus:border-brand/50 focus:outline-none">
                    <option value="public">{m.anyone_with_link({}, { locale })}</option>
                    <option value="space">{m.app_publish_space_access({}, { locale })}</option>
                  </select>
                  <div class="text-[11px] leading-5 text-text-placeholder">{m.app_view_space_access_detail({}, { locale })}</div>
                </div>
              </div>
              <div class="space-y-1.5">
                <div class="text-[10px] font-medium uppercase tracking-wider text-text-tertiary">Presentation</div>
                <label class="flex min-h-11 gap-3 rounded-[6px] border border-border-subtle bg-bg-elevated/25 px-3 py-2.5 text-text-secondary transition-colors hover:border-border-default hover:bg-bg-elevated/40" class:opacity-60={!workCanToggleHideCohubBar}>
                  <input type="checkbox" bind:checked={appDetailController.formHideCohubBar} disabled={!workCanToggleHideCohubBar || appDetailController.hideCohubBarLoading} class="mt-0.5" />
                  <span class="min-w-0">
                    <span class="block text-[12px] text-text-primary">{m.app_publish_hide_cohub_bar({}, { locale })}</span>
                    <span class="block text-[11px] leading-5 text-text-placeholder">{m.app_view_hide_footer_detail({}, { locale })}</span>
                  </span>
                </label>
                {#if appDetailController.hideCohubBarLoading}
                  <div class="text-[11px] text-text-tertiary">Checking availability…</div>
                {:else if !appDetailController.hideCohubBarAllowed}
                  <div class="text-[11px] text-text-tertiary">{m.app_publish_included_pro_max({}, { locale })}</div>
                {/if}
              </div>
            </div>
            <aside class="space-y-4 text-[13px]">
              <div class="space-y-2">
                <div class="text-[10px] font-medium uppercase tracking-[0.18em] text-text-placeholder">{m.app_publish_app_can({}, { locale })}</div>
                {#each APP_SCOPE_GROUPS as group (group.title)}
                  <div class="space-y-1">
                    <div class="text-[10px] font-medium uppercase tracking-wider text-text-placeholder">{group.title}</div>
                    {#each APP_SCOPE_OPTIONS.filter((option) => group.scopes.includes(option.scope)) as option (option.scope)}
                      <label class="flex gap-3 rounded-[6px] bg-bg-elevated/30 px-3 py-2 text-text-secondary">
                        <input type="checkbox" bind:checked={appDetailController.formScopes[option.scope]} class="mt-0.5" />
                        <span class="min-w-0"><span class="block text-[12px] text-text-primary">{option.label}</span><span class="block text-[11px] leading-5 text-text-placeholder">{option.description}</span></span>
                      </label>
                    {/each}
                  </div>
                {/each}
              </div>
            </aside>
          </section>
          {#if appFormError}
            <div class="rounded-md border border-error-soft/30 bg-error-bg p-3 text-[12px] font-mono text-error-soft break-all">{appFormError}</div>
          {/if}
          <div class="sticky bottom-0 z-10 -mx-4 -mb-5 flex flex-col-reverse gap-2 border-t border-border-subtle/70 bg-bg-primary/95 px-4 py-4 backdrop-blur sm:-mx-6 sm:-mb-5 sm:flex-row sm:justify-end sm:px-6 lg:-mx-8 lg:px-8">
            <button type="button" class="inline-flex min-h-10 items-center justify-center rounded-[5px] border border-border-subtle px-3 py-2 text-[12px] text-text-secondary transition-colors hover:bg-bg-hover hover:text-text-primary" onclick={() => { appDetailController.editMode = false; appDetailController.syncFormFromDetail(); }}>{m.common_cancel({}, { locale })}</button>
            <button type="submit" class="inline-flex min-h-10 items-center justify-center gap-2 rounded-[5px] bg-brand px-3 py-2 text-[12px] font-medium text-brand-contrast-fg transition-colors hover:bg-brand-hover disabled:opacity-50" disabled={appFormSubmitting}>
              {#if appFormSubmitting}<Loader2 class="h-3.5 w-3.5 animate-spin" />{:else}<Check class="h-3.5 w-3.5" />{/if}
              <span>{m.cron_save_changes({}, { locale })}</span>
            </button>
          </div>
        </form>
      {:else}
        <section class="grid gap-6 lg:grid-cols-[minmax(0,1fr)_280px] lg:gap-8">
          <div class="min-w-0 space-y-6">
            <section class="space-y-3">
              <div class="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
                <div class="min-w-0">
                  <div class="text-[10px] font-medium uppercase tracking-[0.18em] text-text-placeholder">Target</div>
                  <div class="mt-1 font-mono text-[11px] text-text-placeholder">Current v{appDetail.latestVersion || 0}</div>
                </div>
                {#if canPublishApp && appDetail.status === 'published'}
                  <button type="button" class="inline-flex min-h-9 w-full items-center justify-center gap-1.5 rounded-[5px] bg-brand px-3 py-2 text-[12px] font-medium text-brand-contrast-fg transition-colors hover:bg-brand-hover disabled:opacity-50 sm:w-auto" onclick={() => void appDetailController.publishVersion()} disabled={appPublishSubmitting}>
                    {#if appPublishSubmitting}<Loader2 class="h-3.5 w-3.5 animate-spin" />{:else}<Rocket class="h-3.5 w-3.5" />{/if}
                    <span>{appPublishSubmitting ? 'Updating…' : 'Update version'}</span>
                  </button>
                {/if}
              </div>
              <div class="relative overflow-hidden rounded-[8px] bg-bg-elevated/40 ring-1 ring-border-subtle/60">
                <div class="absolute left-0 top-0 h-full w-[3px] bg-brand"></div>
                <div class="px-5 py-4 pl-6">
                  <div class="font-mono text-[13px] text-text-primary break-all">{appDetail.targetRef}</div>
                  <div class="mt-2 text-[12px] text-text-tertiary">{appDetail.targetType}</div>
                </div>
              </div>
              {#if appPublishError}
                <div class="rounded-[6px] border border-error-soft/30 bg-error-bg px-3 py-2 text-[12px] font-mono text-error-soft break-all">{appPublishError}</div>
              {/if}
            </section>
            <section class="grid gap-3 lg:grid-cols-[minmax(0,1fr)_140px]">
              <div class="rounded-[7px] bg-bg-elevated/30 px-3 py-2.5">
                <div class="text-[10px] font-medium uppercase tracking-wider text-text-placeholder">{m.app_view_app_permissions({}, { locale })}</div>
                <div class="mt-1 text-[13px] text-text-primary">{appDetail.appScopes.length ? appDetail.appScopes.join(', ') : 'None'}</div>
              </div>
              <div class="rounded-[7px] bg-bg-elevated/30 px-3 py-2.5">
                <div class="text-[10px] font-medium uppercase tracking-wider text-text-placeholder">{m.app_view_cohub_bar({}, { locale })}</div>
                <div class="mt-1 inline-flex items-center gap-1.5 text-[13px] text-text-primary">
                  <span class="h-1.5 w-1.5 rounded-full {workHideCohubBar ? 'bg-text-placeholder' : 'bg-status-running'}"></span>
                  <span>{workHideCohubBar ? 'Hidden' : 'Shown'}</span>
                </div>
              </div>
            </section>
          </div>
          <aside class="space-y-5 text-[13px]">
            {#if publicRoute && appDetail.status === 'published'}
              <div class="space-y-2">
                <div class="flex items-center justify-between gap-3">
                  <div class="text-[10px] font-medium uppercase tracking-wider text-text-placeholder">{m.app_view_public_path({}, { locale })}</div>
                  <button type="button" class="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-[5px] text-text-tertiary transition-colors hover:bg-bg-hover hover:text-text-primary" onclick={() => void appDetailController.copyPublicRoute(publicRoute)} title={appCopiedPublicRoute ? 'Copied' : 'Copy public link'} aria-label={appCopiedPublicRoute ? 'Copied' : 'Copy public link'}>
                    {#if appCopiedPublicRoute}<Check class="h-3.5 w-3.5 text-success-soft" />{:else}<Copy class="h-3.5 w-3.5" />{/if}
                  </button>
                </div>
                <div class="rounded-[6px] bg-bg-elevated/30 px-3 py-2 font-mono text-[12px] text-text-secondary break-all">{publicRoute}</div>
              </div>
              <div class="h-px bg-border-subtle/70"></div>
            {/if}
            <div class="space-y-3">
              <div class="text-[10px] font-medium uppercase tracking-[0.18em] text-text-placeholder">Metadata</div>
              <div class="grid grid-cols-[76px_minmax(0,1fr)] gap-x-3 gap-y-2 text-[12px]">
                <div class="text-text-placeholder">Created</div><div class="text-text-secondary">{formatDateTime(appDetail.createdAt)}</div>
                <div class="text-text-placeholder">Updated</div><div class="text-text-secondary">{formatDateTime(appDetail.updatedAt)}</div>
                <div class="text-text-placeholder">Published</div><div class="text-text-secondary">{formatDateTime(appDetail.publishedAt)}</div>
                <div class="text-text-placeholder">Owner</div><div class="font-mono text-text-secondary break-all">{appDetail.userUuid}</div>
              </div>
            </div>
          </aside>
        </section>
        <section class="border-t border-border-subtle/70 pt-6">
          <div class="mb-3 flex items-center justify-between gap-3">
            <div class="text-[10px] font-medium uppercase tracking-[0.18em] text-text-placeholder">Versions</div>
            {#if appVersionsLoading}<Loader2 class="h-3.5 w-3.5 animate-spin text-text-placeholder" />{/if}
          </div>
          {#if appVersionsError}
            <div class="rounded-md border border-error-soft/30 bg-error-bg p-3 text-[12px] font-mono text-error-soft break-all">{appVersionsError}</div>
          {:else if appVersionsLoading && appVersions.length === 0}
            <CenteredLoading label="Loading versions…" size="panel" />
          {:else if appVersions.length}
            <div class="divide-y divide-border-subtle/60">
              {#each appVersions as version (version.id)}
                {@const sessionHref = versionSessionRoute(version.source)}
                <div class="py-3 text-[12px] sm:grid sm:grid-cols-[88px_minmax(0,1fr)_minmax(0,200px)_150px] sm:items-center sm:gap-3 sm:py-2.5">
                  <div class="flex items-center gap-2 px-1">
                    <span class="font-mono text-text-primary">v{version.version}</span>
                    {#if version.id === appDetail.currentVersionId}<span class="rounded-full bg-brand-muted px-2 py-0.5 text-[10px] font-medium text-brand">Current</span>{/if}
                  </div>
                  <div class="mt-1 truncate font-mono text-text-tertiary sm:mt-0" title={`${version.targetType}:${version.targetRef}`}>{version.targetType}:{version.targetRef}</div>
                  {#if sessionHref && version.source?.session}
                    <a class="mt-1 flex min-w-0 items-center gap-1.5 text-text-secondary transition-colors hover:text-brand sm:mt-0" href={sessionHref} target="_blank" rel="noopener noreferrer" title={version.source.session.title ?? version.source.session.id}>
                      <MessageSquare class="h-3.5 w-3.5 shrink-0 text-text-placeholder" aria-hidden="true" />
                      <span class="truncate">{version.source.session.title || 'Untitled session'}</span>
                    </a>
                  {:else if version.source?.via}
                    <div class="mt-1 truncate text-text-placeholder sm:mt-0">via {version.source.via}</div>
                  {:else}
                    <div class="mt-1 text-text-placeholder sm:mt-0">—</div>
                  {/if}
                  <div class="mt-1 font-mono text-text-placeholder sm:mt-0">{formatDateTime(version.createdAt)}</div>
                </div>
              {/each}
            </div>
          {:else}
            <div class="py-6 text-[13px] text-text-tertiary">Publish creates v1.</div>
          {/if}
        </section>
      {/if}
    </div>
  {:else}
    <div class="text-[12px] text-text-tertiary">{m.app_view_not_found({}, { locale })}</div>
  {/if}
  </div>
</div>
