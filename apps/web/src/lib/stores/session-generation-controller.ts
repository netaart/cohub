import type { StoredIntermediateMessage } from "@cohub/protocol/model";
import { createStreamingIntermediateMessage } from "$lib/session-streaming-message";
import { reuseUnchangedItems } from "$lib/structural-sharing";
import {
	type StreamingIntermediateMessage,
	sessionGenerationStore,
} from "./session-generation.svelte";

export function buildStreamingStoredIntermediateMessages(input: {
	spaceId?: string | null;
	sessionId: string;
	turnId?: string | null;
	intermediateMessages?: StreamingIntermediateMessage[];
	previous?: readonly StoredIntermediateMessage[];
}): StoredIntermediateMessage[] {
	const previous = input.previous ?? [];
	const previousCreatedAt = new Map(
		previous.map((message) => [message.id, message.createdAt]),
	);
	const next = (input.intermediateMessages ?? [])
		.map((message, index) => {
			const streamMessageId =
				message.id ??
				message.messageId ??
				`stream:${input.sessionId}:${input.turnId ?? "turn"}:intermediate:${index}`;
			return createStreamingIntermediateMessage({
				spaceId: input.spaceId,
				sessionId: input.sessionId,
				turnId: input.turnId,
				streamMessageId,
				messageOrdinal:
					message.meta?.messageKind === "compacted"
						? null
						: (message.messageOrdinal ?? index),
				sequence: message.sequence,
				role: message.role,
				contentBlocks: message.content,
				text: message.text,
				provider: message.provider,
				model: message.model,
				stopReason: message.stopReason,
				errorMessage: message.errorMessage,
				usage: message.usage,
				durationMs: message.durationMs,
				toolCallsObjectKey: message.toolCallsObjectKey,
				meta: message.meta,
				createdAt: message.createdAt ?? previousCreatedAt.get(streamMessageId),
			});
		})
		.filter((message): message is StoredIntermediateMessage =>
			Boolean(message),
		);
	return reuseUnchangedItems(previous, next);
}

export function clearGenerationError(sessionId: string | null | undefined) {
	sessionGenerationStore.clearError(sessionId);
}

export function startGenerationRequest(
	sessionId: string,
	input?: {
		requestId?: string | null;
		spaceId?: string | null;
		turnId?: string | null;
	},
) {
	clearGenerationError(sessionId);
	const current = sessionGenerationStore.get(sessionId);
	const isDifferentTurn = Boolean(
		input?.turnId && current?.turnId && input.turnId !== current.turnId,
	);
	if (current?.status === "streaming" && !isDifferentTurn) return;
	sessionGenerationStore.startPending(sessionId, input);
}

export function failGeneration(
	sessionId: string,
	error?: string | null,
	input?: { errorCode?: string | null },
) {
	sessionGenerationStore.fail(sessionId, error ?? "Generation failed", input);
}

export function interruptGeneration(sessionId: string) {
	sessionGenerationStore.interrupt(sessionId);
}

export function replaceGenerationTurnId(
	sessionId: string,
	input: { previousTurnId?: string | null; nextTurnId: string | null },
) {
	sessionGenerationStore.replaceTurnId(sessionId, input);
}

export function completeGeneration(sessionId: string) {
	sessionGenerationStore.complete(sessionId);
}

export function clearCompletedIntermediateHandoff(
	sessionId: string,
	input?: { turnId?: string | null },
) {
	sessionGenerationStore.clearCompletedIntermediateHandoff(sessionId, input);
}

export function resetGeneration(sessionId: string | null | undefined) {
	sessionGenerationStore.reset(sessionId);
}
