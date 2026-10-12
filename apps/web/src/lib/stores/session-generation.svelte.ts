import type { ContentBlock, Usage } from "@cohub/protocol/core";
import { getCacheUserKey } from "$lib/cache/keys";
import { sessionGenerationSnapshotsRepo } from "$lib/cache/repositories/session-generation-snapshots-repo";
import { shouldPreserveLivePreviewOnArchive } from "$lib/session-generation-stream-guards";
import {
	emptyGenerationStreamResiduals,
	generationTurnChanged,
	removeGenerationStatesForSpace,
	resolveGenerationProgressResiduals,
	resolveGenerationStreamResiduals,
	shouldResumePendingGeneration,
} from "$lib/stores/session-generation-state";

export type SessionGenerationStatus =
	| "idle"
	| "pending"
	| "streaming"
	| "completed"
	| "failed"
	| "interrupted";

export type SessionGenerationRuntimePhase = "llm_call_started";

export type StreamingIntermediateMessage = {
	messageId?: string | null;
	messageOrdinal?: number | null;
	content: ContentBlock[];
	id?: string;
	sessionId?: string;
	sequence?: number | null;
	role?: "user" | "assistant" | "system";
	text?: string | null;
	provider?: string | null;
	model?: string | null;
	stopReason?: string | null;
	errorMessage?: string | null;
	usage?: Usage | null;
	durationMs?: number | null;
	toolCallsObjectKey?: string | null;
	meta?: Record<string, unknown> | null;
	createdAt?: string;
};

export type SessionGenerationState = {
	spaceId?: string | null;
	sessionId: string;
	status: SessionGenerationStatus | string;
	/** Recovered running Turn, not a newly dispatched prompt. */
	resumed?: boolean;
	requestId?: string | null;
	error?: string | null;
	errorCode?: string | null;
	startedAt?: number;
	lastEventAt?: number;
	contentBlocks: ContentBlock[];
	intermediateMessages: StreamingIntermediateMessage[];
	streamMessageId: string | null;
	messageOrdinal: number | null;
	anchorUserMessageId: string | null;
	truncatedStart: boolean;
	patchSeq: number;
	turnId: string | null;
	runtimePhase: SessionGenerationRuntimePhase | null;
	runtimePhaseAt: number | null;
	llmRound: number | null;
	runtimeProvider: string | null;
	runtimeModel: string | null;
	finalizedPreview: boolean;
	/**
	 * Server-side emit time (epoch ms) of the latest content chunk, taken from
	 * the realtime event envelope. Used to stamp the live streaming preview with
	 * a real time that advances with the stream yet freezes between chunks,
	 * instead of the client's ever-advancing render clock.
	 */
	lastPatchAt: number | null;
};

const PERSIST_WRITE_DEBOUNCE_MS = 250;
const MAX_PERSISTED_ERROR_LENGTH = 1000;
const TERMINAL_STATUSES = new Set([
	"idle",
	"completed",
	"failed",
	"interrupted",
]);

const createIdleState = (sessionId: string): SessionGenerationState => ({
	sessionId,
	spaceId: null,
	status: "idle",
	requestId: null,
	error: null,
	errorCode: null,
	startedAt: undefined,
	lastEventAt: undefined,
	contentBlocks: [],
	intermediateMessages: [],
	streamMessageId: null,
	messageOrdinal: null,
	anchorUserMessageId: null,
	truncatedStart: false,
	patchSeq: 0,
	turnId: null,
	runtimePhase: null,
	runtimePhaseAt: null,
	llmRound: null,
	runtimeProvider: null,
	runtimeModel: null,
	finalizedPreview: false,
	lastPatchAt: null,
});

function sanitizeError(error: string | null | undefined) {
	const trimmed = error?.trim();
	return trimmed ? trimmed.slice(0, MAX_PERSISTED_ERROR_LENGTH) : null;
}

