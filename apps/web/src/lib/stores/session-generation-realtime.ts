import type { ContentBlock } from "@cohub/protocol/core";
import type { MessageRecord } from "@cohub/protocol/model";
import type {
	GenerationStreamEvent,
	GenerationStreamLifecycleEvent,
	GenerationStreamStateEvent,
} from "@neta-art/cohub";
import {
	isArchivedMessageIdentity,
	isSameLiveMessage,
} from "$lib/session-generation-stream-guards";
import type { StreamingIntermediateMessage } from "./session-generation.svelte";
import { sessionGenerationStore } from "./session-generation.svelte";
import {
	failGeneration,
	interruptGeneration,
} from "./session-generation-controller";
import { generationTurnChanged } from "./session-generation-state";

type HandledGenerationRealtimeEffect = {
	handled: true;
	shouldScroll: boolean;
	shouldReconcile: boolean;
	shouldRestoreSnapshot: boolean;
};

export type GenerationRealtimeEffect =
	| HandledGenerationRealtimeEffect
	| {
			handled: false;
			shouldScroll: false;
			shouldReconcile: false;
			shouldRestoreSnapshot: false;
	  };

const ignoredEffect: GenerationRealtimeEffect = {
	handled: false,
	shouldScroll: false,
	shouldReconcile: false,
	shouldRestoreSnapshot: false,
};

function handledEffect(
	input: Omit<HandledGenerationRealtimeEffect, "handled">,
): GenerationRealtimeEffect {
	return {
		handled: true,
		...input,
	};
}

/**
 * Extract visible text from content blocks, normalizing for comparison.
 * Empty/whitespace-only thinking and text blocks are excluded to match
 * the behavior of `buildStreamingPreviewBlocks`, which filters them out
 * during streaming.
 */
function getVisibleTextContent(blocks: ContentBlock[]): string {
	return blocks
		.map((block) => {
			if (block.type === "text") return block.text.trim();
			if (block.type === "thinking") return block.thinking.trim();
			return "";
		})
		.filter(Boolean)
		.join("\n\n");
}

/**
 * Compare two sets of content blocks by their visible text content.
 * Used to avoid replacing streaming-accumulated blocks with the server's
 * final blocks when the rendered text is already identical.
 */
function isContentTextuallySame(a: ContentBlock[], b: ContentBlock[]): boolean {
	return getVisibleTextContent(a) === getVisibleTextContent(b);
}

function resolveStreamMessageId(input: {
	sessionId: string;
	turnId?: string | null;
	anchorUserMessageId?: string | null;
	messageId?: string | null;
	messageOrdinal?: number | null;
}) {
	if (input.messageId?.trim()) return input.messageId.trim();
	if (input.messageOrdinal == null) return null;
	if (input.turnId?.trim()) {
		return `turn:${input.turnId.trim()}:assistant:${input.messageOrdinal}`;
	}
	return `session:${input.sessionId}:assistant:${input.messageOrdinal}:${input.anchorUserMessageId ?? "unknown"}`;
}

function normalizeIntermediateMessages(
	messages:
		| GenerationStreamStateEvent["intermediateMessages"]
		| StreamingIntermediateMessage[]
		| undefined,
): StreamingIntermediateMessage[] {
	return (messages ?? [])
		.filter((message) => Array.isArray(message.content))
		.map((message) => ({
			...message,
			messageId: message.messageId ?? null,
			messageOrdinal: message.messageOrdinal ?? null,
			content: message.content,
		}));
}

