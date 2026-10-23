import type { ContentBlock } from "@cohub/protocol/core";
import type {
	SessionTurnIntermediateSummary,
	SessionTurnRecord,
	StoredIntermediateMessage,
} from "@cohub/protocol/model";
import { hasSentTurns } from "./sent-turns";
import { createStreamingIntermediateMessage } from "./session-streaming-message";
import type {
	ChatMessage,
	TimelineItem,
	TurnFooterPhase,
} from "./session-tree";

function getTurnContextWindow(turn: SessionTurnRecord) {
	const raw = turn.meta?.contextWindow;
	return typeof raw === "number" && raw > 0 ? raw : null;
}

function getTurnClientMessageId(turn: Pick<SessionTurnRecord, "meta">) {
	const value = turn.meta?.clientMessageId;
	return typeof value === "string" && value.trim() ? value.trim() : null;
}

function getTurnRenderKey(turn: Pick<SessionTurnRecord, "id" | "meta">) {
	const clientMessageId = getTurnClientMessageId(turn);
	return clientMessageId ? `client:${clientMessageId}` : `turn:${turn.id}`;
}

function isOptimisticTurn(turn: Pick<SessionTurnRecord, "meta">) {
	return turn.meta?.optimistic === true;
}

function isTerminalTurn(turn: SessionTurnRecord) {
	return (
		turn.status === "completed" ||
		turn.status === "failed" ||
		turn.status === "interrupted" ||
		turn.status === "merged" ||
		turn.status === "cancelled"
	);
}

function parseTurnUpdatedAt(turn: SessionTurnRecord) {
	const value = Date.parse(turn.updatedAt);
	return Number.isFinite(value) ? value : 0;
}

function shouldPreferRenderableTurn(
	current: SessionTurnRecord,
	incoming: SessionTurnRecord,
) {
	if (isOptimisticTurn(current) && !isOptimisticTurn(incoming)) return true;
	if (!isOptimisticTurn(current) && isOptimisticTurn(incoming)) return false;
	if (!isTerminalTurn(current) && isTerminalTurn(incoming)) return true;
	if (isTerminalTurn(current) && !isTerminalTurn(incoming)) return false;
	return parseTurnUpdatedAt(incoming) >= parseTurnUpdatedAt(current);
}

function dedupeRenderableTurnsByClientMessageId(turns: SessionTurnRecord[]) {
	const byClientMessageId = new Map<string, SessionTurnRecord>();
	const withoutClientMessageId: SessionTurnRecord[] = [];
	for (const turn of turns) {
		const clientMessageId = getTurnClientMessageId(turn);
		if (!clientMessageId) {
			withoutClientMessageId.push(turn);
			continue;
		}
		const current = byClientMessageId.get(clientMessageId);
		if (!current || shouldPreferRenderableTurn(current, turn)) {
			byClientMessageId.set(clientMessageId, turn);
		}
	}
	return [...withoutClientMessageId, ...byClientMessageId.values()].sort(
		(a, b) => a.sequence - b.sequence || a.createdAt.localeCompare(b.createdAt),
	);
}

function getFinalMessageDurationMs(turn: SessionTurnRecord) {
	if (turn.executionKind === "direct_generation") return turn.durationMs;
	const raw = turn.meta?.finalMessageDurationMs;
	return typeof raw === "number" && raw > 0 ? raw : null;
}

export function turnToUserMessage(turn: SessionTurnRecord): ChatMessage {
	const meta = turn.meta ?? {};
	const renderKey = getTurnRenderKey(turn);
	return {
		id: `${renderKey}:user`,
		sourceId: turn.id,
		role: "user",
		content: turn.userContent,
		text: turn.userText ?? "",
		sequence: turn.sequence * 10,
		blocks: [...turn.userContent],
		authorUuid: (meta.userId as string | undefined) ?? turn.userUuid,
		authorProfile: turn.authorProfile ?? null,
		createdAt: turn.startedAt ?? turn.createdAt,
		meta: {
			messageKind: "turn_user",
			turnId: turn.id,
			turn,
		},
	};
}