function parseIntermediateMessage(
	value: unknown,
): StreamingIntermediateMessage | null {
	if (Array.isArray(value)) return { content: value as ContentBlock[] };
	if (!value || typeof value !== "object") return null;
	const record = value as Record<string, unknown>;
	if (!Array.isArray(record.content)) return null;
	return {
		...record,
		content: record.content as ContentBlock[],
		messageId: typeof record.messageId === "string" ? record.messageId : null,
		messageOrdinal:
			typeof record.messageOrdinal === "number" ? record.messageOrdinal : null,
		id: typeof record.id === "string" ? record.id : undefined,
		sessionId:
			typeof record.sessionId === "string" ? record.sessionId : undefined,
		role:
			record.role === "user" ||
			record.role === "assistant" ||
			record.role === "system"
				? record.role
				: undefined,
		text: typeof record.text === "string" ? record.text : null,
		provider: typeof record.provider === "string" ? record.provider : null,
		model: typeof record.model === "string" ? record.model : null,
		stopReason:
			typeof record.stopReason === "string" ? record.stopReason : null,
		errorMessage:
			typeof record.errorMessage === "string" ? record.errorMessage : null,
		usage:
			record.usage && typeof record.usage === "object"
				? (record.usage as Usage)
				: null,
		durationMs:
			typeof record.durationMs === "number" ? record.durationMs : null,
		toolCallsObjectKey:
			typeof record.toolCallsObjectKey === "string"
				? record.toolCallsObjectKey
				: null,
		meta:
			record.meta &&
			typeof record.meta === "object" &&
			!Array.isArray(record.meta)
				? (record.meta as Record<string, unknown>)
				: null,
		createdAt:
			typeof record.createdAt === "string" ? record.createdAt : undefined,
	};
}

function isPersistable(state: SessionGenerationState) {
	return !TERMINAL_STATUSES.has(state.status);
}

/**
 * A pending state with no streamed output carries no information worth
 * restoring: on reload the live turn is re-derived from turn data, so keeping
 * it only risks pinning a stale (e.g. queued) turn id as the active generation.
 */
function hasSnapshotOutput(input: {
	status: string;
	contentBlockCount: number;
	intermediateMessageCount: number;
	finalizedPreview: boolean;
}) {
	return !(
		input.status === "pending" &&
		input.contentBlockCount === 0 &&
		input.intermediateMessageCount === 0 &&
		!input.finalizedPreview
	);
}

function shouldPersistSnapshot(state: SessionGenerationState) {
	return (
		isPersistable(state) &&
		hasSnapshotOutput({
			status: state.status,
			contentBlockCount: state.contentBlocks.length,
			intermediateMessageCount: state.intermediateMessages.length,
			finalizedPreview: state.finalizedPreview,
		})
	);
}

function isTerminalStatus(status: string | null | undefined) {
	return Boolean(status && TERMINAL_STATUSES.has(status));
}

function isValidTimestamp(value: number | null | undefined): value is number {
	return typeof value === "number" && Number.isFinite(value);
}

/** Latest of two chunk emit times; out-of-order safe. */
function latestPatchAt(
	current: number | null | undefined,
	incoming: number | null | undefined,
): number | null {
	if (!isValidTimestamp(incoming)) return current ?? null;
	if (!isValidTimestamp(current)) return incoming;
	return Math.max(current, incoming);
}

function parseSnapshotState(
	record: Awaited<ReturnType<typeof sessionGenerationSnapshotsRepo.get>>,
): SessionGenerationState | null {
	if (!record?.sessionId || !record.status) return null;
	if (TERMINAL_STATUSES.has(record.status)) return null;
	if (!record.spaceId) return null;
	const contentBlocks = Array.isArray(record.contentBlocks)
		? (record.contentBlocks as ContentBlock[])
		: null;
	const intermediateMessages = Array.isArray(record.intermediateMessages)
		? record.intermediateMessages
				.map(parseIntermediateMessage)
				.filter((message): message is StreamingIntermediateMessage =>
					Boolean(message),
				)
		: null;
	if (!contentBlocks || !intermediateMessages) return null;
	// Legacy snapshots written before empty pending states were rejected.
	if (
		!hasSnapshotOutput({
			status: record.status,
			contentBlockCount: contentBlocks.length,
			intermediateMessageCount: intermediateMessages.length,
			finalizedPreview: record.finalizedPreview,
		})
	) {
		return null;
	}
	return {
		spaceId: record.spaceId,
		sessionId: record.sessionId,
		status: record.status,
		resumed: true,
		requestId: null,
		error: null,
		errorCode: null,
		startedAt: record.startedAt ?? undefined,
		lastEventAt: record.lastEventAt ?? undefined,
		contentBlocks,
		intermediateMessages,
		streamMessageId: record.streamMessageId,
		messageOrdinal: record.messageOrdinal,
		anchorUserMessageId: record.anchorUserMessageId,
		truncatedStart: record.truncatedStart,
		patchSeq: record.patchSeq,
		turnId: record.turnId,
		runtimePhase:
			record.runtimePhase === "llm_call_started" ? "llm_call_started" : null,
		runtimePhaseAt: record.runtimePhaseAt,
		llmRound: record.llmRound,
		runtimeProvider: record.runtimeProvider,
		runtimeModel: record.runtimeModel,
		finalizedPreview: record.finalizedPreview,
		lastPatchAt: record.lastPatchAt ?? null,
	};
}