function getIntermediateMessageKey(message: StreamingIntermediateMessage) {
	if (message.messageOrdinal != null)
		return `ordinal:${message.messageOrdinal}`;
	if (message.messageId) return `message:${message.messageId}`;
	if (message.id) return `id:${message.id}`;
	try {
		return `content:${JSON.stringify(message.content)}`;
	} catch {
		return null;
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function getToolUseIds(content: ContentBlock[]): string[] {
	return content
		.filter(
			(block): block is Extract<ContentBlock, { type: "tool_use" }> =>
				block.type === "tool_use",
		)
		.map((block) => block.id);
}

/**
 * Root cause (each_key_duplicate): assistant_intermediate messages persisted via
 * `session.message.persisted` never carried `meta.messageOrdinal` (the agent only
 * attached it to the `stream_update`/`session.turn.patch` payload, not to the
 * persisted message meta). The SDK then falls back to `messageId`/`message.id` (a
 * DB UUID) for those records, while the stream-snapshot REST API re-numbers
 * messages by array index (`ordinal:N`). The same logical message can end up under
 * two incompatible dedupe keys when a snapshot-recovery path (ordinal-keyed) and a
 * persisted-message path (id-keyed) both feed into the same intermediateMessages
 * array — producing duplicate entries that crash Svelte's `{#each ... (id)}` in
 * ProcessCard/ToolCallList with each_key_duplicate.
 *
 * The backend fix (apps/agent/src/persistence.ts) now always writes messageOrdinal
 * into persisted meta so both paths share one key space going forward. This
 * cross-key pass stays as defense-in-depth for any message that still lacks an
 * ordinal (e.g. data persisted before the backend fix, or future gaps): if two
 * entries land under different dedupe keys but share a tool_use.id, they are the
 * same logical message and must be merged into one.
 */
function mergeMessagesSharingToolUseId(
	messages: StreamingIntermediateMessage[],
): StreamingIntermediateMessage[] {
	const indexByToolUseId = new Map<string, number>();
	const merged: StreamingIntermediateMessage[] = [];
	for (const message of messages) {
		const toolUseIds = getToolUseIds(message.content ?? []);
		const existingIndex = toolUseIds
			.map((id) => indexByToolUseId.get(id))
			.find((idx): idx is number => idx != null);
		if (existingIndex == null) {
			const newIndex = merged.length;
			merged.push(message);
			for (const id of toolUseIds) indexByToolUseId.set(id, newIndex);
			continue;
		}
		merged[existingIndex] = { ...merged[existingIndex], ...message };
		for (const id of toolUseIds) indexByToolUseId.set(id, existingIndex);
	}
	return merged;
}

function getCompactionPlacement(message: StreamingIntermediateMessage) {
	const meta = isRecord(message.meta) ? message.meta : null;
	const compaction = isRecord(meta?.compaction) ? meta.compaction : null;
	const placement = isRecord(compaction?.placement)
		? compaction.placement
		: null;
	return meta?.messageKind === "compacted"
		? {
				beforeMessageId:
					typeof placement?.beforeMessageId === "string"
						? placement.beforeMessageId
						: null,
				sequence:
					typeof message.sequence === "number" ? message.sequence : null,
			}
		: null;
}

function placeCompactionMessages(messages: StreamingIntermediateMessage[]) {
	const result = messages.filter((message) => !getCompactionPlacement(message));
	const compactions = messages.filter((message) =>
		getCompactionPlacement(message),
	);
	for (const message of compactions) {
		const placement = getCompactionPlacement(message);
		let index = placement?.beforeMessageId
			? result.findIndex(
					(candidate) =>
						candidate.id === placement.beforeMessageId ||
						candidate.messageId === placement.beforeMessageId,
				)
			: -1;
		const sequence = placement?.sequence;
		if (index < 0 && sequence != null) {
			index = result.findIndex(
				(candidate) =>
					typeof candidate.sequence === "number" &&
					candidate.sequence >= sequence,
			);
		}
		result.splice(index < 0 ? result.length : index, 0, message);
	}
	return result;
}

function compactIntermediateMessages(messages: StreamingIntermediateMessage[]) {
	const merged: StreamingIntermediateMessage[] = [];
	const indexByKey = new Map<string, number>();
	for (const message of messages) {
		const key = getIntermediateMessageKey(message);
		if (!key) {
			merged.push(message);
			continue;
		}
		const index = indexByKey.get(key);
		if (index == null) {
			indexByKey.set(key, merged.length);
			merged.push(message);
			continue;
		}
		merged[index] = { ...merged[index], ...message };
	}
	return placeCompactionMessages(mergeMessagesSharingToolUseId(merged));
}

function mergeIntermediateMessages(
	current: StreamingIntermediateMessage[],
	incoming: StreamingIntermediateMessage[],
) {
	if (current.length === 0) return compactIntermediateMessages(incoming);
	if (incoming.length === 0) return compactIntermediateMessages(current);
	return compactIntermediateMessages([...current, ...incoming]);
}

function intermediateFromCommitMessage(
	sessionId: string,
	message: MessageRecord,
): StreamingIntermediateMessage | null {
	if (!Array.isArray(message.content) || message.content.length === 0) {
		return null;
	}
	const meta = isRecord(message.meta) ? message.meta : {};
	return {
		id: message.id,
		sessionId: message.sessionId ?? sessionId,
		sequence: message.sequence,
		role: message.role,
		messageId:
			typeof meta.streamMessageId === "string"
				? meta.streamMessageId
				: (message.id ?? null),
		messageOrdinal:
			typeof meta.messageOrdinal === "number" ? meta.messageOrdinal : null,
		content: message.content as ContentBlock[],
		text: message.text,
		provider: message.provider,
		model: message.model,
		stopReason: message.stopReason,
		errorMessage: message.errorMessage,
		usage: message.usage,
		durationMs: message.durationMs,
		meta: message.meta,
		createdAt: message.createdAt,
	};
}

function resolveIntermediateMessagesForState(
	sessionId: string,
	event: GenerationStreamStateEvent,
) {
	const incoming = normalizeIntermediateMessages(event.intermediateMessages);
	const current = sessionGenerationStore.get(sessionId);
	const sameTurn = Boolean(
		current?.turnId &&
			event.state.turnId &&
			current.turnId === event.state.turnId,
	);
	return sameTurn
		? mergeIntermediateMessages(current?.intermediateMessages ?? [], incoming)
		: incoming;
}

function applyGenerationState(
	sessionId: string,
	event: GenerationStreamStateEvent,
) {
	const current = sessionGenerationStore.get(sessionId);
	const sameTurn = Boolean(
		current?.turnId &&
			event.state.turnId &&
			current.turnId === event.state.turnId,
	);
	const eventIdentity = {
		messageOrdinal: event.messageOrdinal,
		messageId: event.messageId,
	};
	// Already archived into process history — never revive as live preview.
	if (
		sameTurn &&
		isArchivedMessageIdentity(
			current?.intermediateMessages ?? [],
			eventIdentity,
		)
	) {
		return;
	}
	// patchSeq restarts at 1 for each assistant message (baseSeq=0 keyframe).
	// Only treat lower/equal patchSeq as stale within the same live message.
	const sameLiveMessage =
		current != null && isSameLiveMessage(current, eventIdentity);
	if (
		sameTurn &&
		sameLiveMessage &&
		typeof event.state.patchSeq === "number" &&
		event.state.patchSeq > 0 &&
		(current?.patchSeq ?? 0) >= event.state.patchSeq
	) {
		return;
	}
	sessionGenerationStore.applyProgress(sessionId, {
		spaceId: event.state.spaceId,
		contentBlocks: event.state.contentBlocks,
		intermediateMessages: resolveIntermediateMessagesForState(sessionId, event),
		streamMessageId: event.messageId,
		messageOrdinal: event.messageOrdinal,
		anchorUserMessageId: event.state.anchorUserMessageId,
		truncatedStart: shouldMarkTruncatedStart(sessionId, event),
		patchSeq: event.state.patchSeq,
		turnId: event.state.turnId,
		patchAt: event.rawEvent?.timestamp ?? null,
	});
}

function shouldMarkTruncatedStart(
	sessionId: string,
	event: GenerationStreamStateEvent,
) {
	const current = sessionGenerationStore.get(sessionId);
	if (current?.status !== "pending") return false;
	if (event.source === "patch") {
		return event.state.patchSeq > 0 && current.contentBlocks.length === 0;
	}
	return false;
}

export function applyGenerationStreamSnapshot(
	sessionId: string,
	input: {
		spaceId?: string | null;
		turnId?: string | null;
		seq: number;
		anchorUserMessageId?: string | null;
		current: {
			messageId?: string | null;
			messageOrdinal?: number | null;
			content: ContentBlock[];
		};
		intermediateMessages?: StreamingIntermediateMessage[];
		lifecycle?: {
			phase: "llm_call_started";
			llmRound: number;
			provider: string | null;
			model: string | null;
			at: string;
		} | null;
		updatedAt?: number | null;
	},
) {
	const current = sessionGenerationStore.get(sessionId);
	const resolvedTurnId = input.turnId ?? current?.turnId ?? null;
	const snapshotIdentity = {
		messageOrdinal: input.current.messageOrdinal ?? null,
		messageId: input.current.messageId ?? null,
	};
	const sameTurn = Boolean(
		current?.turnId && resolvedTurnId && current.turnId === resolvedTurnId,
	);
	// Same rule as patch path: archived rounds must not revive as live preview.
	if (
		sameTurn &&
		isArchivedMessageIdentity(
			current?.intermediateMessages ?? [],
			snapshotIdentity,
		)
	) {
		return { applied: false, reason: "stale_snapshot" as const };
	}
	const sameLiveMessage =
		current != null && isSameLiveMessage(current, snapshotIdentity);
	if (sameTurn && sameLiveMessage && current.patchSeq >= input.seq) {
		return { applied: false, reason: "stale_snapshot" as const };
	}
	const hasSnapshotContent =
		input.current.content.length > 0 ||
		(input.intermediateMessages?.length ?? 0) > 0;
	const shouldArmWaiting =
		input.lifecycle?.phase === "llm_call_started" &&
		// Don't re-arm waiting over an already-streaming assistant message.
		// Between rounds, current content is empty after intermediate archive.
		input.current.content.length === 0;
	if (!hasSnapshotContent) {
		if (shouldArmWaiting && input.lifecycle) {
			sessionGenerationStore.markRuntimePhase(sessionId, {
				phase: "llm_call_started",
				at: input.lifecycle.at,
				llmRound: input.lifecycle.llmRound,
				provider: input.lifecycle.provider,
				model: input.lifecycle.model,
				spaceId: input.spaceId ?? current?.spaceId ?? null,
				turnId: resolvedTurnId,
				anchorUserMessageId:
					input.anchorUserMessageId ?? current?.anchorUserMessageId ?? null,
			});
		}
		return input.lifecycle
			? { applied: true as const }
			: { applied: false as const, reason: "empty_snapshot" as const };
	}
	// Skip contentBlocks update when textually identical to avoid
	// resetting the StreamingMarkdownController's typing animation.
	const currentBlocks = current?.contentBlocks ?? [];
	const snapshotBlocks = input.current.content;
	const skipContentUpdate =
		snapshotBlocks.length > 0 &&
		isContentTextuallySame(currentBlocks, snapshotBlocks);
	const currentIntermediateMessages = current?.intermediateMessages ?? [];
	const incomingIntermediateMessages = normalizeIntermediateMessages(
		input.intermediateMessages,
	);
	sessionGenerationStore.applyProgress(sessionId, {
		spaceId: input.spaceId ?? current?.spaceId ?? null,
		contentBlocks: skipContentUpdate ? currentBlocks : snapshotBlocks,
		intermediateMessages:
			current?.turnId && resolvedTurnId && current.turnId === resolvedTurnId
				? mergeIntermediateMessages(
						currentIntermediateMessages,
						incomingIntermediateMessages,
					)
				: incomingIntermediateMessages,
		streamMessageId: resolveStreamMessageId({
			sessionId,
			turnId: resolvedTurnId,
			anchorUserMessageId:
				input.anchorUserMessageId ?? current?.anchorUserMessageId,
			messageId: input.current.messageId,
			messageOrdinal: input.current.messageOrdinal,
		}),
		messageOrdinal: input.current.messageOrdinal ?? null,
		anchorUserMessageId:
			input.anchorUserMessageId ?? current?.anchorUserMessageId ?? null,
		truncatedStart: false,
		patchSeq: input.seq,
		turnId: resolvedTurnId,
		patchAt: input.updatedAt ?? null,
	});
	if (shouldArmWaiting && input.lifecycle) {
		sessionGenerationStore.markRuntimePhase(sessionId, {
			phase: "llm_call_started",
			at: input.lifecycle.at,
			llmRound: input.lifecycle.llmRound,
			provider: input.lifecycle.provider,
			model: input.lifecycle.model,
			spaceId: input.spaceId ?? current?.spaceId ?? null,
			turnId: resolvedTurnId,
			anchorUserMessageId:
				input.anchorUserMessageId ?? current?.anchorUserMessageId ?? null,
		});
	}
	return { applied: true as const };
}

function applyGenerationLifecycle(
	sessionId: string,
	event: GenerationStreamLifecycleEvent,
) {
	sessionGenerationStore.markRuntimePhase(sessionId, {
		phase: event.phase,
		at: event.at,
		llmRound: event.llmRound,
		provider: event.provider,
		model: event.model,
		turnId: event.turnId,
		anchorUserMessageId: event.anchorUserMessageId,
	});
}

export function applyGenerationStreamEvent(
	sessionId: string,
	event: GenerationStreamEvent,
): GenerationRealtimeEffect {
	if (event.type === "lifecycle") {
		applyGenerationLifecycle(sessionId, event);
		return handledEffect({
			shouldScroll: false,
			shouldReconcile: false,
			shouldRestoreSnapshot: false,
		});
	}

	if (event.type === "state") {
		applyGenerationState(sessionId, event);
		return handledEffect({
			shouldScroll: true,
			shouldReconcile: false,
			shouldRestoreSnapshot: false,
		});
	}

	if (event.type === "commit") {
		if (event.commit.kind === "intermediate") {
			// Align with SDK: archive the finished round into intermediateMessages
			// and clear live contentBlocks immediately. Without this, the previous
			// round's tools linger in the streaming preview until the next patch.
			const current = sessionGenerationStore.get(sessionId);
			const meta = isRecord(event.commit.message.meta)
				? event.commit.message.meta
				: null;
			const commitTurnId =
				typeof meta?.turnId === "string" ? meta.turnId : null;
			// Drop late intermediate archives from a previous turn after a queued
			// follow-up has already advanced generation state to a new turnId.
			if (commitTurnId && current?.turnId && current.turnId !== commitTurnId) {
				return handledEffect({
					shouldScroll: false,
					shouldReconcile: false,
					shouldRestoreSnapshot: false,
				});
			}
			const archived = intermediateFromCommitMessage(
				sessionId,
				event.commit.message,
			);
			const intermediateMessages = archived
				? mergeIntermediateMessages(current?.intermediateMessages ?? [], [
						archived,
					])
				: (current?.intermediateMessages ?? []);
			const turnId = commitTurnId ?? current?.turnId ?? null;
			sessionGenerationStore.archiveIntermediateRound(sessionId, {
				intermediateMessages,
				archived,
				turnId,
			});
			return handledEffect({
				shouldScroll: true,
				shouldReconcile: false,
				shouldRestoreSnapshot: false,
			});
		}
		if (event.commit.kind === "final" || event.commit.kind === "error") {
			// Apply the full content blocks from the persisted message
			// (session.message.persisted) which carries complete content
			// including thinking, tool_use, tool_result, etc.
			// Guard against late final commits from a previous turn after a
			// queued follow-up has already started — those must not paint the
			// previous answer onto the new turn's live preview.
			const commitContent = event.commit.message.content;
			const current = sessionGenerationStore.get(sessionId);
			const meta = isRecord(event.commit.message.meta)
				? event.commit.message.meta
				: null;
			const commitTurnId =
				typeof meta?.turnId === "string" ? meta.turnId : null;
			const sameTurn =
				!commitTurnId || !current?.turnId || current.turnId === commitTurnId;
			if (
				sameTurn &&
				Array.isArray(commitContent) &&
				commitContent.length > 0
			) {
				const currentBlocks = current?.contentBlocks ?? [];
				if (!isContentTextuallySame(currentBlocks, commitContent)) {
					sessionGenerationStore.applyProgress(sessionId, {
						contentBlocks: commitContent,
						finalizedPreview: true,
						turnId: commitTurnId ?? current?.turnId ?? null,
					});
				}
			}
			return handledEffect({
				shouldScroll: true,
				shouldReconcile: true,
				shouldRestoreSnapshot: false,
			});
		}
		return handledEffect({
			shouldScroll: false,
			shouldReconcile: false,
			shouldRestoreSnapshot: false,
		});
	}

	if (event.type === "finalized") {
		if (
			event.turn.status === "interrupted" ||
			event.turn.status === "merged" ||
			event.turn.status === "cancelled"
		) {
			// Only the live Turn's own finalize interrupts it.
			const current = sessionGenerationStore.get(sessionId);
			if (!generationTurnChanged(current?.turnId, event.turn.id)) {
				interruptGeneration(sessionId);
			}
			return handledEffect({
				shouldScroll: false,
				shouldReconcile: true,
				shouldRestoreSnapshot: false,
			});
		}
		// Content blocks are NOT updated here — session.turn.finalized
		// strips assistantContent (via toRealtimeTurnRecord). The full
		// content is applied by the preceding commit event
		// (session.message.persisted) which arrives a few ms earlier.
		return handledEffect({
			shouldScroll: true,
			shouldReconcile: true,
			shouldRestoreSnapshot: false,
		});
	}

	if (event.type === "error") {
		failGeneration(sessionId, event.message);
		return handledEffect({
			shouldScroll: false,
			shouldReconcile: false,
			shouldRestoreSnapshot: false,
		});
	}

	if (event.type === "out_of_sync") {
		const shouldRestoreSnapshot =
			event.reason === "version_mismatch" && event.source === "patch";
		return handledEffect({
			shouldScroll: false,
			shouldReconcile: true,
			shouldRestoreSnapshot,
		});
	}

	return ignoredEffect;
}