export function turnToAssistantMessage(
	turn: SessionTurnRecord,
): ChatMessage | null {
	const isAborted = turn.stopReason === "aborted";
	if (
		!turn.assistantContent &&
		!turn.errorMessage &&
		!turn.assistantText &&
		!isAborted
	)
		return null;
	const content =
		turn.assistantContent ??
		(turn.assistantText
			? [{ type: "text", text: turn.assistantText } satisfies ContentBlock]
			: []);
	return {
		id: `${getTurnRenderKey(turn)}:assistant`,
		sourceId: turn.id,
		role: "assistant",
		content,
		text: isAborted
			? (turn.assistantText ?? "")
			: (turn.assistantText ?? turn.errorMessage ?? ""),
		sequence: turn.sequence * 10 + 2,
		blocks: [...content],
		createdAt: turn.completedAt ?? turn.updatedAt,
		meta: {
			messageKind:
				turn.status === "failed"
					? "assistant_error"
					: turn.status === "interrupted"
						? "assistant_interrupted"
						: "assistant_final",
			turnId: turn.id,
			turn,
			model: turn.model,
			provider: turn.provider,
			contextWindow: getTurnContextWindow(turn),
			usage: turn.finalUsage,
			durationMs: getFinalMessageDurationMs(turn),
			stopReason: turn.stopReason,
			errorMessage: isAborted ? null : turn.errorMessage,
		},
	};
}

export function buildStreamingPreviewBlocks(
	content: ContentBlock[],
	options?: { truncatedStart?: boolean },
) {
	if (content.length === 0) return [];

	let appliedTruncatedPrefix = false;
	return content.flatMap((block): ContentBlock[] => {
		if (block.type === "text") {
			const text = block.text;
			if (!text.trim()) return [];
			const nextText =
				options?.truncatedStart && !appliedTruncatedPrefix
					? `…${text.trimStart()}`
					: text;
			appliedTruncatedPrefix = true;
			return [{ ...block, text: nextText }];
		}
		if (block.type === "thinking") {
			const thinking = block.thinking;
			return thinking.trim() ? [{ ...block, thinking }] : [];
		}
		return [block];
	});
}

function isQueuedFollowupTurn(turn: SessionTurnRecord) {
	return turn.status === "queued" && turn.intent === "followup";
}

function countToolUses(messages: StoredIntermediateMessage[]) {
	return messages.reduce(
		(count, message) =>
			count +
			message.content.filter((block) => block.type === "tool_use").length,
		0,
	);
}

function hasLiveAssistantPreview(blocks: ContentBlock[]) {
	return blocks.some((block) => {
		if (block.type === "text") return block.text.trim().length > 0;
		if (block.type === "thinking") return block.thinking.trim().length > 0;
		return false;
	});
}

function resolveTurnFooterPhase(streaming: {
	status?: string;
	resumed?: boolean;
	contentBlocks: ContentBlock[];
	intermediateMessages?: StoredIntermediateMessage[];
	executionKind?: SessionTurnRecord["executionKind"];
	runtimePhase?: "llm_call_started" | null;
}): TurnFooterPhase | null {
	// Fresh thinking/text is the status itself.
	if (hasLiveAssistantPreview(streaming.contentBlocks)) return null;

	// Authoritative signal from the agent: next LLM call is in flight.
	// Allow residual tool-only blocks — those are previous-round leftovers,
	// not the next assistant answer.
	if (streaming.runtimePhase === "llm_call_started") return "waiting_model";

	// Only show starting while the active turn has nothing to render yet.
	if (
		streaming.status === "pending" &&
		!streaming.resumed &&
		(streaming.intermediateMessages?.length ?? 0) === 0
	) {
		return streaming.executionKind === "direct_generation"
			? "starting_generation"
			: "starting";
	}

	// Between tool rounds after intermediate archive: process history exists,
	// live preview is empty, generation still active. Show waiting even before
	// the next llm_call_started lifecycle event. Require empty contentBlocks so
	// actively streaming tools in the current round don't look like waiting.
	if (
		(streaming.status === "streaming" || streaming.status === "pending") &&
		streaming.contentBlocks.length === 0 &&
		(streaming.intermediateMessages?.length ?? 0) > 0
	) {
		return "waiting_model";
	}

	return null;
}