function toSnapshotInput(state: SessionGenerationState) {
	const now = Date.now();
	return {
		spaceId: state.spaceId ?? "",
		sessionId: state.sessionId,
		turnId: state.turnId,
		anchorUserMessageId: state.anchorUserMessageId,
		clientMessageId: null,
		status: state.status,
		contentBlocks: state.contentBlocks,
		intermediateMessages: state.intermediateMessages,
		streamMessageId: state.streamMessageId,
		messageOrdinal: state.messageOrdinal,
		truncatedStart: state.truncatedStart,
		patchSeq: state.patchSeq,
		finalizedPreview: state.finalizedPreview,
		runtimePhase: state.runtimePhase,
		runtimePhaseAt: state.runtimePhaseAt,
		llmRound: state.llmRound,
		runtimeProvider: state.runtimeProvider,
		runtimeModel: state.runtimeModel,
		startedAt: state.startedAt ?? null,
		lastEventAt: state.lastEventAt ?? null,
		lastPatchAt: state.lastPatchAt ?? null,
		updatedAt: now,
	};
}

class SessionGenerationStore {
	bySessionId = $state<Record<string, SessionGenerationState>>({});
	private persistTimers = new Map<string, ReturnType<typeof setTimeout>>();
	private userKey = getCacheUserKey();

	private ensureUser() {
		const userKey = getCacheUserKey();
		if (this.userKey === userKey) return;
		for (const timer of this.persistTimers.values()) clearTimeout(timer);
		this.persistTimers.clear();
		this.bySessionId = {};
		this.userKey = userKey;
	}

	constructor() {
		void sessionGenerationSnapshotsRepo.deleteExpired().catch(() => undefined);
	}

	async restore(spaceId: string, sessionId: string) {
		this.ensureUser();
		const current = this.get(sessionId);
		if (current && isPersistable(current)) return current;
		const requestStartedAt = Date.now();
		const userKey = getCacheUserKey();
		const record = await sessionGenerationSnapshotsRepo.get(spaceId, sessionId);
		if (getCacheUserKey() !== userKey) return null;
		const latest = this.get(sessionId);
		if (
			latest &&
			isPersistable(latest) &&
			(latest.lastEventAt ?? latest.startedAt ?? 0) >= requestStartedAt
		) {
			return latest;
		}
		const state = parseSnapshotState(record);
		// A terminal event can arrive while IndexedDB is reading the old live output.
		if (state && latest && !shouldResumePendingGeneration(latest, state.turnId))
			return latest;
		if (!state) {
			if (record) {
				void sessionGenerationSnapshotsRepo
					.delete(spaceId, sessionId)
					.catch(() => undefined);
			}
			return null;
		}
		if (
			latest &&
			isPersistable(latest) &&
			(latest.lastEventAt ?? latest.startedAt ?? 0) >
				(state.lastEventAt ?? state.startedAt ?? 0)
		) {
			return latest;
		}
		this.bySessionId = {
			...this.bySessionId,
			[sessionId]: state,
		};
		return state;
	}

	private clearPersistTimer(sessionId: string) {
		const timer = this.persistTimers.get(sessionId);
		if (!timer) return;
		clearTimeout(timer);
		this.persistTimers.delete(sessionId);
	}

