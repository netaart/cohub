<script lang="ts">
import type { ContentBlock } from "@cohub/protocol/core";
import {
	collectToolMetrics,
	readTurnMetrics,
	readTurnStats,
	requestMetricSchema,
} from "@cohub/protocol/model";
import { resolveHarness } from "@neta-art/cohub";
import {
	Archive,
	Check,
	CloudUpload,
	Copy,
	GitFork,
	Loader2,
	TriangleAlert,
} from "lucide-svelte";
import MessageContentFlow from "$lib/components/MessageContentFlow.svelte";
import StatsContent from "$lib/components/StatsContent.svelte";
import StatsPopover from "$lib/components/StatsPopover.svelte";
import UserIdentity from "$lib/components/UserIdentity.svelte";
import {
	formatDurationDetail,
	formatDurationMs,
	isDisplayableDurationMs,
} from "$lib/format-duration";
import {
	formatTokenCount,
	formatUsageCost,
	getDisplayInputTokens,
	getUsageCostTotal,
} from "$lib/format-usage";
import { getGenerationCostPresentation } from "$lib/generation-cost";
import { getLocale } from "$lib/i18n/locale.svelte";
import {
	findModelCatalogItem,
	formatThinkingLevelShort,
	getModelDisplayName,
	getRequestedThinkingLevel,
	type ModelCatalogItem,
} from "$lib/model-catalog";
import { m } from "$lib/paraglide/messages.js";
import type { ChatMessage } from "$lib/session-tree";
import {
	formatCompactAbsoluteTime,
	formatFullAbsoluteTime,
} from "$lib/time-format";
import type { OpenWorkspaceFileTarget } from "$lib/workspace-file-links";

type Props = {
	message: ChatMessage;
	modelsCatalog?: ModelCatalogItem[];
	onMarkdownRenderStart?: (message: ChatMessage) => void;
	onMarkdownRendered?: (message: ChatMessage) => void;
	showToolCalls?: boolean;
	onOpenFile?: (target: OpenWorkspaceFileTarget) => void;
	onOpenUrl?: (href: string, event: MouseEvent) => void | Promise<void>;
	onForkTurn?: () => void;
	forkDisabled?: boolean;
	forking?: boolean;
};

const {
	message,
	modelsCatalog,
	onMarkdownRenderStart,
	onMarkdownRendered,
	showToolCalls = true,
	onOpenFile,
	onOpenUrl,
	onForkTurn,
	forkDisabled = false,
	forking = false,
}: Props = $props();

const locale = $derived(getLocale());
let pendingMarkdownSegments = $state(0);
let markdownStartedForSignature = $state("");

// Thinking state: track user manual toggle to avoid overriding
let thinkingExpanded = $state(false);
let thinkingUserToggled = $state(false);
// Auto-expand during streaming, auto-collapse after (unless user toggled)
const isStreaming = $derived(
	message.meta?.messageKind === "assistant_streaming_preview" ||
		message.meta?.streaming === true ||
		message.id.startsWith("assistant-streaming:") ||
		message.id === "assistant-streaming" ||
		message.id === "assistant-thinking",
);

$effect(() => {
	if (isStreaming && !thinkingUserToggled) {
		thinkingExpanded = true;
	} else if (!isStreaming && !thinkingUserToggled) {
		thinkingExpanded = false;
	}
});

const textSignature = $derived(
	(message.content ?? [])
		.filter((block) => block.type === "text")
		.map((block) => (block.type === "text" ? block.text : ""))
		.join("\n\n"),
);

function handleMarkdownSegmentRendered() {
	pendingMarkdownSegments = Math.max(0, pendingMarkdownSegments - 1);
	if (pendingMarkdownSegments === 0) onMarkdownRendered?.(message);
}

function handleMarkdownSegmentStart() {
	if (markdownStartedForSignature !== textSignature) {
		markdownStartedForSignature = textSignature;
		pendingMarkdownSegments = 0;
		onMarkdownRenderStart?.(message);
	}
	pendingMarkdownSegments += 1;
}

const assistantAbortMessage = $derived(
	message.role === "assistant" && message.meta?.stopReason === "aborted"
		? m.chat_user_stopped_generation({}, { locale })
		: "",
);