/**
 * Resolve the `createdAt` for the live streaming preview.
 *
 * The timeline is rebuilt on every stream chunk, so stamping the preview with
 * `new Date()` at render time makes its displayed time keep advancing with the
 * client clock even when the stream has stalled. Prefer the server-side emit
 * time of the latest chunk: it advances with the stream yet freezes between
 * chunks, reflecting when the agent last produced content. Fall back to the
 * generation start time, then render time as a last resort.
 */
function resolveStreamingPreviewCreatedAt(
	streaming:
		| { lastPatchAt?: number | null; startedAt?: number | null }
		| null
		| undefined,
	fallback: string,
): string {
	const time = streaming?.lastPatchAt ?? streaming?.startedAt;
	if (typeof time === "number" && Number.isFinite(time)) {
		return new Date(time).toISOString();
	}
	return fallback;
}

function sentItem(turn: SessionTurnRecord, streaming = false): TimelineItem {
	return {
		id: `${getTurnRenderKey(turn)}:sent`,
		kind: "sent",
		turnId: turn.id,
		...(streaming ? { streaming } : {}),
	};
}

type TurnTimelineInput = {
	sessionId: string | null;
	turns: SessionTurnRecord[];
	streaming?: {
		sessionId: string;
		turnId?: string | null;
		messageOrdinal?: number | null;
		contentBlocks: ContentBlock[];
		intermediateMessages?: StoredIntermediateMessage[];
		executionKind?: SessionTurnRecord["executionKind"];
		truncatedStart?: boolean;
		status?: string;
		resumed?: boolean;
		runtimePhase?: "llm_call_started" | null;
		runtimeProvider?: string | null;
		runtimeModel?: string | null;
		lastPatchAt?: number | null;
		startedAt?: number | null;
	} | null;
};

type TurnMessages = {
	user: ChatMessage;
	assistant: ChatMessage | null;
};

type TimelineCache = {
	orderedTurns: WeakMap<SessionTurnRecord[], SessionTurnRecord[]>;
	messages: WeakMap<SessionTurnRecord, TurnMessages>;
};

/** Scoped to a chat host; workspace turns and their arrays are immutable snapshots. */
export function createTurnTimelineBuilder() {
	const cache: TimelineCache = {
		orderedTurns: new WeakMap(),
		messages: new WeakMap(),
	};
	return (input: TurnTimelineInput) => renderTurnTimelineItems(input, cache);
}

export function buildTurnTimelineItems(
	input: TurnTimelineInput,
): TimelineItem[] {
	return renderTurnTimelineItems(input);
}

type ProcessMessage = Pick<
	StoredIntermediateMessage,
	"id" | "meta" | "content" | "stopReason"
>;

export function hasStepText(message: Pick<ProcessMessage, "content">) {
	return message.content.some(
		(block) => block.type === "text" && block.text.trim().length > 0,
	);
}

export type ProcessEntry<T> =
	| { kind: "step"; key: string; message: T; live: boolean }
	| { kind: "run"; key: string; messages: T[] };

// Ordinal keys let the live message settle in place; collisions fall back to unique id keys.
export function buildProcessEntries<T extends ProcessMessage>(
	settled: readonly T[],
	live: T | null,
): ProcessEntry<T>[] {
	const used = new Set<string>();
	const keyOf = (message: T) => {
		const ordinal = message.meta?.messageOrdinal;
		let key =
			typeof ordinal === "number" && !used.has(`o:${ordinal}`)
				? `o:${ordinal}`
				: `id:${message.id}`;
		for (let n = 1; used.has(key); n += 1) key = `id:${message.id}:${n}`;
		used.add(key);
		return key;
	};
	const entries: ProcessEntry<T>[] = [];
	for (const message of settled) {
		const key = keyOf(message);
		const last = entries.at(-1);
		if (
			hasStepText(message) ||
			message.stopReason === "error" ||
			message.meta?.messageKind === "compacted"
		)
			entries.push({ kind: "step", key, message, live: false });
		else if (last?.kind === "run") last.messages.push(message);
		else entries.push({ kind: "run", key: `run:${key}`, messages: [message] });
	}
	if (live)
		entries.push({ kind: "step", key: keyOf(live), message: live, live: true });
	return entries;
}