	private clearPersisted(sessionId: string, spaceId?: string | null) {
		this.clearPersistTimer(sessionId);
		const resolvedSpaceId =
			spaceId ?? this.bySessionId[sessionId]?.spaceId ?? null;
		if (!resolvedSpaceId) return;
		void sessionGenerationSnapshotsRepo
			.delete(resolvedSpaceId, sessionId)
			.catch(() => undefined);
	}

	private schedulePersist(state: SessionGenerationState) {
		if (!shouldPersistSnapshot(state) || !state.spaceId) {
			this.clearPersisted(state.sessionId, state.spaceId);
			return;
		}
		// Throttle rather than debounce: during streaming, patches arrive faster
		// than the debounce window, so a trailing-edge reset (clearTimeout +
		// setTimeout per patch) never fires and just burns timer churn on the
		// main thread. Keep the existing timer and let it read the latest state
		// from the store when it fires.
		if (this.persistTimers.has(state.sessionId)) return;
		const sessionId = state.sessionId;
		const userKey = this.userKey;
		const timer = setTimeout(() => {
			this.persistTimers.delete(sessionId);
			if (getCacheUserKey() !== userKey) return;
			const latest = this.bySessionId[sessionId];
			if (!latest) return;
			if (!shouldPersistSnapshot(latest) || !latest.spaceId) {
				this.clearPersisted(sessionId, latest.spaceId);
				return;
			}
			void sessionGenerationSnapshotsRepo
				.put(toSnapshotInput(latest))
				.catch(() => undefined);
		}, PERSIST_WRITE_DEBOUNCE_MS);
		this.persistTimers.set(sessionId, timer);
	}

	private setState(sessionId: string, state: SessionGenerationState) {
		this.ensureUser();
		this.bySessionId = {
			...this.bySessionId,
			[sessionId]: state,
		};
		this.schedulePersist(state);
	}

	get(sessionId: string | null | undefined): SessionGenerationState | null {
		// Reads stay pure: this method is also used inside Svelte derived state.
		if (!sessionId || this.userKey !== getCacheUserKey()) return null;
		return this.bySessionId[sessionId] ?? null;
	}

	isGenerating(sessionId: string | null | undefined): boolean {
		if (!sessionId) return false;
		const state = this.get(sessionId);
		return Boolean(state && !TERMINAL_STATUSES.has(state.status));
	}

	startPending(
		sessionId: string,
		input?: {
			requestId?: string | null;
			spaceId?: string | null;
			turnId?: string | null;
			finalizedPreview?: boolean;
		},
	) {
		const current = this.get(sessionId) ?? createIdleState(sessionId);
		const isDifferentTurn = Boolean(
			input?.turnId && current.turnId && input.turnId !== current.turnId,
		);
		if (current.status === "streaming" && !isDifferentTurn) return;
		this.setState(sessionId, {
			...current,
			sessionId,
			spaceId: input?.spaceId ?? current.spaceId ?? null,
			status: "pending",
			resumed: false,
			requestId: input?.requestId ?? current.requestId ?? null,
			error: null,
			errorCode: null,
			startedAt: current.startedAt ?? Date.now(),
			lastEventAt: Date.now(),
			contentBlocks: [],
			intermediateMessages: [],
			streamMessageId: null,
			messageOrdinal: null,
			anchorUserMessageId: null,
			truncatedStart: false,
			patchSeq: 0,
			turnId: input?.turnId ?? null,
			runtimePhase: null,
			runtimePhaseAt: null,
			llmRound: null,
			runtimeProvider: null,
			runtimeModel: null,
			finalizedPreview: false,
			lastPatchAt: null,
		});
	}

