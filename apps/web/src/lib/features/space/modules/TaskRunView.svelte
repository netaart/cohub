<script lang="ts">
import type { TaskRunRecord, UserProfile } from "@neta-art/cohub";
import { mediaPreviewCandidates } from "@neta-art/cohub/media";
import { Check, Copy, GitCommitHorizontal } from "lucide-svelte";
import { onDestroy } from "svelte";
import { goto } from "$app/navigation";
import AudioPlayer from "$lib/components/AudioPlayer.svelte";
import CenteredLoading from "$lib/components/CenteredLoading.svelte";
import MediaImage from "$lib/components/MediaImage.svelte";
import MessageContentFlow from "$lib/components/MessageContentFlow.svelte";
import { mediaLightbox } from "$lib/components/media-lightbox";
import UserIdentity from "$lib/components/UserIdentity.svelte";
import {
	buildSpaceCheckpointRoute,
	buildSpaceCronjobRoute,
} from "$lib/space-routes";
import { displayUserName, formatDateTime } from "../space-utils";
import {
	createTaskRunDetailController,
	type TaskRealtimeEvent,
} from "./task-run-detail-controller.svelte";
import {
	appActionInput,
	appActionName,
	checkpointIdFromTaskRun,
	displaySafeJson,
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
	taskRawResult,
	taskRunDuration,
	taskRunStatusBadge,
	taskTypeLabel,
} from "./task-run-utils";
import { withCurrentWindow } from "./window-route";

type Props = {
	spaceId: string;
	taskId: string | null;
	taskRealtimeEvent?: TaskRealtimeEvent | null;
	onDetailLoaded?: (run: TaskRunRecord | null) => void;
};

import { getLocale } from "$lib/i18n/locale.svelte";
import { m } from "$lib/paraglide/messages.js";

let {
	spaceId,
	taskId,
	taskRealtimeEvent = null,
	onDetailLoaded,
}: Props = $props();

const locale = $derived(getLocale());

/** Output stills fill a 60vh column; the largest variant covers it on any screen (video frames cap themselves). */
const OUTPUT_PREVIEW_SIZE = 1536;

/** Opens the run's image outputs as one gallery, starting at `start`. */
function openOutputImage(blocks: Record<string, unknown>[], start: number) {
	const images = blocks.flatMap((block, index) => {
		const src = block.type === "image" ? generationBlockSource(block) : null;
		if (!src) return [];
		const alt = generationBlockLabel(block, index);
		return [{ index, item: { type: "image" as const, src, alt } }];
	});
	mediaLightbox.show(
		images.map(({ item }) => item),
		images.findIndex(({ index }) => index === start),
	);
}

const taskDetail = createTaskRunDetailController({
	getSpaceId: () => spaceId,
	getTaskId: () => taskId,
	onDetailLoaded: (run) => onDetailLoaded?.(run),
});

const taskRunDetail = $derived(taskDetail.detail);
const taskRunDetailLoading = $derived(taskDetail.loading);
const taskRunDetailError = $derived(taskDetail.error);
const taskRunProgress = $derived(taskDetail.progress);
const taskCopiedField = $derived(taskDetail.copiedField);

// Only auto-redirect when this page session watched the task complete.
// Opening an already-finished historical task keeps the task detail page.
let watchedActiveTaskId = $state<string | null>(null);
let redirectedCheckpointTaskId = $state<string | null>(null);

$effect(() => {
	taskDetail.syncRoute();
});

$effect(() => {
	taskDetail.applyRealtimeEvent(taskRealtimeEvent);
});

