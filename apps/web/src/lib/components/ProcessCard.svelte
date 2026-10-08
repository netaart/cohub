<script lang="ts">
import type {
	MessageToolCallsFile,
	SessionTurnIntermediateSummary,
	SessionTurnRecord,
	StoredIntermediateMessage,
} from "@cohub/protocol/model";
import { ChevronDown, ChevronRight, Loader2, RotateCw } from "lucide-svelte";
import IntermediateMessageBubble from "$lib/components/IntermediateMessageBubble.svelte";
import SentTurnsChip from "$lib/components/SentTurnsChip.svelte";
import SentTurnsList from "$lib/components/SentTurnsList.svelte";
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
	getUsageTotalTokens,
	sumUsages,
} from "$lib/format-usage";
import { getLocale } from "$lib/i18n/locale.svelte";
import type { ModelCatalogItem } from "$lib/model-catalog";
import { m } from "$lib/paraglide/messages.js";
import { NO_SENT_SESSIONS } from "$lib/sent-turns";
import { useSessionRelations } from "$lib/session-relations-context";
import type { OpenWorkspaceFileTarget } from "$lib/workspace-file-links";

type IntermediateLoadState =
	| { status: "idle" }
	| { status: "loading" }
	| { status: "syncing" }
	| { status: "ready"; messages: StoredIntermediateMessage[] }
	| { status: "error"; message: string };

type Props = {
	turn: SessionTurnRecord;
	summary?: SessionTurnIntermediateSummary;
	intermediateMessages?: StoredIntermediateMessage[] | null;
	streaming?: boolean;
	modelsCatalog?: ModelCatalogItem[];
	onLoadIntermediate?: (
		turn: SessionTurnRecord,
	) => Promise<StoredIntermediateMessage[]>;
	onRequestIntermediateSync?: (
		turn: SessionTurnRecord,
	) => Promise<boolean | undefined>;
	onLoadToolCalls?: (input: {
		turn: SessionTurnRecord;
		message: StoredIntermediateMessage;
	}) => Promise<MessageToolCallsFile | null>;
	onOpenFile?: (target: OpenWorkspaceFileTarget) => void;
	onOpenUrl?: (href: string, event: MouseEvent) => void | Promise<void>;
};

const {
	turn,
	summary,
	intermediateMessages: liveIntermediateMessages = null,
	streaming = false,
	modelsCatalog,
	onLoadIntermediate,
	onRequestIntermediateSync,
	onLoadToolCalls,
	onOpenFile,
	onOpenUrl,
}: Props = $props();

const locale = $derived(getLocale());

let expanded = $state(false);
let loadState = $state<IntermediateLoadState>({ status: "idle" });

const persistedMessagesAvailable = $derived(
	Boolean(turn.intermediateIndex?.messagesObjectKey),
);
const liveMessages = $derived(liveIntermediateMessages ?? []);
const readyMessages = $derived(
	loadState.status === "ready" ? loadState.messages : null,
);
const effectiveMessages = $derived(
	streaming
		? liveMessages.length > 0
			? liveMessages
			: (readyMessages ?? [])
		: (readyMessages ?? []),
);
const expandedMessages = $derived(effectiveMessages);
const hasLiveMessages = $derived(liveMessages.length > 0);
const hasPersistedMessages = $derived(
	summary?.messageCount != null && summary.messageCount > 0,
);
const shouldShowSyncingState = $derived(
	streaming &&
		!hasLiveMessages &&
		hasPersistedMessages &&
		!persistedMessagesAvailable,
);
const syncUnavailableMessage = $derived(
	m.process_syncing_unavailable({}, { locale }),
);
const isLoading = $derived(loadState.status === "loading");
const isSyncing = $derived(loadState.status === "syncing");
const loadError = $derived(
	loadState.status === "error" ? loadState.message : null,
);