	resumePending(
		sessionId: string,
		input?: {
			spaceId?: string | null;
			turnId?: string | null;
			anchorUserMessageId?: string | null;
			finalizedPreview?: boolean;
		},
	) {
		const current = this.get(sessionId) ?? createIdleState(sessionId);
		if (current.status === "streaming") return;
		if (isPersistable(current)) return;
		// A stale active-turn hint must not downgrade a locally finished turn.
		if (!shouldResumePendingGeneration(current, input?.turnId)) return;
		// Resume from a terminal generation state (e.g. previous turn completed
		// and a queued follow-up became running). Always drop residual
		// preview/process data so the handoff intermediate from the previous
		// turn cannot paint onto the new turn.
		const turnSwitched = generationTurnChanged(current.turnId, input?.turnId);
		const residuals = emptyGenerationStreamResiduals<
			ContentBlock,
			StreamingIntermediateMessage
		>();
		this.setState(sessionId, {
			...current,
			sessionId,
			spaceId: input?.spaceId ?? current.spaceId ?? null,
			status: "pending",
			resumed: true,
			error: null,
			errorCode: null,
			startedAt: Date.now(),
			lastEventAt: Date.now(),
			...residuals,
			anchorUserMessageId: turnSwitched
				? (input?.anchorUserMessageId ?? null)
				: (input?.anchorUserMessageId ?? current.anchorUserMessageId ?? null),
			turnId: input?.turnId ?? current.turnId ?? null,
			runtimePhase: null,
			runtimePhaseAt: null,
			llmRound: null,
			runtimeProvider: null,
			runtimeModel: null,
			finalizedPreview: input?.finalizedPreview ?? false,
			lastPatchAt: null,
		});
	}

	applyProgress(
		sessionId: string,
		input: {
			spaceId?: string | null;
			contentBlocks: ContentBlock[];
			intermediateMessages?: StreamingIntermediateMessage[];
			streamMessageId?: string | null;
			messageOrdinal?: number | null;
			anchorUserMessageId?: string | null;
			truncatedStart?: boolean;
			patchSeq?: number;
			turnId?: string | null;
			finalizedPreview?: boolean;
			patchAt?: number | null;
		},
	) {
		const current = this.get(sessionId) ?? createIdleState(sessionId);
		const nextTurnId = input.turnId ?? current.turnId ?? null;
		// Cross-turn progress (queued follow-up auto-start, late final commit
		// from the previous turn, etc.) must not inherit residual process
		// history / stream identity from the prior turn. Without this the
		// timeline briefly renders the previous turn's output under the new
		// turn until the next real stream event arrives.
		const turnSwitched = generationTurnChanged(current.turnId, input.turnId);
		const residuals = resolveGenerationProgressResiduals(
			current,
			input,
			turnSwitched,
		);
		this.setState(sessionId, {
			...current,
			spaceId: input.spaceId ?? current.spaceId ?? null,
			status: "streaming",
			error: null,
			errorCode: null,
			startedAt: turnSwitched ? Date.now() : (current.startedAt ?? Date.now()),
			lastEventAt: Date.now(),
			contentBlocks: input.contentBlocks,
			...residuals,
			anchorUserMessageId: turnSwitched
				? (input.anchorUserMessageId ?? null)
				: (input.anchorUserMessageId ?? current.anchorUserMessageId ?? null),
			turnId: nextTurnId,
			runtimePhase: null,
			runtimePhaseAt: null,
			llmRound: null,
			runtimeProvider: null,
			runtimeModel: null,
			finalizedPreview: input.finalizedPreview ?? false,
			lastPatchAt: latestPatchAt(
				turnSwitched ? null : current.lastPatchAt,
				input.patchAt,
			),
		});
	}

	/**
	 * Archive a finished assistant round between tool loops.
	 * Clears the live streaming preview so the next round doesn't keep
	 * previous tools/text in contentBlocks while waiting/thinking.
	 *
	 * If the next round already started streaming, only fold the intermediate
	 * message — never wipe the newer preview.
	 */
	archiveIntermediateRound(
		sessionId: string,
		input: {
			intermediateMessages: StreamingIntermediateMessage[];
			archived?: StreamingIntermediateMessage | null;
			turnId?: string | null;
		},
	) {
		const current = this.get(sessionId) ?? createIdleState(sessionId);
		// Defense in depth: never fold an intermediate archive from turn A into
		// generation state that has already advanced to turn B (queued follow-up).
		if (generationTurnChanged(current.turnId, input.turnId)) {
			return;
		}
		const archived = input.archived ?? null;
		// Next assistant identity already advanced (even before first token) —
		// only fold history; never wipe the newer identity/patchSeq/preview.
		const previewAlreadyMovedOn = shouldPreserveLivePreviewOnArchive(
			{
				messageOrdinal: current.messageOrdinal,
				streamMessageId: current.streamMessageId,
			},
			archived,
		);
		const status =
			current.status === "idle" || current.status === "pending"
				? "streaming"
				: current.status;

		if (previewAlreadyMovedOn) {
			this.setState(sessionId, {
				...current,
				status,
				lastEventAt: Date.now(),
				intermediateMessages: input.intermediateMessages,
				turnId: input.turnId ?? current.turnId ?? null,
			});
			return;
		}

		this.setState(sessionId, {
			...current,
			status,
			error: null,
			errorCode: null,
			startedAt: current.startedAt ?? Date.now(),
			lastEventAt: Date.now(),
			// Drop the previous round from the live preview immediately.
			contentBlocks: [],
			intermediateMessages: input.intermediateMessages,
			streamMessageId: null,
			messageOrdinal: null,
			truncatedStart: false,
			// Agent restarts patchSeq per assistant message (baseSeq=0, seq=1).
			// Reset here so the next round's first patch isn't dropped as stale.
			patchSeq: 0,
			turnId: input.turnId ?? current.turnId ?? null,
			finalizedPreview: false,
		});
	}

