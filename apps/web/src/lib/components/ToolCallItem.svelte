<script lang="ts">
import { ChevronDown, ChevronRight, Loader2 } from "lucide-svelte";
import ImageBlocks from "$lib/components/ImageBlocks.svelte";
import RelatedSessionLink from "$lib/components/RelatedSessionLink.svelte";
import ToolInputDetail from "$lib/components/ToolInputDetail.svelte";
import ToolOutputDetail from "$lib/components/ToolOutputDetail.svelte";
import {
	getToolFilePath,
	sanitizeToolDomId,
	summarizeToolInput,
	type ToolCallViewModel,
} from "$lib/components/tool-call-format";
import {
	formatDurationDetail,
	formatDurationMs,
	isDisplayableDurationMs,
} from "$lib/format-duration";
import { getLocale } from "$lib/i18n/locale.svelte";
import { m } from "$lib/paraglide/messages.js";
import { NO_SENT_SESSIONS } from "$lib/sent-turns";
import { useSessionRelations } from "$lib/session-relations-context";
import type { OpenWorkspaceFileTarget } from "$lib/workspace-file-links";

type Props = {
	tool: ToolCallViewModel;
	loading?: boolean;
	needsDetails?: boolean;
	defaultExpanded?: boolean;
	autoExpandWhileRunning?: boolean;
	showDuration?: boolean;
	onExpand?: () => void | Promise<void>;
	onOpenFile?: (target: OpenWorkspaceFileTarget) => void;
};

const {
	tool,
	loading = false,
	needsDetails = false,
	defaultExpanded = false,
	autoExpandWhileRunning = false,
	showDuration = true,
	onExpand,
	onOpenFile,
}: Props = $props();

const locale = $derived(getLocale());

let expanded = $state(false);
let userToggled = $state(false);

const statusDotMap = {
	done: "bg-status-running/80",
	running: "bg-brand shadow-[0_0_0_3px_var(--brand-muted)]",
	failed: "bg-status-error",
} as const;

function toolActivityVerb(name: string): string {
	switch (name) {
		case "bash":
			return m.tool_verb_executing({}, { locale });
		case "edit":
			return m.tool_verb_patching({}, { locale });
		case "find":
		case "grep":
			return m.tool_verb_scanning({}, { locale });
		case "ls":
			return m.tool_verb_listing({}, { locale });
		case "read":
			return m.tool_verb_reading({}, { locale });
		case "write":
			return m.tool_verb_writing({}, { locale });
		default:
			return m.tool_verb_running({}, { locale });
	}
}

const visibleResult = $derived(tool.partialResult || tool.result || "");
const hasVisibleResult = $derived(Boolean(visibleResult));
const shouldWaitForDetails = $derived(expanded && loading && needsDetails);
const isPlaceholderResult = $derived(
	shouldWaitForDetails && (tool.result === "[]" || tool.result === ""),
);
const showResult = $derived(
	hasVisibleResult &&
		!isPlaceholderResult &&
		(!needsDetails || Boolean(tool.partialResult) || autoExpandWhileRunning),
);
const resultLabel = $derived(
	tool.status === "failed"
		? m.tool_err({}, { locale })
		: m.tool_out({}, { locale }),
);
const filePath = $derived(getToolFilePath(tool.name, tool.input));
const isRunning = $derived(tool.status === "running");
const runningPhase = $derived(tool.phase ?? "drafting");
const runningVerb = $derived(toolActivityVerb(tool.name));
const durationLabel = $derived(
	showDuration && isDisplayableDurationMs(tool.durationMs)
		? formatDurationMs(tool.durationMs, locale)
		: "",
);
const durationTitle = $derived(
	showDuration && isDisplayableDurationMs(tool.durationMs)
		? formatDurationDetail(
				tool.durationMs,
				m.chat_duration({}, { locale }),
				locale,
			)
		: "",
);
const statusLabel = $derived(
	isRunning
		? runningPhase === "drafting"
			? m.tool_receiving_call({}, { locale })
			: runningVerb
		: tool.status === "failed"
			? m.tool_status_failed({}, { locale })
			: tool.status === "done"
				? m.tool_status_done({}, { locale })
				: durationLabel || tool.status,
);
const inputSummary = $derived(summarizeToolInput(tool.name, tool.input));
const detailIdPrefix = $derived(`tool-call-${sanitizeToolDomId(tool.id)}`);
const relations = useSessionRelations();
const sentSessions = $derived(
	relations?.sentByToolCall(tool.id) ?? NO_SENT_SESSIONS,
);