async function requestIntermediateSync(force = false) {
	if (!onRequestIntermediateSync) return false;
	if (!force && loadState.status === "syncing") return true;
	loadState = { status: "syncing" };
	try {
		const restored = await onRequestIntermediateSync(turn);
		if (liveMessages.length > 0) {
			loadState = { status: "ready", messages: liveMessages };
			return true;
		}
		if (restored === false) {
			loadState = {
				status: "error",
				message: syncUnavailableMessage,
			};
			return false;
		}
		loadState = { status: "syncing" };
		return true;
	} catch (error) {
		loadState = {
			status: "error",
			message:
				error instanceof Error
					? error.message
					: m.process_sync_failed({}, { locale }),
		};
		return false;
	}
}

async function ensureLoaded() {
	if (streaming && liveMessages.length > 0) {
		loadState = { status: "ready", messages: liveMessages };
		return;
	}
	if (loadState.status === "loading") return;
	if (loadState.status === "ready") return;
	if (shouldShowSyncingState) {
		await requestIntermediateSync();
		return;
	}
	if (!onLoadIntermediate) return;
	loadState = { status: "loading" };
	try {
		const messages = await onLoadIntermediate(turn);
		if (messages.length === 0 && streaming && shouldShowSyncingState) {
			loadState = { status: "syncing" };
			await requestIntermediateSync(true);
			return;
		}
		loadState = { status: "ready", messages };
	} catch (error) {
		loadState = {
			status: "error",
			message:
				error instanceof Error
					? error.message
					: m.process_load_failed({}, { locale }),
		};
	}
}

$effect(() => {
	if (streaming && liveMessages.length > 0) {
		loadState = { status: "ready", messages: liveMessages };
		return;
	}
	if (loadState.status === "ready" && !streaming) return;
	if (shouldShowSyncingState && loadState.status === "idle") {
		loadState = { status: "syncing" };
	}
});

async function toggle() {
	if (!expanded) await ensureLoaded();
	expanded = !expanded;
}