function buildLiveMessage(
	streaming: NonNullable<TurnTimelineInput["streaming"]>,
	renderCreatedAt: string,
): StoredIntermediateMessage | null {
	const blocks = buildStreamingPreviewBlocks(streaming.contentBlocks, {
		truncatedStart: streaming.truncatedStart,
	});
	return createStreamingIntermediateMessage({
		sessionId: streaming.sessionId,
		turnId: streaming.turnId,
		messageOrdinal: streaming.messageOrdinal ?? null,
		contentBlocks: blocks,
		createdAt: resolveStreamingPreviewCreatedAt(streaming, renderCreatedAt),
	});
}

function buildProcessItem(input: {
	turn: SessionTurnRecord;
	summary?: SessionTurnIntermediateSummary | null;
	intermediateMessages?: StoredIntermediateMessage[];
	live?: StoredIntermediateMessage | null;
	streaming?: boolean;
	running?: boolean;
}): TimelineItem | null {
	const messages = input.intermediateMessages ?? [];
	const persistedCount = input.summary?.messageCount ?? 0;
	if (!input.streaming) {
		return persistedCount > 0 && input.summary
			? {
					id: `${getTurnRenderKey(input.turn)}:process`,
					kind: "process",
					turn: input.turn,
					summary: input.summary,
				}
			: null;
	}
	if (messages.length === 0 && persistedCount === 0 && !input.live) return null;
	return {
		id: `${getTurnRenderKey(input.turn)}:process`,
		kind: "process",
		turn: input.turn,
		summary: {
			...(input.summary ?? {}),
			messageCount: Math.max(persistedCount, messages.length),
			toolCallCount: Math.max(
				input.summary?.toolCallCount ?? 0,
				countToolUses(messages),
			),
		},
		intermediateMessages: messages.length > 0 ? messages : undefined,
		live: input.live ?? null,
		streaming: true,
		running: input.running ?? false,
	};
}