const assistantErrorMessage = $derived(
	message.role === "assistant" &&
		!assistantAbortMessage &&
		(message.meta?.messageKind === "assistant_error" ||
			message.meta?.stopReason === "error")
		? (message.meta?.errorMessage ?? m.chat_unknown_error({}, { locale }))
		: "",
);

const isCancelledBeforeDispatch = $derived(
	message.role === "user" &&
		message.meta?.turn?.status === "cancelled" &&
		message.meta?.turn?.meta?.cancelledBeforeDispatch === true,
);

const cancelledByDisplay = $derived.by(() => {
	const userId = message.meta?.turn?.meta?.cancelledByUserId;
	if (typeof userId !== "string" || !userId.trim()) return "";
	if (message.authorProfile?.userUuid === userId)
		return message.authorProfile.displayName;
	return userId.replaceAll("-", "").slice(0, 8);
});

const isUserMessage = $derived(message.role === "user");

function asRecord(value: unknown): Record<string, unknown> | null {
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

const turnMeta = $derived(asRecord(message.meta?.turn?.meta));
const turnContext = $derived(asRecord(turnMeta?.context));
const turnClientMessageId = $derived.by(() => {
	const value = turnMeta?.clientMessageId;
	return typeof value === "string" && value.trim() ? value.trim() : "";
});

const isBackgroundTaskUserMessage = $derived(
	message.role === "user" &&
		(turnContext?.kind === "background_bash_task" ||
			turnClientMessageId.startsWith("background-bash-task:")),
);

const backgroundTaskRunId = $derived.by(() => {
	const value = turnContext?.taskRunId;
	return typeof value === "string" && value.trim() ? value.trim() : "";
});

const backgroundTaskDetail = $derived(
	backgroundTaskRunId
		? m.chat_bg_bash_task_id({ id: backgroundTaskRunId }, { locale })
		: m.chat_bg_bash_task({}, { locale }),
);

const messageContainerClass = $derived(
	message.role === "user"
		? "ml-auto w-fit max-w-[var(--chat-user-message-max-width)]"
		: "w-full",
);

const messageBubbleClass = $derived.by(() => {
	const base = "px-[var(--chat-msg-inset)] py-2 text-[14px] leading-[1.7]";
	if (message.role === "user") {
		if (isCancelledBeforeDispatch)
			return `${base} rounded-xl rounded-br-md bg-bg-hover/60 text-text-tertiary`;
		if (isBackgroundTaskUserMessage)
			return `${base} rounded-xl rounded-br-md border border-border-subtle/70 bg-bg-hover/45 text-text-secondary`;
		return `${base} rounded-[var(--chat-user-message-radius)] rounded-br-[var(--chat-user-message-tail-radius)] bg-[var(--chat-user-message-bg)] text-[var(--chat-user-message-fg)]`;
	}
	if (message.role === "assistant") {
		return assistantErrorMessage
			? `${base} rounded-xl bg-status-error/5 text-text-primary`
			: `${base} bg-[var(--chat-assistant-message-bg)] text-[var(--chat-assistant-message-fg)]`;
	}
	if (message.role === "system") return `${base} bg-info-bg text-info-soft`;
	return `${base} bg-error-bg text-error-soft`;
});

const defaultExpandToolCalls = $derived(
	message.role === "assistant" &&
		message.meta?.messageKind === "assistant_final" &&
		message.meta?.streaming !== true &&
		(message.content ?? []).some((block) => block.type === "tool_use"),
);

const hasForkCheckpoint = $derived(
	Boolean(
		message.meta?.turn &&
			(typeof message.meta.turn.meta?.agentSessionEntryId === "string" ||
				(message.meta.turn.meta?.agent &&
					typeof message.meta.turn.meta.agent === "object" &&
					!Array.isArray(message.meta.turn.meta.agent) &&
					typeof (message.meta.turn.meta.agent as Record<string, unknown>)
						.leafEntryId === "string")),
	),
);

const isTerminalDirectGeneration = $derived(
	message.meta?.turn?.executionKind === "direct_generation" &&
		["completed", "failed", "interrupted", "cancelled"].includes(
			message.meta.turn.status,
		),
);

const canFork = $derived(
	Boolean(
		onForkTurn &&
			(hasForkCheckpoint || isTerminalDirectGeneration) &&
			message.role === "assistant" &&
			message.meta?.messageKind &&
			["assistant_final", "assistant_error", "assistant_interrupted"].includes(
				message.meta.messageKind,
			) &&
			message.meta?.streaming !== true,
	),
);

function fallbackUserName(uuid?: string | null): string {
	if (!uuid) return m.common_user({}, { locale });
	const compact = uuid.replaceAll("-", "");
	return compact.slice(0, 8) || m.common_user({}, { locale });
}

const userDisplayName = $derived(
	message.authorProfile?.displayName?.trim() ||
		fallbackUserName(message.authorUuid),
);

function toggleThinking() {
	thinkingExpanded = !thinkingExpanded;
	thinkingUserToggled = true;
}

// ─── Meta bar: time, model, tokens, copy ───

const timeDisplay = $derived(formatCompactAbsoluteTime(message.createdAt));
const fullDateTime = $derived(
	formatFullAbsoluteTime(message.createdAt, { seconds: true }),
);

// Model display: default show model name (matched from catalog), fallback to model id
const modelMatch = $derived(
	findModelCatalogItem(modelsCatalog, {
		provider: message.meta?.provider,
		model: message.meta?.model,
	}),
);

const modelName = $derived(
	getModelDisplayName(modelsCatalog, {
		provider: message.meta?.provider,
		model: message.meta?.model,
	}),
);

const modelDisplayName = $derived(message.meta?.model ? modelName : "");

const modelHoverText = $derived(
	message.meta?.provider && message.meta?.model
		? `${message.meta.provider}/${modelName}`
		: "",
);

const requestedThinkingLevel = $derived(getRequestedThinkingLevel(turnMeta));

const requestedThinkingLevelShort = $derived(
	requestedThinkingLevel
		? formatThinkingLevelShort(requestedThinkingLevel)
		: "",
);

// Local Harness runs (Pi / Codex) mark the execution origin; cloud turns stay unlabelled.
const harness = $derived(resolveHarness(turnMeta));
const harnessLabel = $derived(
	harness === "pi" ? "Pi" : harness === "codex" ? "Codex" : "",
);
const harnessTitle = $derived(
	`${harnessLabel} · ${m.runtime_local({}, { locale })}`,
);
const archiveStatus = $derived(
	harnessLabel &&
		!isStreaming &&
		(message.meta?.messageKind === "assistant_final" ||
			message.meta?.messageKind === "assistant_error")
		? message.meta?.turn?.harnessIndex
			? "ready"
			: turnMeta?.runtimeArchiveStatus
		: null,
);
const archiveLabel = $derived(
	archiveStatus === "ready"
		? m.runtime_archive_ready({}, { locale })
		: archiveStatus === "pending"
			? m.runtime_archive_pending({}, { locale })
			: archiveStatus === "failed"
				? m.runtime_archive_failed({}, { locale })
				: "",
);

const footerStats = $derived.by(() => {
	if (message.meta?.turn) return readTurnStats(message.meta.turn);
	const receipt = requestMetricSchema.safeParse(message.meta?.llmTiming);
	const stats = readTurnStats({
		status: "completed",
		totalUsage: message.meta?.usage,
		durationMs: message.meta?.durationMs,
		meta: {
			metrics: {
				version: 1,
				tools: collectToolMetrics([message.content]),
				...(receipt.success
					? {
							requests: {
								[receipt.data.id]: { ...receipt.data, omitted: false },
							},
						}
					: {}),
			},
		},
	});
	return { ...stats, turns: 0 };
});
const footerRequests = $derived.by(() => {
	if (message.meta?.turn) {
		const metrics = readTurnMetrics(message.meta.turn.meta);
		return metrics ? Object.values(metrics.requests ?? {}) : [];
	}
	const receipt = requestMetricSchema.safeParse(message.meta?.llmTiming);
	return receipt.success ? [receipt.data] : [];
});
const footerUsage = $derived(
	message.meta?.turn
		? (footerStats.usage ?? message.meta.turn.totalUsage)
		: message.meta?.usage,
);
const footerDuration = $derived(
	message.meta?.turn
		? (footerStats.elapsedMs ?? message.meta.turn.durationMs)
		: message.meta?.durationMs,
);
const hasDuration = $derived.by(() => {
	const durationMs = footerDuration;
	return (
		message.role === "assistant" &&
		message.meta?.streaming !== true &&
		message.meta?.messageKind !== "assistant_streaming_preview" &&
		isDisplayableDurationMs(durationMs)
	);
});

const durationDisplay = $derived(
	hasDuration ? formatDurationMs(footerDuration ?? 0, locale) : "",
);

const durationDetailText = $derived.by(() => {
	const durationMs = footerDuration;
	if (!hasDuration || typeof durationMs !== "number") return "";
	return formatDurationDetail(
		durationMs,
		m.chat_duration({}, { locale }),
		locale,
	);
});

const hasUsage = $derived.by(() => {
	const u = footerUsage;
	if (!u) return false;
	return Boolean(
		u.input ||
			u.output ||
			u.cacheRead ||
			u.cacheWrite ||
			u.totalTokens ||
			u.cost?.input ||
			u.cost?.output ||
			u.cost?.cacheRead ||
			u.cost?.cacheWrite ||
			u.cost?.total,
	);
});

const isDirectGeneration = $derived(
	message.meta?.turn?.executionKind === "direct_generation",
);

const visibleCost = $derived(
	isDirectGeneration
		? getGenerationCostPresentation(
				{
					usage: message.meta?.usage,
					generation: turnMeta?.generation,
				},
				locale,
			)
		: null,
);

const displayInputTokens = $derived.by(() =>
	getDisplayInputTokens(footerUsage),
);

const cachedInputTokens = $derived.by(() => footerUsage?.cacheRead ?? 0);

const tokenDisplay = $derived.by(() => {
	const u = footerUsage;
	if (!u) return "";
	// Cost stays in hover detail only; outer bar keeps the existing token-first layout.
	const parts: string[] = [];
	if (displayInputTokens > 0) {
		const inputLabel = `↑${formatTokenCount(displayInputTokens)}`;
		parts.push(inputLabel);
	}
	if (u.output) parts.push(`↓${formatTokenCount(u.output)}`);
	if (parts.length > 0) return parts.join(" ");
	if (u.totalTokens)
		return m.chat_tokens(
			{ count: formatTokenCount(u.totalTokens) },
			{ locale },
		);
	if (u.cacheRead)
		return m.chat_cache({ count: formatTokenCount(u.cacheRead) }, { locale });
	if (u.cacheWrite)
		return m.chat_cache_write(
			{ count: formatTokenCount(u.cacheWrite) },
			{ locale },
		);
	if (!isDirectGeneration) {
		const costTotal = getUsageCostTotal(u);
		if (costTotal != null) return formatUsageCost(costTotal, locale);
	}
	return "";
});

const tokenDetailText = $derived.by(() => {
	const u = footerUsage;
	if (!u) return "";
	const parts: string[] = [];
	if (displayInputTokens > 0) {
		parts.push(
			cachedInputTokens > 0
				? m.chat_input_label(
						{
							value: `${formatTokenCount(displayInputTokens)} (${formatTokenCount(cachedInputTokens)} cached)`,
						},
						{ locale },
					)
				: m.chat_input_label(
						{ value: formatTokenCount(displayInputTokens) },
						{ locale },
					),
		);
	}
	if (u.output)
		parts.push(
			m.chat_output_label({ value: formatTokenCount(u.output) }, { locale }),
		);
	if (u.cacheWrite)
		parts.push(
			m.chat_cache_write_label(
				{ value: formatTokenCount(u.cacheWrite) },
				{ locale },
			),
		);
	if (u.totalTokens)
		parts.push(
			m.chat_total_label(
				{ value: formatTokenCount(u.totalTokens) },
				{ locale },
			),
		);
	const costTotal = getUsageCostTotal(u);
	if (costTotal != null)
		parts.push(
			m.chat_cost_label(
				{ value: formatUsageCost(costTotal, locale) },
				{ locale },
			),
		);
	return parts.join("  ·  ");
});

const modelContextWindow = $derived.by(() => {
	const contextWindow =
		(message.meta?.contextWindow as number | null | undefined) ??
		modelMatch?.model?.contextWindow;
	return typeof contextWindow === "number" && contextWindow > 0
		? contextWindow
		: null;
});

const inputContextPercent = $derived.by(() => {
	// A Turn footer shows cumulative usage, not the latest context window size.
	if (message.meta?.turn) return null;
	const latestInputTokens = getDisplayInputTokens(message.meta?.usage);
	if (!latestInputTokens || !modelContextWindow) return null;
	return Math.max(
		0,
		Math.min(100, (latestInputTokens / modelContextWindow) * 100),
	);
});

function getTokenDisplayClass(percent: number | null) {
	const base = "tabular-nums shrink-0 cursor-default transition-colors";
	if (percent === null || percent < 60)
		return `${base} text-text-placeholder/65`;
	if (percent < 85) return `${base} text-warning-soft/85`;
	return `${base} text-error-soft/90`;
}

// Copy
let copied = $state(false);
let copyTimer: ReturnType<typeof setTimeout> | null = null;

function handleCopy() {
	const text =
		message.content
			?.flatMap((block) => {
				if (block.type === "text") return [block.text];
				if (block.type === "shell_command") return [block.rawText];
				return [];
			})
			.join("\n\n")
			.trim() || message.text;

	navigator.clipboard.writeText(text).then(() => {
		copied = true;
		if (copyTimer) clearTimeout(copyTimer);
		copyTimer = setTimeout(() => {
			copied = false;
		}, 1800);
	});
}
</script>

{#if message.role === 'system' && message.content?.some(b => b.type === 'thinking')}
  <MessageContentFlow
    content={message.content ?? []}
    {thinkingExpanded}
    {isStreaming}
    showToolCalls={false}
    onToggleThinking={toggleThinking}
    {onOpenFile}
    {onOpenUrl}
  />
{:else}
  <div class={`min-w-0 ${messageContainerClass}`}>
    <div class={messageBubbleClass}>
      <MessageContentFlow
        content={message.content?.length ? message.content : [{ type: 'text', text: message.text }]}
        {isUserMessage}
        {thinkingExpanded}
        {isStreaming}
        {showToolCalls}
        defaultExpandToolCalls={defaultExpandToolCalls}
        onToggleThinking={toggleThinking}
        onMarkdownSegmentRendered={handleMarkdownSegmentRendered}
        onMarkdownSegmentStart={handleMarkdownSegmentStart}
        onLoadToolCalls={message.toolCallsLoader ?? undefined}
        {onOpenFile}
        {onOpenUrl}
      />

      {#if assistantErrorMessage}
        <div class="mt-3 rounded-lg border border-status-error/30 bg-status-error/8 px-3 py-2 text-[12px] text-status-error whitespace-pre-wrap break-words">
          <div class="font-medium">{m.chat_error_header({}, { locale })}</div>
          <div class="mt-1">{assistantErrorMessage}</div>
        </div>
      {/if}
    </div>

    {#if (message.role === 'assistant' && (message.meta?.model || hasUsage || hasDuration || timeDisplay || harnessLabel)) || (message.role === 'user' && timeDisplay)}
      <!-- Meta bar: copy | identity/model | tokens | time -->
      <div class="mt-1 flex items-center gap-1 px-[var(--chat-msg-inset)] text-[11px] text-text-placeholder/50 select-none">
        <!-- Copy button -->
        <button
          type="button"
          class="shrink-0 inline-flex items-center p-1 rounded cursor-pointer opacity-60 hover:opacity-100 transition-opacity"
          onclick={(e) => { e.stopPropagation(); handleCopy(); }}
          title={m.chat_copy_message({}, { locale })}
        >
          {#if copied}
            <Check class="w-3.5 h-3.5 text-status-running" />
          {:else}
            <Copy class="w-3.5 h-3.5" />
          {/if}
        </button>

        {#if canFork}
          <button
            type="button"
            class="shrink-0 inline-flex items-center p-1 rounded cursor-pointer opacity-60 hover:opacity-100 transition-opacity disabled:cursor-default disabled:opacity-50"
            onclick={(e) => { e.stopPropagation(); if (!forkDisabled) onForkTurn?.(); }}
            title={m.chat_fork_here({}, { locale })}
            disabled={forkDisabled}
          >
            {#if forking}
              <Loader2 class="w-3.5 h-3.5 animate-spin" />
            {:else}
              <GitFork class="w-3.5 h-3.5" />
            {/if}
          </button>
        {/if}

        {#if message.role === 'user'}
          {#if isBackgroundTaskUserMessage}
            <span class="inline-flex min-w-0 items-center gap-1.5 cursor-default text-text-placeholder/70" title={backgroundTaskDetail}>
              <span class="h-1.5 w-1.5 shrink-0 rounded-full bg-text-placeholder/55"></span>
              <span class="min-w-0 truncate font-medium">{m.chat_bg_task_label({}, { locale })}</span>
            </span>
          {:else}
            <!-- User identity -->
            <UserIdentity
              name={userDisplayName}
              avatarUrl={message.authorProfile?.avatarUrl}
              username={message.authorProfile?.username}
              title={userDisplayName}
              size="xxs"
              class="text-inherit"
              avatarClass="border-0 bg-brand/15 text-brand"
            />
          {/if}
          {#if isCancelledBeforeDispatch}
            <span class="shrink-0 text-[11px] font-medium text-text-placeholder/65" title={cancelledByDisplay
							? m.chat_cancelled_by({ name: cancelledByDisplay }, { locale })
							: m.chat_not_sent_to_agent({}, { locale })}>{m.chat_cancelled({}, { locale })}</span>
          {/if}
        {:else}
          {#if harnessLabel}
            <span class="shrink-0 rounded-[3px] bg-bg-hover-strong px-1.5 py-px text-[10px] font-medium leading-none text-text-tertiary" title={harnessTitle}>{harnessLabel}</span>
          {/if}
          {#if archiveLabel}
            <span class="shrink-0 text-text-tertiary" title={archiveLabel} aria-label={archiveLabel} role="img">
              {#if archiveStatus === 'ready'}<Archive size={12} />
              {:else if archiveStatus === 'pending'}<CloudUpload size={12} />
              {:else}<TriangleAlert size={12} />{/if}
            </span>
          {/if}

          <!-- Model (truncates when space is tight) -->
          {#if modelDisplayName}
            <span class="min-w-0 truncate cursor-default" title={modelHoverText}>
              {modelDisplayName}
            </span>
          {/if}

          {#if requestedThinkingLevel}
            <span class="shrink-0 text-text-placeholder/65">
              {requestedThinkingLevelShort}
            </span>
          {/if}

          {#if !isStreaming && (hasUsage || hasDuration || message.meta?.turn)}
            <StatsPopover title={message.meta?.turn ? m.stats_turn({}, { locale }) : m.stats_call({}, { locale })} triggerClass="shrink-0">
              {#snippet trigger()}
                {#if hasUsage && tokenDisplay}<span class={getTokenDisplayClass(inputContextPercent)}>{tokenDisplay}</span>{/if}
                {#if hasDuration}<span class="shrink-0 whitespace-nowrap tabular-nums">{durationDisplay}</span>{/if}
                {#if !tokenDisplay && !hasDuration}<span>{m.stats_turn({}, { locale })}</span>{/if}
              {/snippet}
              <StatsContent stats={footerStats} scope="turn" requests={footerRequests} />
            </StatsPopover>
          {:else}
            {#if hasUsage && tokenDisplay}<span class={getTokenDisplayClass(inputContextPercent)} title={tokenDetailText}>{tokenDisplay}</span>{/if}
            {#if hasDuration}<span class="shrink-0 tabular-nums text-text-placeholder/65" title={durationDetailText}>{durationDisplay}</span>{/if}
          {/if}

          {#if visibleCost}
            <span class="shrink-0 tabular-nums cursor-default text-text-placeholder/65" title={visibleCost.detail}>
              {visibleCost.label}
            </span>
          {/if}

          {#if assistantAbortMessage}
            <span class="shrink-0 text-[11px] font-medium text-warning-soft/75" title={assistantAbortMessage}>{m.chat_user_stopped({}, { locale })}</span>
          {/if}
        {/if}

        <!-- Time (always visible on the right) -->
        {#if timeDisplay}
          <time datetime={message.createdAt} class="ml-auto shrink-0 tabular-nums cursor-default" title={fullDateTime}>
            {timeDisplay}
          </time>
        {/if}
      </div>
    {/if}
  </div>
{/if}
