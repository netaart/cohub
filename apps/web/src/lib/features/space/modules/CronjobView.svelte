<script lang="ts">
import type { CronJobRecord, UserProfile } from "@neta-art/cohub";
import {
	Check,
	Clock,
	Clock3,
	Copy,
	Loader2,
	Pencil,
	Plus,
	Power,
	PowerOff,
	Settings,
	Trash2,
} from "lucide-svelte";
import { onDestroy } from "svelte";
import { goto } from "$app/navigation";
import AccessStateView from "$lib/components/AccessStateView.svelte";
import CenteredLoading from "$lib/components/CenteredLoading.svelte";
import ModelSelector from "$lib/components/ModelSelector.svelte";
import UserIdentity from "$lib/components/UserIdentity.svelte";
import { getLocale } from "$lib/i18n/locale.svelte";
import { m } from "$lib/paraglide/messages.js";
import {
	buildSpaceNewSessionRoute,
	buildSpaceTaskRoute,
} from "$lib/space-routes";
import {
	displayUserName,
	formatDateTime,
	formatShortDateTime,
} from "../space-utils";
import {
	type CronjobMode,
	createCronjobDetailController,
} from "./cronjob-detail-controller.svelte";
import {
	cronjobModelLabel,
	cronjobPromptMeta,
	formatCronjobPrompt,
} from "./cronjob-utils";
import type { TaskRealtimeEvent } from "./task-run-detail-controller.svelte";
import {
	displaySafeJson,
	taskRunDuration,
	taskRunStatusBadge,
} from "./task-run-utils";
import { withCurrentWindow } from "./window-route";

type Props = {
	mode: CronjobMode;
	spaceId: string;
	spaceName: string;
	spaceLoadError: string;
	spaceHasMinimalAccess: boolean;
	cronjobId: string | null;
	taskRealtimeEvent?: TaskRealtimeEvent | null;
	onDetailLoaded?: (job: CronJobRecord | null) => void;
};

let {
	mode,
	spaceId,
	spaceName,
	spaceLoadError,
	spaceHasMinimalAccess,
	cronjobId,
	taskRealtimeEvent = null,
	onDetailLoaded,
}: Props = $props();

const locale = $derived(getLocale());

let cronjobRunsSectionEl = $state<HTMLElement | null>(null);

const cronjob = createCronjobDetailController({
	getMode: () => mode,
	getSpaceId: () => spaceId,
	getCronjobId: () => cronjobId,
	onDetailLoaded: (job) => onDetailLoaded?.(job),
});

const cronjobDetail = $derived(cronjob.detail);
const cronjobDetailLoading = $derived(cronjob.detailLoading);
const cronjobDetailError = $derived(cronjob.detailError);
const cronjobRuns = $derived(cronjob.runs);
const cronjobRunsLoading = $derived(cronjob.runsLoading);
const cronjobRunsLoadingMore = $derived(cronjob.runsLoadingMore);
const cronjobRunsLoaded = $derived(cronjob.runsLoaded);
const cronjobRunsHasMore = $derived(cronjob.runsHasMore);
const cronjobRunsError = $derived(cronjob.runsError);
const cronjobActionInProgress = $derived(cronjob.actionInProgress);
const cronjobDeleteInProgress = $derived(cronjob.deleteInProgress);
const cronjobToggleError = $derived(cronjob.toggleError);
const cronjobFormSubmitting = $derived(cronjob.formSubmitting);
const cronjobFormError = $derived(cronjob.formError);
const cronjobCopiedId = $derived(cronjob.copiedId);
const cronjobNewSubmitting = $derived(cronjob.newSubmitting);
const cronjobNewError = $derived(cronjob.newError);

$effect(() => {
	cronjob.syncRoute();
});

$effect(() => {
	cronjob.applyRealtimeEvent(taskRealtimeEvent);
});

$effect(() => {
	return cronjob.maybeAutoLoadRuns(cronjobRunsSectionEl);
});

onDestroy(() => {
	cronjob.dispose();
});

function userTitle(
	profile: UserProfile | null | undefined,
	userUuid: string | null | undefined,
) {
	return [displayUserName(profile, userUuid), userUuid]
		.filter(Boolean)
		.join(" · ");
}