function renderTurnTimelineItems(
	input: TurnTimelineInput,
	cache?: TimelineCache,
): TimelineItem[] {
	const renderCreatedAt = new Date().toISOString();
	const items: TimelineItem[] = [];
	const streamingTurnId = input.streaming?.turnId ?? null;
	const hasStreamingState = Boolean(
		input.streaming &&
			(input.streaming.status === "pending" ||
				input.streaming.status === "streaming"),
	);
	const liveIntermediateMessages = input.streaming?.intermediateMessages ?? [];
	const liveMessage =
		hasStreamingState && input.streaming
			? buildLiveMessage(input.streaming, renderCreatedAt)
			: null;
	let streamingProcessInserted = false;
	let streamingSentTurn: SessionTurnRecord | null = null;
	let turns = cache?.orderedTurns.get(input.turns);
	if (!turns) {
		turns = dedupeRenderableTurnsByClientMessageId(input.turns);
		cache?.orderedTurns.set(input.turns, turns);
	}
	const adoptingTurnId =
		hasStreamingState && !streamingTurnId
			? (turns.findLast(
					(turn) => !isQueuedFollowupTurn(turn) && turn.intent !== "compact",
				)?.id ?? null)
			: null;
	for (const turn of turns) {
		const turnRenderKey = getTurnRenderKey(turn);
		// Keep the active turn visible while the server-side queued record is
		// reconciling with the local optimistic one. Other queued follow-ups are
		// rendered by the follow-up queue instead of the main timeline.
		if (isQueuedFollowupTurn(turn) && turn.id !== streamingTurnId) continue;
		if (turn.intent === "compact") {
			items.push({
				id: `${turnRenderKey}:compact`,
				kind: "compact",
				turn,
			});
			continue;
		}
		let messages = cache?.messages.get(turn);
		if (!messages) {
			messages = {
				user: turnToUserMessage(turn),
				assistant: turnToAssistantMessage(turn),
			};
			cache?.messages.set(turn, messages);
		}
		items.push({
			id: `${turnRenderKey}:user`,
			kind: "message",
			message: messages.user,
		});
		const adoptsStream =
			streamingTurnId === turn.id ||
			(turn.id === adoptingTurnId &&
				!(turn.intermediateSummary?.messageCount ?? 0));
		if (adoptsStream) streamingProcessInserted = true;
		const process = buildProcessItem({
			turn,
			summary: turn.intermediateSummary,
			...(adoptsStream
				? {
						intermediateMessages: liveIntermediateMessages,
						live: liveMessage,
						streaming: true,
						running: hasStreamingState,
					}
				: {}),
		});
		if (process) items.push(process);
		const isLiveTurn = hasStreamingState && streamingTurnId === turn.id;
		const assistant = messages.assistant;
		// Keep the live message as the visual source of truth until generation is
		// terminal. Finalized / reconciled turn patches can arrive before the full
		// persisted turn is available, and temporarily swapping to those partial
		// records makes blocks such as thinking vanish and then reappear.
		if (assistant && !isLiveTurn) {
			items.push({
				id: `${turnRenderKey}:assistant`,
				kind: "message",
				message: assistant,
			});
		}
		if (hasSentTurns(turn)) {
			if (isLiveTurn) streamingSentTurn = turn;
			else items.push(sentItem(turn));
		}
	}
	if (hasStreamingState && !streamingProcessInserted) {
		const fallbackSequence = (input.turns.at(-1)?.sequence ?? 0) + 1;
		const fallbackTurn = input.turns.at(-1);
		const sessionId = input.streaming?.sessionId ?? input.sessionId ?? "active";
		// A queued follow-up is never the streaming turn; never clone it as
		// running just because the live turn record is not loaded yet.
		const turn =
			fallbackTurn && !isQueuedFollowupTurn(fallbackTurn)
				? { ...fallbackTurn, status: "running" as const }
				: ({
						id: input.streaming?.turnId ?? `streaming:${sessionId}`,
						sessionId,
						userUuid: null,
						sequence: fallbackSequence,
						status: "running",
						intent: "steer",
						userContent: [],
						userText: null,
						assistantContent: null,
						assistantText: null,
						provider: null,
						model: null,
						stopReason: null,
						errorMessage: null,
						finalUsage: null,
						totalUsage: null,
						summary: null,
						intermediateIndex: null,
						intermediateSummary: null,
						meta: null,
						startedAt: null,
						completedAt: null,
						durationMs: null,
						createdAt: renderCreatedAt,
						updatedAt: renderCreatedAt,
					} satisfies SessionTurnRecord);
		const process = buildProcessItem({
			turn,
			intermediateMessages: liveIntermediateMessages,
			live: liveMessage,
			streaming: true,
			running: true,
		});
		if (process) items.push({ ...process, id: `${process.id}:pending` });
	}
	if (streamingSentTurn) items.push(sentItem(streamingSentTurn, true));
	// Turn footer sits at the very end of the active turn — a tail status for
	// "still waiting / starting", not a mid-timeline process card.
	if (hasStreamingState && input.streaming) {
		const footerPhase = resolveTurnFooterPhase(input.streaming);
		if (footerPhase) {
			const footerTurn =
				input.turns.find((turn) => turn.id === streamingTurnId) ??
				input.turns.at(-1) ??
				null;
			const footerKey = footerTurn
				? getTurnRenderKey(footerTurn)
				: `streaming:${input.streaming.sessionId ?? input.sessionId ?? "active"}`;
			items.push({
				id: `${footerKey}:footer`,
				kind: "turn_footer",
				phase: footerPhase,
				runtimeProvider: input.streaming.runtimeProvider ?? null,
				runtimeModel: input.streaming.runtimeModel ?? null,
			});
		}
	}
	return items;
}