const toolCallCount = $derived(summary?.toolCallCount ?? 0);
const useLiveMetrics = $derived(streaming && effectiveMessages.length > 0);
const messageCount = $derived(
	useLiveMetrics
		? effectiveMessages.length
		: Math.max(summary?.messageCount ?? 0, effectiveMessages.length),
);
const liveCompactionMessages = $derived(
	effectiveMessages.filter(
		(message) => message.meta?.messageKind === "compacted",
	),
);
const compactionCount = $derived(
	useLiveMetrics
		? liveCompactionMessages.length
		: Math.max(summary?.compaction?.count ?? 0, liveCompactionMessages.length),
);
const stepCount = $derived(Math.max(0, messageCount - compactionCount));
const compactionUsage = $derived.by(() => {
	if (useLiveMetrics)
		return liveCompactionMessages.length > 0
			? sumUsages(liveCompactionMessages.map((message) => message.usage))
			: null;
	if (summary?.compaction?.usage) return summary.compaction.usage;
	if (liveCompactionMessages.length === 0) return null;
	return sumUsages(liveCompactionMessages.map((message) => message.usage));
});
const compactionDurationMs = $derived.by(() => {
	if (!useLiveMetrics && summary?.compaction?.durationMsTotal != null)
		return summary.compaction.durationMsTotal;
	const durations = liveCompactionMessages
		.map((message) => message.durationMs)
		.filter((duration): duration is number => typeof duration === "number");
	return durations.length > 0
		? durations.reduce((total, duration) => total + duration, 0)
		: null;
});
const compactionDetailLabel = $derived.by(() => {
	if (compactionCount === 0) return "";
	const tokens = getUsageTotalTokens(compactionUsage);
	const cost = getUsageCostTotal(compactionUsage);
	const parts = [
		tokens > 0
			? m.chat_tokens({ count: formatTokenCount(tokens) }, { locale })
			: "",
		cost != null ? formatUsageCost(cost, locale) : "",
		isDisplayableDurationMs(compactionDurationMs)
			? formatDurationDetail(
					compactionDurationMs ?? 0,
					m.chat_duration({}, { locale }),
					locale,
				)
			: "",
	].filter(Boolean);
	return parts.length > 0
		? m.process_compaction_label({ details: parts.join(" · ") }, { locale })
		: "";
});
// Intermediate-only usage. While streaming, live messages are authoritative;
// persisted summaries may lag behind the current turn.
const intermediateUsage = $derived.by(() => {
	if (useLiveMetrics)
		return sumUsages(effectiveMessages.map((message) => message.usage));
	if (summary?.usage) return summary.usage;
	if (effectiveMessages.length === 0) return null;
	return sumUsages(effectiveMessages.map((message) => message.usage));
});
const usageInputTokens = $derived(getDisplayInputTokens(intermediateUsage));
const usageCachedTokens = $derived(intermediateUsage?.cacheRead ?? 0);
const usageOutputTokens = $derived(intermediateUsage?.output ?? 0);
const usageTokens = $derived(getUsageTotalTokens(intermediateUsage));
const usageCostTotal = $derived(getUsageCostTotal(intermediateUsage));
const usageCostLabel = $derived(
	usageCostTotal == null ? "" : formatUsageCost(usageCostTotal, locale),
);
const usageBreakdownLabel = $derived.by(() => {
	if (usageInputTokens <= 0 && usageOutputTokens <= 0) return "";
	const inputLabel =
		usageInputTokens > 0 ? `↑${formatTokenCount(usageInputTokens)}` : "";
	const cachedLabel =
		usageCachedTokens > 0
			? `(${m.chat_cached({ count: formatTokenCount(usageCachedTokens) }, { locale })})`
			: "";
	const outputLabel =
		usageOutputTokens > 0 ? `↓${formatTokenCount(usageOutputTokens)}` : "";
	return [inputLabel, cachedLabel, outputLabel].filter(Boolean).join(" ");
});
const intermediateDurationMs = $derived.by(() => {
	if (!useLiveMetrics) return summary?.durationMs ?? null;
	const durations = effectiveMessages
		.map((message) => message.durationMs)
		.filter((duration): duration is number => typeof duration === "number");
	return durations.length > 0
		? durations.reduce((total, duration) => total + duration, 0)
		: null;
});
const durationLabel = $derived(
	isDisplayableDurationMs(intermediateDurationMs)
		? formatDurationMs(intermediateDurationMs ?? 0, locale)
		: "",
);
const durationTitle = $derived(
	isDisplayableDurationMs(intermediateDurationMs)
		? formatDurationDetail(
				intermediateDurationMs ?? 0,
				m.chat_duration({}, { locale }),
				locale,
			)
		: "",
);
const usageTitle = $derived.by(() => {
	if (!intermediateUsage && !durationTitle && !compactionDetailLabel) return "";
	const parts: string[] = [];
	if (usageInputTokens > 0) {
		parts.push(
			usageCachedTokens > 0
				? m.chat_input_label(
						{
							value: `${formatTokenCount(usageInputTokens)} (${formatTokenCount(usageCachedTokens)} cached)`,
						},
						{ locale },
					)
				: m.chat_input_label(
						{ value: formatTokenCount(usageInputTokens) },
						{ locale },
					),
		);
	}
	if (usageOutputTokens > 0)
		parts.push(
			m.chat_output_label(
				{ value: formatTokenCount(usageOutputTokens) },
				{ locale },
			),
		);
	if (intermediateUsage?.cacheWrite)
		parts.push(
			m.chat_cache_write_label(
				{ value: formatTokenCount(intermediateUsage.cacheWrite) },
				{ locale },
			),
		);
	if (usageTokens > 0)
		parts.push(
			m.chat_total_label({ value: formatTokenCount(usageTokens) }, { locale }),
		);
	if (usageCostLabel)
		parts.push(m.chat_cost_label({ value: usageCostLabel }, { locale }));
	if (durationTitle) parts.push(durationTitle);
	if (compactionDetailLabel) parts.push(compactionDetailLabel);
	return parts.join(" · ");
});
const labelParts = $derived(
	[
		stepCount > 0
			? stepCount > 1
				? m.process_steps_many({ count: stepCount }, { locale })
				: m.process_steps_one({ count: stepCount }, { locale })
			: streaming
				? m.process_running({}, { locale })
				: "",
		toolCallCount > 0
			? toolCallCount > 1
				? m.process_tools_many({ count: toolCallCount }, { locale })
				: m.process_tools_one({ count: toolCallCount }, { locale })
			: "",
		compactionCount > 0
			? compactionCount > 1
				? m.process_compactions_many({ count: compactionCount }, { locale })
				: m.process_compactions_one({ count: compactionCount }, { locale })
			: "",
		usageBreakdownLabel ||
			(usageTokens > 0
				? m.chat_tokens({ count: formatTokenCount(usageTokens) }, { locale })
				: ""),
		usageCostLabel,
		durationLabel,
	].filter(Boolean),
);
const summaryLabel = $derived(
	labelParts.join(" · ") ||
		(streaming
			? m.process_running({}, { locale })
			: m.process_title({}, { locale })),
);