$effect(() => {
	const run = taskRunDetail;
	if (!run || run.id !== taskId) return;

	if (taskIsStreaming(run)) {
		watchedActiveTaskId = run.id;
		return;
	}

	if (
		run.taskType !== "save_checkpoint" ||
		run.status !== "completed" ||
		watchedActiveTaskId !== run.id ||
		redirectedCheckpointTaskId === run.id
	) {
		return;
	}

	const checkpointId = checkpointIdFromTaskRun(run);
	if (!checkpointId) return;

	redirectedCheckpointTaskId = run.id;
	void goto(
		withCurrentWindow(buildSpaceCheckpointRoute(spaceId, checkpointId)),
		{
			replaceState: true,
		},
	);
});

onDestroy(() => {
	taskDetail.dispose();
});

function userTitle(
	profile: UserProfile | null | undefined,
	userUuid: string | null | undefined,
): string {
	return [displayUserName(profile, userUuid), userUuid]
		.filter(Boolean)
		.join(" · ");
}
</script>

{#snippet UserMetaItem(profile: UserProfile | null | undefined, userUuid: string | null | undefined)}
	{#if userUuid}
		<UserIdentity
			name={displayUserName(profile, userUuid)}
			avatarUrl={profile?.avatarUrl}
			username={profile?.username}
			title={userTitle(profile, userUuid)}
			size="xxs"
			class="text-[11px] text-text-tertiary"
		/>
	{/if}
{/snippet}

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

<div class="flex-1 min-h-0 overflow-y-auto px-3 py-4 sm:px-6 sm:py-5 lg:px-8">
	<div class="max-w-4xl">
		{#if taskRunDetailLoading && taskRunDetail?.id !== taskId}
			<CenteredLoading label={m.loading_task({}, { locale })} size="panel" />
		{:else if taskRunDetailError}
			<div class="rounded-md border border-error-soft/30 bg-error-bg p-3 text-[12px] font-mono text-error-soft break-all">{taskRunDetailError}</div>
		{:else if taskRunDetail && taskRunDetail.id === taskId}
			{@const badge = taskRunStatusBadge(taskRunDetail, locale)}
			{@const actionName = appActionName(taskRunDetail)}
			{@const resultCheckpointId = checkpointIdFromTaskRun(taskRunDetail)}
			{@const saveStageLabel = taskRunDetail.taskType === "save_checkpoint" ? saveCheckpointProgressLabel(taskRunProgress, locale) : null}
			{@const commandInfo = runCommandPayload(taskRunDetail)}
			{@const actionInput = appActionInput(taskRunDetail)}
			{@const commandMeta = runCommandResultMeta(taskRunDetail)}
			{@const outputContent = taskOutputContent(taskRunDetail, taskRunProgress)}
			{@const generationBlocks = generationOutputBlocks(taskRunDetail)}
			{@const rawResult = taskRawResult(taskRunDetail)}
			<div class="space-y-6 sm:space-y-8">
				<header class="flex flex-col gap-4 border-b border-border-subtle/70 pb-5 lg:flex-row lg:items-start lg:justify-between">
					<div class="min-w-0 space-y-3">
						<div>
							<h1 class="text-[24px] font-semibold tracking-tight text-text-primary sm:text-[30px]">{actionName ? m.task_type_app_action({ action: actionName }, { locale }) : taskTypeLabel(taskRunDetail.taskType, locale)}</h1>
							<div class="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1.5">
								<span class="inline-flex items-center gap-1.5 text-[11px] font-medium {badge.color}">
									<span class="relative flex h-1.5 w-1.5 shrink-0">
										{#if taskIsStreaming(taskRunDetail)}
											<span class="absolute inline-flex h-full w-full animate-ping rounded-full {badge.dot} opacity-40"></span>
										{/if}
										<span class="relative inline-flex h-1.5 w-1.5 rounded-full {badge.dot}"></span>
									</span>
									{badge.label}
								</span>
								{@render UserMetaItem(taskRunDetail.userProfile, taskRunDetail.userUuid)}
								{@render CopyIdMetaItem(taskRunDetail.id, taskCopiedField === "id", () => void taskDetail.copyField("id", taskRunDetail!.id), m.copy_task_id({}, { locale }))}
							</div>
							<div class="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px] text-text-tertiary">
								<span>{taskContextLabel(taskRunDetail, locale)}</span>
								<span class="text-text-placeholder">·</span>
								<span>{taskAttemptsLabel(taskRunDetail, locale)}</span>
								{#if taskRunDetail.cronJobId}
									<span class="text-text-placeholder">·</span>
									<a
										href={withCurrentWindow(buildSpaceCronjobRoute(spaceId, taskRunDetail.cronJobId))}
										class="text-text-secondary transition-colors hover:text-brand"
										onclick={(e) => { e.preventDefault(); goto(withCurrentWindow(buildSpaceCronjobRoute(spaceId, taskRunDetail!.cronJobId!))); }}
									>{m.task_view_cronjob({}, { locale })}</a>
								{/if}
							</div>
						</div>
					</div>
				</header>

				{#if taskIsStreaming(taskRunDetail) && taskRunProgress !== null && taskRunProgress !== undefined}
					<section class="space-y-2">
						<div class="text-[11px] font-medium uppercase tracking-wider text-text-placeholder">{m.task_section_progress({}, { locale })}</div>
						<pre class="max-h-[42vh] overflow-auto rounded-[7px] bg-bg-elevated/35 p-3 text-[12px] font-mono leading-relaxed text-text-secondary whitespace-pre-wrap break-all sm:max-h-80">{displaySafeJson(taskRunProgress, { maxStringLength: 12_000, locale })}</pre>
					</section>
				{/if}

				{#if taskRunDetail.taskType === "run_command" && commandInfo.command}
					<section class="space-y-2">
						<div class="text-[11px] font-medium uppercase tracking-wider text-text-placeholder">{m.task_section_command({}, { locale })}</div>
						<div class="rounded-[8px] bg-bg-elevated/35 px-4 py-3">
							<pre class="max-w-full whitespace-pre-wrap break-words font-mono text-[13px] leading-relaxed text-text-primary sm:text-[14px]">{commandInfo.command}</pre>
							<div class="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[12px] text-text-tertiary">
								<span class="font-mono">{commandInfo.cwd}</span>
								{#if commandMeta.exitCode !== null}
									<span class="font-mono">exit {commandMeta.exitCode}</span>
								{/if}
								<span>{formatDurationMs(commandMeta.durationMs, locale)}</span>
								<span>{formatDateTime(taskRunDetail.createdAt, locale)}</span>
							</div>
						</div>
					</section>
				{/if}

				{#if actionInput !== null}
					<section class="space-y-2">
						<div class="text-[11px] font-medium uppercase tracking-wider text-text-placeholder">{m.task_section_input({}, { locale })}</div>
						<pre class="max-h-[36vh] overflow-auto rounded-[8px] bg-bg-elevated/35 p-3 text-[12px] font-mono leading-relaxed text-text-secondary whitespace-pre-wrap break-all">{displaySafeJson(actionInput, { locale })}</pre>
					</section>
				{/if}

				{#if taskRunDetail.taskType === "save_checkpoint"}
					<section class="flex flex-col gap-3 rounded-[8px] bg-bg-elevated/35 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
						<div class="min-w-0">
							<div class="text-[11px] font-medium uppercase tracking-wider text-text-placeholder">{m.task_section_checkpoint({}, { locale })}</div>
							<div class="mt-1 text-[13px] text-text-secondary">
								{#if resultCheckpointId}
									{m.save_checkpoint_ready({}, { locale })}
								{:else if saveStageLabel}
									{saveStageLabel}
								{:else}
									{m.task_waiting_checkpoint({}, { locale })}
								{/if}
							</div>
						</div>
						{#if resultCheckpointId}
							<a
								href={withCurrentWindow(buildSpaceCheckpointRoute(spaceId, resultCheckpointId))}
								class="inline-flex min-h-9 shrink-0 items-center justify-center gap-1.5 rounded-[5px] bg-brand-muted px-3 py-2 text-[12px] font-medium text-brand transition-colors hover:bg-brand-muted-hover"
								onclick={(e) => { e.preventDefault(); goto(withCurrentWindow(buildSpaceCheckpointRoute(spaceId, resultCheckpointId))); }}
							>
								<GitCommitHorizontal class="w-3.5 h-3.5" />
								<span>{m.task_view_checkpoint({}, { locale })}</span>
							</a>
						{/if}
					</section>
				{/if}

				<section class="space-y-5 sm:space-y-6">
					<div class="min-w-0 space-y-6">
						{#if generationBlocks.length > 0}
							<div class="space-y-3">
								<div class="text-[11px] font-medium uppercase tracking-wider text-text-placeholder">{m.task_section_output({}, { locale })}</div>
								<div class="space-y-3">
									{#each generationBlocks as block, index}
										{@const blockText = generationBlockText(block)}
										{@const blockSrc = generationBlockSource(block)}
										{@const blockMeta = generationBlockMeta(block)}
										<div class="rounded-[8px] bg-bg-elevated/35 p-3">
											<div class="mb-2 flex items-center justify-between gap-3 text-[11px] text-text-tertiary">
												<span class="truncate">{generationBlockLabel(block, index)}</span>
												{#if blockMeta}<span class="shrink-0 font-mono text-text-placeholder">{blockMeta}</span>{/if}
											</div>
											{#if blockText !== null}
												<div class="whitespace-pre-wrap break-words text-[13px] leading-6 text-text-secondary">{blockText}</div>
											{:else if block.type === "image" && blockSrc}
												<button type="button" class="block w-full cursor-zoom-in" onclick={() => openOutputImage(generationBlocks, index)}>
													<MediaImage
														candidates={mediaPreviewCandidates({ type: "image", url: blockSrc }, { size: OUTPUT_PREVIEW_SIZE })}
														alt={generationBlockLabel(block, index)}
														class="max-h-[60vh] w-full rounded-[6px] object-contain"
													/>
												</button>
											{:else if block.type === "video" && blockSrc}
												{@const [poster] = mediaPreviewCandidates({ type: "video", url: blockSrc }, { size: OUTPUT_PREVIEW_SIZE })}
												<video src={blockSrc} {poster} controls preload={poster ? "none" : "metadata"} class="max-h-[60vh] w-full rounded-[6px]"><track kind="captions" label={m.track_generated_video({}, { locale })} /></video>
											{:else if block.type === "audio" && blockSrc}
												<AudioPlayer
													src={blockSrc}
													title={generationBlockLabel(block, index)}
												/>
											{:else}
												<pre class="max-h-[40vh] overflow-auto text-[12px] font-mono leading-relaxed text-text-secondary whitespace-pre-wrap break-all">{displaySafeJson(block, { maxStringLength: 12_000, locale })}</pre>
											{/if}
										</div>
									{/each}
								</div>
							</div>
						{:else if outputContent.length > 0}
							<div class="space-y-2">
								<div class="text-[11px] font-medium uppercase tracking-wider text-text-placeholder">{m.task_section_output({}, { locale })}</div>
								<MessageContentFlow content={outputContent} thinkingExpanded={true} isStreaming={taskIsStreaming(taskRunDetail)} defaultExpandToolCalls />
							</div>
						{:else if taskIsStreaming(taskRunDetail)}
							<div class="py-6 text-[13px] text-text-tertiary">{m.task_waiting_output({}, { locale })}</div>
						{/if}

						<div class="grid gap-x-8 gap-y-4 sm:grid-cols-2">
							<div class="space-y-1"><div class="text-[11px] font-medium uppercase tracking-wider text-text-placeholder">{m.task_section_scheduled({}, { locale })}</div><div class="text-[13px] text-text-primary">{formatDateTime(taskRunDetail.scheduledAt, locale)}</div></div>
							<div class="space-y-1"><div class="text-[11px] font-medium uppercase tracking-wider text-text-placeholder">{m.task_section_duration({}, { locale })}</div><div class="text-[13px] text-text-primary">{taskRunDuration(taskRunDetail, locale)}</div></div>
							<div class="space-y-1"><div class="text-[11px] font-medium uppercase tracking-wider text-text-placeholder">{m.task_section_started({}, { locale })}</div><div class="text-[13px] text-text-primary">{formatDateTime(taskRunDetail.startedAt, locale)}</div></div>
							<div class="space-y-1"><div class="text-[11px] font-medium uppercase tracking-wider text-text-placeholder">{m.task_section_finished({}, { locale })}</div><div class="text-[13px] text-text-primary">{formatDateTime(taskRunDetail.finishedAt, locale)}</div></div>
						</div>

						<div class="space-y-2">
							<div class="flex items-center justify-between gap-3">
								<div class="text-[11px] font-medium uppercase tracking-wider text-text-placeholder">{m.task_section_payload({}, { locale })}</div>
								<button type="button" class="inline-flex min-h-8 items-center gap-1 rounded-[4px] px-2 py-1 text-[11px] text-text-placeholder transition-colors hover:bg-bg-hover hover:text-text-secondary" onclick={() => void taskDetail.copyField("payload", taskRunDetail!.payload)} title={m.task_copy_payload({}, { locale })}>
									{#if taskCopiedField === "payload"}<Check class="h-3 w-3 text-success-soft" /><span class="text-success-soft">{m.copied({}, { locale })}</span>{:else}<Copy class="h-3 w-3" /><span>{m.copy({}, { locale })}</span>{/if}
								</button>
							</div>
							<pre class="max-h-[48vh] overflow-auto rounded-[7px] bg-bg-elevated/35 p-3 text-[12px] font-mono leading-relaxed text-text-secondary whitespace-pre-wrap break-all sm:max-h-[520px]">{displaySafeJson(taskRunDetail.payload, { locale })}</pre>
						</div>

						{#if rawResult}
							<div class="space-y-2">
								<div class="flex items-center justify-between gap-3">
									<div class="text-[11px] font-medium uppercase tracking-wider text-text-placeholder">{m.task_section_result({}, { locale })}</div>
									<button type="button" class="inline-flex min-h-8 items-center gap-1 rounded-[4px] px-2 py-1 text-[11px] text-text-placeholder transition-colors hover:bg-bg-hover hover:text-text-secondary" onclick={() => void taskDetail.copyField("result", rawResult)} title={m.task_copy_result({}, { locale })}>
										{#if taskCopiedField === "result"}<Check class="h-3 w-3 text-success-soft" /><span class="text-success-soft">{m.copied({}, { locale })}</span>{:else}<Copy class="h-3 w-3" /><span>{m.copy({}, { locale })}</span>{/if}
									</button>
								</div>
								<pre class="max-h-[48vh] overflow-auto rounded-[7px] bg-bg-elevated/35 p-3 text-[12px] font-mono leading-relaxed text-text-secondary whitespace-pre-wrap break-all sm:max-h-[520px]">{displaySafeJson(rawResult, { locale })}</pre>
							</div>
						{/if}

						{#if taskRunDetail.errorMessage}
							<div class="rounded-[7px] bg-error-bg p-4">
								<div class="text-[11px] font-medium uppercase tracking-wider text-error-soft">{m.task_section_error({}, { locale })}</div>
								<div class="mt-2 text-[13px] text-error-soft whitespace-pre-wrap break-all">{taskRunDetail.errorMessage}</div>
							</div>
						{/if}
					</div>
				</section>
			</div>
		{:else}
			<div class="text-[12px] text-text-tertiary">{m.task_not_found({}, { locale })}</div>
		{/if}
	</div>
</div>