	markRuntimePhase(
		sessionId: string,
		input: {
			phase: SessionGenerationRuntimePhase;
			at?: string | number | null;
			llmRound?: number | null;
			provider?: string | null;
			model?: string | null;
			spaceId?: string | null;
			turnId?: string | null;
			anchorUserMessageId?: string | null;
		},
	) {
		const current = this.get(sessionId) ?? createIdleState(sessionId);
		const atMs =
			typeof input.at === "number"
				? input.at
				: typeof input.at === "string"
					? Date.parse(input.at)
					: Date.now();
		const nextTurnId = input.turnId ?? current.turnId ?? null;
		// Lifecycle events are often the first signal that a queued follow-up
		// has started. Drop residual preview/process data from the previous
		// turn so the new turn does not render the old output.
		const turnSwitched = generationTurnChanged(current.turnId, input.turnId);
		const resumeFromTerminal = isTerminalStatus(current.status);
		const shouldResetResiduals = turnSwitched || resumeFromTerminal;
		const residuals = resolveGenerationStreamResiduals(
			current,
			shouldResetResiduals,
		);
		const nextStatus =
			current.status === "idle" || resumeFromTerminal || turnSwitched
				? "pending"
				: current.status;
		this.setState(sessionId, {
			...current,
			sessionId,
			spaceId: input.spaceId ?? current.spaceId ?? null,
			status: nextStatus,
			error: null,
			errorCode: null,
			startedAt: shouldResetResiduals
				? Date.now()
				: (current.startedAt ?? Date.now()),
			lastEventAt: Date.now(),
			...residuals,
			turnId: nextTurnId,
			anchorUserMessageId: turnSwitched
				? (input.anchorUserMessageId ?? null)
				: (input.anchorUserMessageId ?? current.anchorUserMessageId ?? null),
			runtimePhase: input.phase,
			runtimePhaseAt: Number.isFinite(atMs) ? atMs : Date.now(),
			llmRound:
				input.llmRound ?? (shouldResetResiduals ? null : current.llmRound),
			runtimeProvider:
				input.provider ??
				(shouldResetResiduals ? null : current.runtimeProvider),
			runtimeModel:
				input.model ?? (shouldResetResiduals ? null : current.runtimeModel),
			lastPatchAt: shouldResetResiduals ? null : (current.lastPatchAt ?? null),
		});
	}

	replaceTurnId(
		sessionId: string,
		input: { previousTurnId?: string | null; nextTurnId: string | null },
	) {
		const current = this.get(sessionId);
		if (!current) return;
		if (
			input.previousTurnId &&
			current.turnId &&
			current.turnId !== input.previousTurnId
		) {
			return;
		}
		this.setState(sessionId, {
			...current,
			turnId: input.nextTurnId,
			streamMessageId:
				current.streamMessageId && current.turnId && input.nextTurnId
					? current.streamMessageId.replace(
							`turn:${current.turnId}:`,
							`turn:${input.nextTurnId}:`,
						)
					: current.streamMessageId,
		});
	}