const relations = useSessionRelations();
const sentSessions = $derived(
	relations?.sentByTurn(turn.id) ?? NO_SENT_SESSIONS,
);
</script>

{#if !expanded}
	<button type="button" class="flex w-full items-center gap-2 px-[var(--chat-msg-inset)] py-2 text-left transition-colors hover:bg-bg-hover/50 cursor-pointer rounded-md disabled:cursor-wait disabled:opacity-75" disabled={isLoading} onclick={() => void toggle()} title={usageTitle || undefined}>
		{#if isLoading}<Loader2 class="w-3.5 h-3.5 text-text-tertiary shrink-0 animate-spin" />{:else}<ChevronRight class="w-3.5 h-3.5 text-text-tertiary shrink-0" />{/if}
		<span class="text-[13px] text-text-tertiary tabular-nums">{summaryLabel}</span>
		{#if sentSessions.length > 0}
			<SentTurnsChip count={sentSessions.length} />
		{/if}
	</button>
{:else}
	<div class="flex flex-col gap-0">
		<button type="button" class="flex w-full items-center gap-2 px-[var(--chat-msg-inset)] py-2 text-left transition-colors hover:bg-bg-hover/50 cursor-pointer rounded-md" onclick={() => void toggle()} title={usageTitle || undefined}>
			<ChevronDown class="w-3.5 h-3.5 text-text-tertiary shrink-0" />
			<span class="text-[13px] text-text-tertiary tabular-nums">{summaryLabel}</span>
			{#if sentSessions.length > 0}
				<SentTurnsChip count={sentSessions.length} />
			{/if}
		</button>
		<SentTurnsList sessions={sentSessions} />
		<div class="flex flex-col gap-2">
			{#if loadError}
				<button type="button" class="mx-[var(--chat-msg-inset)] rounded-md border border-status-error/30 bg-status-error/5 px-3 py-2 text-left text-[12px] text-status-error hover:bg-status-error/10" onclick={() => void ensureLoaded()}>
					{loadError} · {m.process_click_retry({}, { locale })}
				</button>
			{:else if isSyncing && expandedMessages.length === 0}
				<button type="button" class="mx-[var(--chat-msg-inset)] flex items-center gap-2 rounded-md border border-border-subtle/80 bg-bg-surface px-3 py-2 text-left text-[12px] text-text-tertiary hover:bg-bg-hover/60" onclick={() => void requestIntermediateSync(true)}>
					<RotateCw class="h-3.5 w-3.5 shrink-0" />
					<span>{m.process_syncing_steps({}, { locale })}</span>
				</button>
			{/if}
			{#each expandedMessages as msg (msg.id)}
				<IntermediateMessageBubble message={msg} streaming={streaming} {modelsCatalog} onLoadToolCalls={onLoadToolCalls ? () => onLoadToolCalls({ turn, message: msg }) : undefined} {onOpenFile} {onOpenUrl} />
			{/each}
		</div>
		<button type="button" class="flex items-center gap-1.5 px-[var(--chat-msg-inset)] py-1.5 text-left transition-colors hover:bg-bg-hover/50 cursor-pointer text-text-placeholder hover:text-text-tertiary rounded-md self-start" onclick={() => void toggle()}>
			<ChevronRight class="w-3 h-3" />
			<span class="text-[11px]">{m.common_collapse({}, { locale })}</span>
		</button>
	</div>
{/if}