function payloadModelLabel(payload: unknown) {
	if (!payload || typeof payload !== "object") return "Default model";
	const model = (payload as { model?: unknown }).model;
	return typeof model === "string" && model.trim() ? model : "Default model";
}

function payloadProviderLabel(payload: unknown) {
	if (!payload || typeof payload !== "object") return "default";
	const provider = (payload as { provider?: unknown }).provider;
	return typeof provider === "string" && provider.trim() ? provider : "default";
}
</script>

{#snippet UserMetaItem(profile: UserProfile | null | undefined, userUuid: string | null | undefined)}
	{#if userUuid}
		<UserIdentity
			name={displayUserName(profile, userUuid)}
			avatarUrl={profile?.avatarUrl}
			seed={userUuid}
			username={profile?.username}
			title={userTitle(profile, userUuid)}
			size="xxs"
			class="text-[11px] text-text-tertiary"
		/>
	{/if}
{/snippet}

{#if mode === "create"}
	<div class="flex-1 min-h-0 overflow-y-auto px-4 py-5 sm:px-6 lg:px-workspace">
		<div class="max-w-3xl">
			{#if spaceLoadError && !spaceHasMinimalAccess}
				<div class="mb-3">
					<AccessStateView
						state={{ kind: "error", message: spaceLoadError }}
						size="compact"
					/>
				</div>
			{:else}
				<form onsubmit={cronjob.submitCreate} class="space-y-6">
					<header class="border-b border-border-subtle/70 pb-5">
						<div class="text-[10px] font-medium uppercase tracking-[0.18em] text-text-placeholder">{m.cron_scheduled_prompt({}, { locale })}</div>
						<h1 class="mt-2 text-[24px] font-semibold tracking-tight text-text-primary sm:text-[30px]">{m.cron_new_scheduled({}, { locale })}</h1>
						<p class="mt-2 max-w-2xl text-[13px] leading-6 text-text-tertiary">{m.cron_send_prompt_to({}, { locale })}<span class="font-medium text-text-primary">{spaceName}</span> on a recurring schedule.</p>
					</header>
					<section class="grid gap-6 lg:grid-cols-[minmax(0,1fr)_240px]">
						<div class="min-w-0 space-y-5">
							<div class="space-y-1.5">
								<label class="block text-[10px] font-medium uppercase tracking-wider text-text-tertiary" for="cronjob-title">{m.cron_title({}, { locale })}</label>
								<input id="cronjob-title" type="text" bind:value={cronjob.newTitle} placeholder={m.cron_placeholder_name({}, { locale })} class="w-full rounded-[6px] border border-border-subtle bg-bg-input px-3 py-2 text-[13px] text-text-primary placeholder:text-text-placeholder transition-colors focus:border-brand/50 focus:outline-none" />
							</div>
							<div class="space-y-1.5">
								<label class="block text-[10px] font-medium uppercase tracking-wider text-text-tertiary" for="cronjob-prompt">{m.cron_prompt({}, { locale })}</label>
								<textarea id="cronjob-prompt" bind:value={cronjob.newPrompt} rows="8" placeholder={m.cron_placeholder_content({}, { locale })} class="w-full resize-y rounded-[6px] border border-border-subtle bg-bg-input px-3 py-2 text-[13px] leading-6 text-text-primary placeholder:text-text-placeholder transition-colors focus:border-brand/50 focus:outline-none"></textarea>
							</div>
						</div>
						<aside class="space-y-5 text-[13px]">
							<div class="space-y-1.5">
								<label class="block text-[10px] font-medium uppercase tracking-wider text-text-placeholder" for="cronjob-expression">{m.cron_schedule({}, { locale })}</label>
								<input id="cronjob-expression" type="text" bind:value={cronjob.newExpression} placeholder="0 9 * * *" class="w-full rounded-[6px] border border-border-subtle bg-bg-input px-3 py-2 font-mono text-[13px] text-text-primary placeholder:text-text-placeholder transition-colors focus:border-brand/50 focus:outline-none" />
								<p class="text-[11px] leading-5 text-text-placeholder">{m.cron_schedule_hint({}, { locale })}</p>
							</div>
							<div class="space-y-1.5">
								<label class="block text-[10px] font-medium uppercase tracking-wider text-text-placeholder" for="cronjob-timezone">{m.cron_timezone({}, { locale })}</label>
								<input id="cronjob-timezone" type="text" bind:value={cronjob.newTimezone} placeholder="UTC" class="w-full rounded-[6px] border border-border-subtle bg-bg-input px-3 py-2 text-[13px] text-text-primary placeholder:text-text-placeholder transition-colors focus:border-brand/50 focus:outline-none" />
							</div>
							<div class="space-y-2">
								<div class="text-[10px] font-medium uppercase tracking-wider text-text-placeholder">{m.cron_model({}, { locale })}</div>
								<button type="button" class="flex min-h-10 w-full items-center justify-between gap-3 rounded-[6px] border border-border-subtle bg-bg-elevated/35 px-3 py-2 text-left transition-colors hover:bg-bg-hover" onclick={() => cronjob.openModelSelector("new") }>
									<span class="min-w-0 truncate text-[13px] text-text-primary">{cronjobModelLabel(cronjob.newModel)}</span>
									<Settings class="h-3.5 w-3.5 shrink-0 text-text-placeholder" />
								</button>
								{#if cronjob.newModel}
									<button type="button" class="text-[11px] text-text-placeholder transition-colors hover:text-text-secondary" onclick={() => { cronjob.newModel = null; }}>{m.cron_use_default_model({}, { locale })}</button>
								{/if}
							</div>
						</aside>
					</section>
					{#if cronjobNewError}
						<div class="rounded-md border border-error-soft/30 bg-error-bg p-3 text-[12px] font-mono text-error-soft break-all">{cronjobNewError}</div>
					{/if}
					<div class="flex flex-col-reverse gap-2 border-t border-border-subtle/70 pt-4 sm:flex-row sm:justify-end">
						<button type="button" class="inline-flex min-h-10 items-center justify-center rounded-[5px] border border-border-subtle px-3 py-2 text-[12px] text-text-secondary transition-colors hover:bg-bg-hover hover:text-text-primary" onclick={() => goto(buildSpaceNewSessionRoute(spaceId))}>{m.cron_cancel({}, { locale })}</button>
						<button type="submit" class="inline-flex min-h-10 items-center justify-center gap-2 rounded-[5px] bg-brand px-3 py-2 text-[12px] font-medium text-brand-contrast-fg transition-colors hover:bg-brand-hover disabled:opacity-50" disabled={cronjobNewSubmitting}>
							{#if cronjobNewSubmitting}<Loader2 class="h-3.5 w-3.5 animate-spin" />{:else}<Plus class="h-3.5 w-3.5" />{/if}
							<span>{m.cron_create({}, { locale })}</span>
						</button>
					</div>
				</form>
			{/if}
		</div>
	</div>
{:else}
	<div class="flex-1 min-h-0 overflow-y-auto px-4 py-5 sm:px-6 lg:px-workspace">
		<div class="max-w-5xl">
			{#if cronjobDetailLoading && cronjobDetail?.id !== cronjobId}
				<CenteredLoading label={m.loading_cronjob({}, { locale })} size="panel" />
			{:else if cronjobDetailError}
				<AccessStateView
					state={cronjobDetailError}
					size="compact"
				/>
			{:else if cronjobDetail && cronjobDetail.id === cronjobId}
				<div class="space-y-6 sm:space-y-8">
					<header class="flex flex-col gap-4 border-b border-border-subtle/70 pb-5 lg:flex-row lg:items-start lg:justify-between">
						<div class="min-w-0 space-y-3">
							<div>
								<h1 class="text-[24px] font-semibold tracking-tight text-text-primary break-words sm:text-[30px]">{cronjobDetail.title}</h1>
								<div class="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1.5">
									<span class="inline-flex items-center gap-1.5 text-[11px] font-medium text-brand">
										<span class="h-1.5 w-1.5 rounded-full {cronjobDetail.enabled ? 'bg-status-running' : 'bg-text-placeholder'}"></span>
										{cronjobDetail.enabled ? m.cron_active({}, { locale }) : m.cron_paused({}, { locale })}
									</span>
									{@render UserMetaItem(cronjobDetail.userProfile, cronjobDetail.userUuid)}
									<button type="button" class="inline-flex min-h-6 min-w-0 max-w-full items-center gap-1.5 font-mono text-[11px] text-text-placeholder transition-colors hover:text-text-secondary" onclick={() => void cronjob.copyId(cronjobDetail!.id)} title={m.cron_copy_id({}, { locale })}>
										<span class="truncate">{cronjobDetail.id}</span>
										{#if cronjobCopiedId}<Check class="h-3 w-3 shrink-0 text-success-soft" />{:else}<Copy class="h-3 w-3 shrink-0" />{/if}
									</button>
								</div>
							</div>
						</div>
						<div class="flex shrink-0 flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center">
							{#if cronjobDetail.taskType === 'send_message'}
								<button type="button" class="inline-flex min-h-9 w-full items-center justify-center gap-1.5 rounded-[5px] bg-bg-elevated px-3 py-2 text-[12px] font-medium text-text-secondary transition-colors hover:bg-bg-hover hover:text-text-primary sm:w-auto" onclick={() => { cronjob.syncFormFromDetail(); cronjob.editMode = !cronjob.editMode; }}>
									<Pencil class="h-3.5 w-3.5" />
									<span>{cronjob.editMode ? m.close_edit({}, { locale }) : m.common_edit({}, { locale })}</span>
								</button>
							{/if}
							<button type="button" class="inline-flex min-h-9 w-full items-center justify-center gap-1.5 rounded-[5px] bg-bg-elevated px-3 py-2 text-[12px] font-medium transition-colors hover:bg-bg-hover disabled:opacity-50 sm:w-auto {cronjobDetail.enabled ? 'text-status-running' : 'text-text-secondary'}" onclick={() => cronjob.toggle(!cronjobDetail!.enabled)} disabled={cronjobActionInProgress}>
								{#if cronjobActionInProgress}<Loader2 class="h-3.5 w-3.5 animate-spin" />{:else if cronjobDetail.enabled}<Power class="h-3.5 w-3.5" />{:else}<PowerOff class="h-3.5 w-3.5" />{/if}
								<span>{cronjobDetail.enabled ? m.cron_pause({}, { locale }) : m.cron_resume({}, { locale })}</span>
							</button>
							<button type="button" class="inline-flex min-h-9 w-full items-center justify-center gap-1.5 rounded-[5px] px-3 py-2 text-[12px] font-medium text-text-tertiary transition-colors hover:bg-bg-hover hover:text-error-soft disabled:opacity-50 sm:w-auto" onclick={cronjob.deleteCronjob} disabled={cronjobActionInProgress || cronjobDeleteInProgress}>
								{#if cronjobDeleteInProgress}<Loader2 class="h-3.5 w-3.5 animate-spin" />{:else}<Trash2 class="h-3.5 w-3.5" />{/if}
								<span>{cronjobDeleteInProgress ? m.cron_deleting({}, { locale }) : m.cron_delete({}, { locale })}</span>
							</button>
						</div>
					</header>
					{#if cronjobToggleError}
						<div class="rounded-[6px] border border-error-soft/30 bg-error-bg p-3 text-[12px] font-mono text-error-soft">{cronjobToggleError}</div>
					{/if}
					{#if cronjob.editMode && cronjobDetail.taskType === 'send_message'}
						<form onsubmit={cronjob.submitUpdate} class="space-y-6">
							<section class="grid gap-6 lg:grid-cols-[minmax(0,1fr)_260px]">
								<div class="min-w-0 space-y-5">
									<div class="space-y-1.5"><label class="block text-[10px] font-medium uppercase tracking-wider text-text-tertiary" for="cronjob-edit-title">{m.cron_title({}, { locale })}</label><input id="cronjob-edit-title" type="text" bind:value={cronjob.formTitle} class="w-full rounded-[6px] border border-border-subtle bg-bg-input px-3 py-2 text-[13px] text-text-primary transition-colors focus:border-brand/50 focus:outline-none" /></div>
									<div class="space-y-1.5"><label class="block text-[10px] font-medium uppercase tracking-wider text-text-tertiary" for="cronjob-edit-prompt">{m.cron_prompt({}, { locale })}</label>{#if cronjob.formStructuredPrompt}<div class="rounded-[6px] border border-border-subtle bg-bg-elevated/35 p-3 text-[12px] leading-5 text-text-tertiary">{m.cron_structured_warning({}, { locale })}</div>{/if}<textarea id="cronjob-edit-prompt" bind:value={cronjob.formPrompt} rows="9" class="w-full resize-y rounded-[6px] border border-border-subtle bg-bg-input px-3 py-2 text-[13px] leading-6 text-text-primary transition-colors focus:border-brand/50 focus:outline-none"></textarea></div>
								</div>
								<aside class="space-y-5 text-[13px]">
									<div class="space-y-1.5"><label class="block text-[10px] font-medium uppercase tracking-wider text-text-placeholder" for="cronjob-edit-expression">{m.cron_schedule({}, { locale })}</label><input id="cronjob-edit-expression" type="text" bind:value={cronjob.formExpression} class="w-full rounded-[6px] border border-border-subtle bg-bg-input px-3 py-2 font-mono text-[13px] text-text-primary transition-colors focus:border-brand/50 focus:outline-none" /></div>
									<div class="space-y-1.5"><label class="block text-[10px] font-medium uppercase tracking-wider text-text-placeholder" for="cronjob-edit-timezone">{m.cron_timezone({}, { locale })}</label><input id="cronjob-edit-timezone" type="text" bind:value={cronjob.formTimezone} class="w-full rounded-[6px] border border-border-subtle bg-bg-input px-3 py-2 text-[13px] text-text-primary transition-colors focus:border-brand/50 focus:outline-none" /></div>
									<div class="space-y-2"><div class="text-[10px] font-medium uppercase tracking-wider text-text-placeholder">{m.cron_model({}, { locale })}</div><button type="button" class="flex min-h-10 w-full items-center justify-between gap-3 rounded-[6px] border border-border-subtle bg-bg-elevated/35 px-3 py-2 text-left transition-colors hover:bg-bg-hover" onclick={() => cronjob.openModelSelector('edit')}><span class="min-w-0 truncate text-[13px] text-text-primary">{cronjobModelLabel(cronjob.formModel)}</span><Settings class="h-3.5 w-3.5 shrink-0 text-text-placeholder" /></button>{#if cronjob.formModel}<button type="button" class="text-[11px] text-text-placeholder transition-colors hover:text-text-secondary" onclick={() => { cronjob.formModel = null; }}>{m.cron_use_default_model({}, { locale })}</button>{/if}</div>
								</aside>
							</section>
							{#if cronjobFormError}<div class="rounded-md border border-error-soft/30 bg-error-bg p-3 text-[12px] font-mono text-error-soft break-all">{cronjobFormError}</div>{/if}
							<div class="flex flex-col-reverse gap-2 border-t border-border-subtle/70 pt-4 sm:flex-row sm:justify-end"><button type="button" class="inline-flex min-h-10 items-center justify-center rounded-[5px] border border-border-subtle px-3 py-2 text-[12px] text-text-secondary transition-colors hover:bg-bg-hover hover:text-text-primary" onclick={() => { cronjob.editMode = false; cronjob.syncFormFromDetail(); }}>{m.cron_cancel({}, { locale })}</button><button type="submit" class="inline-flex min-h-10 items-center justify-center gap-2 rounded-[5px] bg-brand px-3 py-2 text-[12px] font-medium text-brand-contrast-fg transition-colors hover:bg-brand-hover disabled:opacity-50" disabled={cronjobFormSubmitting}>{#if cronjobFormSubmitting}<Loader2 class="h-3.5 w-3.5 animate-spin" />{:else}<Check class="h-3.5 w-3.5" />{/if}<span>{m.cron_save_changes({}, { locale })}</span></button></div>
						</form>
					{:else}
						<section class="grid gap-6 lg:grid-cols-[minmax(0,1fr)_260px] lg:gap-8">
							<div class="min-w-0 space-y-6">
								{#if cronjobDetail.taskType === 'send_message'}
									<section class="space-y-3"><div><div class="text-[10px] font-medium uppercase tracking-[0.18em] text-text-placeholder">{m.cron_prompt({}, { locale })}</div><div class="mt-1 text-[12px] text-text-tertiary">{cronjobPromptMeta(cronjobDetail.payload)}</div></div><div class="relative overflow-hidden rounded-[8px] bg-bg-elevated/40 ring-1 ring-border-subtle/60"><div class="absolute left-0 top-0 h-full w-[3px] bg-brand"></div><pre class="max-h-[460px] overflow-auto px-5 py-4 pl-6 text-[13px] leading-6 text-text-secondary whitespace-pre-wrap break-words">{formatCronjobPrompt(cronjobDetail.payload)}</pre></div></section>
									<section class="grid gap-3 sm:grid-cols-2"><div class="rounded-[7px] bg-bg-elevated/30 px-3 py-2.5"><div class="text-[10px] font-medium uppercase tracking-wider text-text-placeholder">{m.cron_model({}, { locale })}</div><div class="mt-1 truncate text-[13px] text-text-primary">{payloadModelLabel(cronjobDetail.payload)}</div></div><div class="rounded-[7px] bg-bg-elevated/30 px-3 py-2.5"><div class="text-[10px] font-medium uppercase tracking-wider text-text-placeholder">{m.cron_provider({}, { locale })}</div><div class="mt-1 font-mono text-[12px] text-text-secondary">{payloadProviderLabel(cronjobDetail.payload)}</div></div></section>
								{:else}
									<section class="space-y-2"><div class="text-[10px] font-medium uppercase tracking-[0.18em] text-text-placeholder">{m.cron_payload({}, { locale })}</div><pre class="max-h-[520px] overflow-auto rounded-[8px] bg-bg-elevated/35 p-3 text-[12px] font-mono leading-relaxed text-text-secondary whitespace-pre-wrap break-all">{displaySafeJson(cronjobDetail.payload, { locale })}</pre></section>
								{/if}
							</div>
							<aside class="space-y-5 text-[13px]">
								<div class="space-y-3"><div class="text-[10px] font-medium uppercase tracking-[0.18em] text-text-placeholder">{m.cron_schedule({}, { locale })}</div><div><div class="flex items-center gap-2 text-[11px] font-medium uppercase tracking-wider text-text-placeholder"><Clock class="h-3.5 w-3.5" /> {m.cron_expression({}, { locale })}</div><div class="mt-1.5 font-mono text-[15px] text-text-primary break-all">{cronjobDetail.cronExpression}</div></div><div><div class="flex items-center gap-2 text-[11px] font-medium uppercase tracking-wider text-text-placeholder"><Clock3 class="h-3.5 w-3.5" /> {m.cron_timezone({}, { locale })}</div><div class="mt-1.5 text-text-primary">{cronjobDetail.timezone}</div></div></div>
								<div class="h-px bg-border-subtle/70"></div>
								<div class="space-y-3"><div class="text-[10px] font-medium uppercase tracking-[0.18em] text-text-placeholder">{m.cron_metadata({}, { locale })}</div><div class="grid grid-cols-[76px_minmax(0,1fr)] gap-x-3 gap-y-2 text-[12px]"><div class="text-text-placeholder">{m.cron_type({}, { locale })}</div><div class="font-mono text-text-secondary break-all">{cronjobDetail.taskType}</div><div class="text-text-placeholder">{m.cron_session({}, { locale })}</div><div class="font-mono text-text-secondary break-all">{cronjobDetail.sessionId ?? m.cron_new_session_on_run({}, { locale })}</div><div class="text-text-placeholder">{m.cron_created({}, { locale })}</div><div class="text-text-secondary">{formatDateTime(cronjobDetail.createdAt, locale)}</div><div class="text-text-placeholder">{m.cron_updated({}, { locale })}</div><div class="text-text-secondary">{formatDateTime(cronjobDetail.updatedAt, locale)}</div></div></div>
							</aside>
						</section>
					{/if}
					<section bind:this={cronjobRunsSectionEl} class="border-t border-border-subtle/70 pt-6">
						<div class="mb-3 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between"><div><div class="text-[10px] font-medium uppercase tracking-[0.18em] text-text-placeholder">{m.cron_runs({}, { locale })}</div><div class="mt-1 text-[12px] text-text-tertiary">{cronjobRunsLoaded ? m.cron_runs_loaded({ count: cronjobRuns.length }, { locale }) : m.cron_runs_not_loaded({}, { locale })}</div></div>{#if !cronjobRunsLoaded}<button type="button" class="inline-flex min-h-9 items-center justify-center gap-1.5 rounded-[5px] border border-border-subtle px-3 py-2 text-[12px] text-text-secondary transition-colors hover:bg-bg-hover hover:text-text-primary" onclick={() => cronjob.loadRuns({ reset: true })} disabled={cronjobRunsLoading}>{#if cronjobRunsLoading}<Loader2 class="h-3.5 w-3.5 animate-spin" />{/if}<span>{m.cron_load_runs({}, { locale })}</span></button>{/if}</div>
						{#if cronjobRunsError}<div class="rounded-md border border-error-soft/30 bg-error-bg p-3 text-[12px] font-mono text-error-soft break-all">{cronjobRunsError}</div>{:else if cronjobRunsLoading && !cronjobRunsLoaded}<CenteredLoading label={m.loading_runs({}, { locale })} size="panel" />{:else if cronjobRuns.length > 0}<div class="divide-y divide-border-subtle/60">{#each cronjobRuns as run (run.id)}{@const badge = taskRunStatusBadge(run, locale)}<a href={withCurrentWindow(buildSpaceTaskRoute(spaceId, run.id))} class="block py-3 text-[12px] transition-colors hover:bg-bg-hover/70 sm:grid sm:grid-cols-[minmax(92px,0.8fr)_minmax(132px,1fr)_80px_minmax(0,1.5fr)] sm:items-center sm:gap-3 sm:py-2.5" onclick={(e) => { e.preventDefault(); goto(withCurrentWindow(buildSpaceTaskRoute(spaceId, run.id))); }}><span class="flex items-center gap-2 px-1"><span class="h-[6px] w-[6px] shrink-0 rounded-full {badge.dot}"></span><span class="{badge.color}">{badge.label}</span></span><span class="mt-1 block font-mono text-text-placeholder sm:mt-0">{formatShortDateTime(run.scheduledAt ?? run.createdAt, locale)}</span><span class="mt-1 block font-mono text-text-placeholder sm:mt-0">{taskRunDuration(run, locale)}</span><span class="mt-1 block truncate text-[11px] {run.errorMessage ? 'text-status-error' : 'text-text-placeholder'} sm:mt-0" title={run.errorMessage ?? run.id}>{run.errorMessage ?? run.id}</span></a>{/each}</div>{#if cronjobRunsHasMore}<div class="mt-4"><button type="button" class="inline-flex min-h-10 w-full items-center justify-center gap-2 rounded-[5px] border border-border-subtle px-3 py-2 text-[12px] text-text-secondary transition-colors hover:bg-bg-hover hover:text-text-primary sm:w-auto" onclick={() => cronjob.loadRuns()} disabled={cronjobRunsLoadingMore}>{#if cronjobRunsLoadingMore}<Loader2 class="h-3.5 w-3.5 animate-spin" />{/if}<span>{m.cron_load_more({}, { locale })}</span></button></div>{/if}{:else if cronjobRunsLoaded}<div class="py-6 text-[13px] text-text-tertiary">{m.cron_empty_runs({}, { locale })}</div>{/if}
					</section>
				</div>
			{:else}
				<div class="text-[12px] text-text-tertiary">{m.cron_not_found({}, { locale })}</div>
			{/if}
		</div>
	</div>
{/if}

<ModelSelector
	open={cronjob.modelSelectorOpen}
	onClose={() => { cronjob.modelSelectorOpen = false; }}
	onSelect={cronjob.selectModel}
	models={cronjob.modelsCatalog ?? []}
	currentModel={mode === "create" ? cronjob.newModel : cronjob.formModel}
	currentThinkingLevel={mode === "create" ? cronjob.newModel?.thinkingLevel ?? null : cronjob.formModel?.thinkingLevel ?? null}
/>