	complete(sessionId: string) {
		const current = this.get(sessionId) ?? createIdleState(sessionId);
		this.setState(sessionId, {
			...current,
			status: "completed",
			error: null,
			errorCode: null,
			lastEventAt: Date.now(),
			contentBlocks: [],
			intermediateMessages: current.intermediateMessages,
			streamMessageId: null,
			messageOrdinal: null,
			anchorUserMessageId: null,
			truncatedStart: false,
			patchSeq: current.patchSeq,
			turnId: current.turnId,
			runtimePhase: null,
			runtimePhaseAt: null,
			llmRound: null,
			runtimeProvider: null,
			runtimeModel: null,
			finalizedPreview: false,
		});
	}

	clearCompletedIntermediateHandoff(
		sessionId: string,
		input?: { turnId?: string | null },
	) {
		const current = this.get(sessionId);
		if (current?.status !== "completed") return;
		if (input?.turnId && current.turnId && current.turnId !== input.turnId) {
			return;
		}
		if (current.intermediateMessages.length === 0) return;
		this.setState(sessionId, {
			...current,
			intermediateMessages: [],
		});
	}

	fail(
		sessionId: string,
		error?: string | null,
		input?: { errorCode?: string | null },
	) {
		const current = this.get(sessionId) ?? createIdleState(sessionId);
		this.setState(sessionId, {
			...current,
			status: "failed",
			error: sanitizeError(error ?? current.error),
			errorCode: input?.errorCode ?? current.errorCode ?? null,
			lastEventAt: Date.now(),
			contentBlocks: [],
			intermediateMessages: [],
			streamMessageId: null,
			messageOrdinal: null,
			anchorUserMessageId: null,
			truncatedStart: false,
			patchSeq: current.patchSeq,
			turnId: current.turnId,
			runtimePhase: null,
			runtimePhaseAt: null,
			llmRound: null,
			runtimeProvider: null,
			runtimeModel: null,
			finalizedPreview: false,
		});
	}

	interrupt(sessionId: string) {
		const current = this.get(sessionId) ?? createIdleState(sessionId);
		this.setState(sessionId, {
			...current,
			status: "interrupted",
			error: null,
			errorCode: null,
			lastEventAt: Date.now(),
			contentBlocks: [],
			intermediateMessages: [],
			streamMessageId: null,
			messageOrdinal: null,
			anchorUserMessageId: null,
			truncatedStart: false,
			patchSeq: current.patchSeq,
			turnId: current.turnId,
			runtimePhase: null,
			runtimePhaseAt: null,
			llmRound: null,
			runtimeProvider: null,
			runtimeModel: null,
			finalizedPreview: false,
		});
	}

	clearError(sessionId: string | null | undefined) {
		if (!sessionId) return;
		const current = this.get(sessionId);
		if (!current?.error) return;
		this.setState(sessionId, {
			...current,
			error: null,
			errorCode: null,
		});
	}

	reset(sessionId: string | null | undefined) {
		this.ensureUser();
		if (!sessionId) return;
		const currentSpaceId = this.get(sessionId)?.spaceId ?? null;
		this.bySessionId = {
			...this.bySessionId,
			[sessionId]: createIdleState(sessionId),
		};
		this.clearPersisted(sessionId, currentSpaceId);
	}

	resetAll() {
		this.ensureUser();
		for (const sessionId of Object.keys(this.bySessionId)) {
			this.clearPersisted(sessionId);
		}
		for (const timer of this.persistTimers.values()) clearTimeout(timer);
		this.persistTimers.clear();
		this.bySessionId = {};
	}

	/** Release inactive-space memory, preserving server-derived recovery output. */
	releaseSpace(spaceId: string | null | undefined) {
		this.ensureUser();
		if (!spaceId) return;
		const { remaining, removedSessionIds } = removeGenerationStatesForSpace(
			this.bySessionId,
			spaceId,
		);
		for (const sessionId of removedSessionIds) {
			const state = this.bySessionId[sessionId];
			this.clearPersistTimer(sessionId);
			if (state && shouldPersistSnapshot(state)) {
				void sessionGenerationSnapshotsRepo
					.put(toSnapshotInput(state))
					.catch(() => undefined);
			}
		}
		this.bySessionId = remaining;
	}
}

export const sessionGenerationStore = new SessionGenerationStore();