$effect(() => {
	if (
		(defaultExpanded || (autoExpandWhileRunning && isRunning)) &&
		!userToggled &&
		!expanded
	) {
		expanded = true;
		void onExpand?.();
	}
});

function toggle() {
	const opening = !expanded;
	expanded = opening;
	userToggled = true;
	if (opening) void onExpand?.();
}

function handleFileClick(e: MouseEvent | KeyboardEvent) {
	e.stopPropagation();
	if (filePath) onOpenFile?.(filePath);
}
</script>

<div class="group/tool rounded-md">
	<button
		type="button"
		class={`relative flex min-h-7 w-full items-center gap-2 rounded-md py-1 px-0 text-left transition-colors duration-150 hover:bg-bg-hover/50 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-brand/35 ${isRunning ? 'tool-call-running' : ''}`}
		onclick={toggle}
	>
		<span class="h-1.5 w-1.5 shrink-0 rounded-full transition-[background-color,box-shadow,opacity,transform] duration-200 {statusDotMap[tool.status]} {isRunning ? 'tool-call-dot' : ''}"></span>
		<span class="w-[3.25rem] shrink-0 truncate font-mono text-[13px] text-text-tertiary">{tool.name}</span>
		{#if filePath}
			<span
				role="link"
				tabindex="0"
				class="min-w-0 max-w-[56%] truncate font-mono text-[13px] text-text-secondary/85 underline-offset-2 transition-colors hover:text-text-primary hover:underline hover:decoration-brand/35 sm:max-w-[68%]"
				onclick={handleFileClick}
				onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); handleFileClick(e); } }}
				title={m.tool_open_file({}, { locale })}
			>{filePath}</span>
		{:else if inputSummary}
			<span class="min-w-0 flex-1 truncate font-mono text-[13px] text-text-placeholder">{inputSummary}</span>
		{:else}
			<span class="min-w-0 flex-1"></span>
		{/if}
		<span class={`ml-auto shrink-0 text-[11px] tabular-nums ${isRunning ? 'text-brand/75' : tool.status === 'failed' ? 'text-status-error' : 'text-text-placeholder'}`} title={durationTitle || undefined}>
			{statusLabel}
		</span>
		<span class="shrink-0 text-text-tertiary">
			{#if loading && expanded}
				<Loader2 class="h-3.5 w-3.5 animate-spin text-text-placeholder" />
			{:else if expanded}
				<ChevronDown class="h-3.5 w-3.5" />
			{:else}
				<ChevronRight class="h-3.5 w-3.5" />
			{/if}
		</span>
	</button>

	{#if expanded}
		<div class="ml-[3px] border-l border-border-subtle/70 py-1 pl-[21px] pr-2 max-sm:pl-3 max-sm:pr-1">
			{#if shouldWaitForDetails}
				<div class="inline-flex items-center gap-1.5 py-0.5 text-[12px] leading-snug text-text-placeholder">
					<Loader2 class="h-3 w-3 animate-spin" />
					{m.tool_loading_details({}, { locale })}
				</div>
			{:else}
				<div class="space-y-2">
					{#if tool.input && Object.keys(tool.input).length > 0}
						<div class="grid grid-cols-[1.75rem_minmax(0,1fr)] items-start gap-2 max-sm:grid-cols-[1.25rem_minmax(0,1fr)] max-sm:gap-1.5">
							<div class="pt-[3px] font-mono text-[10px] uppercase leading-none tracking-wide text-text-placeholder select-none">{m.tool_in({}, { locale })}</div>
							<ToolInputDetail name={tool.name} input={tool.input} idPrefix={detailIdPrefix} autoFollow={isRunning} />
						</div>
					{/if}
					{#if showResult}
						<div class="grid grid-cols-[1.75rem_minmax(0,1fr)] items-start gap-2">
							<div class="pt-[3px] font-mono text-[10px] uppercase leading-none tracking-wide select-none {tool.status === 'failed' ? 'text-status-error' : 'text-text-placeholder'}">{resultLabel}</div>
							<div class="min-w-0 space-y-2">
								<ToolOutputDetail value={visibleResult} failed={tool.status === 'failed'} partial={tool.resultPartial} idPrefix={detailIdPrefix} />
								{#if tool.resultImages}
									<ImageBlocks blocks={tool.resultImages} />
								{/if}
							</div>
						</div>
					{:else if tool.resultOmitted}
						<div class="grid grid-cols-[1.75rem_minmax(0,1fr)] items-start gap-2">
							<div class="pt-[3px] font-mono text-[10px] uppercase leading-none tracking-wide text-text-placeholder select-none">{m.tool_out({}, { locale })}</div>
							<div class="text-[12px] leading-snug text-text-placeholder">{m.tool_result_omitted({}, { locale })}</div>
						</div>
					{:else if isRunning}
						<div class="grid grid-cols-[1.75rem_minmax(0,1fr)] items-start gap-2">
							<div class="pt-[3px] font-mono text-[10px] uppercase leading-none tracking-wide text-text-placeholder select-none">{m.tool_out({}, { locale })}</div>
							<div class="text-[12px] leading-snug text-text-placeholder">{runningPhase === 'drafting' ? m.tool_receiving_call({}, { locale }) : m.tool_running_verb({ verb: runningVerb }, { locale })}</div>
						</div>
					{/if}
					{#if sentSessions.length > 0}
						<div class="grid grid-cols-[1.75rem_minmax(0,1fr)] items-start gap-2 max-sm:grid-cols-[1.25rem_minmax(0,1fr)] max-sm:gap-1.5">
							<div class="pt-[3px] font-mono text-[10px] uppercase leading-none tracking-wide text-text-placeholder select-none">{m.tool_to({}, { locale })}</div>
							<div class="flex min-w-0 flex-col items-start gap-0.5">
								{#each sentSessions as session (`${session.spaceId}:${session.sessionId}`)}
									<RelatedSessionLink ref={session} class="flex min-h-[18px] max-w-full min-w-0 items-center gap-1.5 text-[12px] leading-snug text-text-secondary underline-offset-2 transition-colors [&[href]]:hover:text-text-primary [&[href]]:hover:underline [&[href]]:hover:decoration-brand/35">
										{#snippet children({ label, status })}
											{#if status === "loading"}
												<span class="h-2.5 w-28 rounded-[3px] bg-bg-surface" aria-hidden="true"></span>
											{:else}
												<span class="min-w-0 truncate {status === 'unavailable' ? 'text-text-placeholder' : ''}">{label}</span>
											{/if}
											{#if session.count > 1}
												<span class="shrink-0 tabular-nums text-text-placeholder">×{session.count}</span>
											{/if}
										{/snippet}
									</RelatedSessionLink>
								{/each}
							</div>
						</div>
					{/if}
				</div>
			{/if}
		</div>
	{/if}
</div>

<style>
	.tool-call-running {
		isolation: isolate;
	}

	.tool-call-dot {
		animation: cohub-tool-dot-breathe 1.55s cubic-bezier(0.22, 1, 0.36, 1) infinite;
	}

	@keyframes cohub-tool-dot-breathe {
		0%, 100% { opacity: 0.72; transform: scale(0.92); }
		45% { opacity: 1; transform: scale(1.08); }
	}

	@media (prefers-reduced-motion: reduce) {
		.tool-call-dot {
			animation: none;
		}
	}
</style>
