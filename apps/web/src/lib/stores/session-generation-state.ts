export type GenerationStreamResiduals<TContent, TIntermediate> = {
	contentBlocks: TContent[];
	intermediateMessages: TIntermediate[];
	streamMessageId: string | null;
	messageOrdinal: number | null;
	truncatedStart: boolean;
	patchSeq: number;
	finalizedPreview: boolean;
};

export function generationTurnChanged(
	currentTurnId: string | null | undefined,
	nextTurnId: string | null | undefined,
) {
	return Boolean(currentTurnId && nextTurnId && currentTurnId !== nextTurnId);
}

/** Generation statuses that represent a finished turn (idle is resumable). */
export const TERMINAL_GENERATION_STATUSES = new Set([
	"completed",
	"failed",
	"interrupted",
]);

export function isTerminalGenerationStatus(status: string | null | undefined) {
	return Boolean(status && TERMINAL_GENERATION_STATUSES.has(status));
}

/**
 * Turn statuses that own a live generation stream. `queued` is deliberately
 * excluded: a queued turn is waiting for a slot, not producing output, so it
 * must never drive the generation state or be rendered as running.
 */
const LIVE_TURN_STATUSES = new Set(["running", "abort_requested"]);

export function isLiveTurnStatus(status: string | null | undefined) {
	return Boolean(status && LIVE_TURN_STATUSES.has(status));
}

export type GenerationReconcilePlan = {
	/** Drop the current live state before applying the hint. */
	reset: boolean;
	/** Turn id to resume live generation for, if any. */
	resumeTurnId: string | null;
};

/**
 * Decide how a session-list `activeTurn` hint should steer live generation.
 *
 * `activeTurn` is the newest unfinished turn, which can be `queued` behind a
 * running one. Only a live turn owns the generation state; a queued turn
 * belongs to the queue UI and is owned by turn data, so it must never be
 * resumed or mistaken for a replacement running turn.
 */
export function planGenerationReconcile(input: {
	current:
		| { status: string; turnId: string | null; lastEventAt?: number | null }
		| null
		| undefined;
	activeTurn: { id: string; status: string } | null | undefined;
	authoritative: boolean;
	requestStartedAt: number;
}): GenerationReconcilePlan {
	const keep: GenerationReconcilePlan = { reset: false, resumeTurnId: null };
	const current = input.current;
	const activeTurn = input.activeTurn;
	// Cached records without the hint cannot clear or restore generation.
	if (activeTurn === undefined) return keep;
	if (activeTurn) {
		if (!isLiveTurnStatus(activeTurn.status)) return keep;
		return {
			reset: Boolean(
				current &&
					current.turnId !== activeTurn.id &&
					current.status !== "idle",
			),
			resumeTurnId: activeTurn.id,
		};
	}
	return {
		reset:
			input.authoritative &&
			current?.status === "pending" &&
			(current.lastEventAt ?? 0) <= input.requestStartedAt,
		resumeTurnId: null,
	};
}

/**
 * A locally terminal generation for the same turn is the newest fact we own.
 * A stale `activeTurn` hint (list cache, background refresh) must never
 * downgrade it back to pending. New turns and idle states still resume.
 */
export function shouldResumePendingGeneration(
	current: { status: string; turnId?: string | null } | null | undefined,
	nextTurnId: string | null | undefined,
): boolean {
	if (!current) return true;
	return !(
		isTerminalGenerationStatus(current.status) &&
		current.turnId &&
		nextTurnId &&
		current.turnId === nextTurnId
	);
}

export function emptyGenerationStreamResiduals<
	TContent,
	TIntermediate,
>(): GenerationStreamResiduals<TContent, TIntermediate> {
	return {
		contentBlocks: [],
		intermediateMessages: [],
		streamMessageId: null,
		messageOrdinal: null,
		truncatedStart: false,
		patchSeq: 0,
		finalizedPreview: false,
	};
}

export function resolveGenerationStreamResiduals<TContent, TIntermediate>(
	current: GenerationStreamResiduals<TContent, TIntermediate>,
	reset: boolean,
): GenerationStreamResiduals<TContent, TIntermediate> {
	if (reset) return emptyGenerationStreamResiduals();
	return {
		contentBlocks: current.contentBlocks,
		intermediateMessages: current.intermediateMessages,
		streamMessageId: current.streamMessageId,
		messageOrdinal: current.messageOrdinal,
		truncatedStart: current.truncatedStart,
		patchSeq: current.patchSeq,
		finalizedPreview: current.finalizedPreview,
	};
}

export function resolveGenerationProgressResiduals<TIntermediate>(
	current: Omit<
		GenerationStreamResiduals<never, TIntermediate>,
		"contentBlocks" | "finalizedPreview"
	>,
	input: {
		intermediateMessages?: TIntermediate[];
		streamMessageId?: string | null;
		messageOrdinal?: number | null;
		truncatedStart?: boolean;
		patchSeq?: number;
	},
	turnChanged: boolean,
) {
	return {
		intermediateMessages:
			input.intermediateMessages ??
			(turnChanged ? [] : current.intermediateMessages),
		streamMessageId:
			input.streamMessageId !== undefined
				? input.streamMessageId
				: turnChanged
					? null
					: current.streamMessageId,
		messageOrdinal:
			input.messageOrdinal !== undefined
				? input.messageOrdinal
				: turnChanged
					? null
					: current.messageOrdinal,
		truncatedStart: turnChanged
			? (input.truncatedStart ?? false)
			: (input.truncatedStart ?? current.truncatedStart),
		patchSeq: turnChanged
			? (input.patchSeq ?? 0)
			: (input.patchSeq ?? current.patchSeq),
	};
}

export function removeGenerationStatesForSpace<
	T extends { spaceId?: string | null },
>(states: Record<string, T>, spaceId: string | null | undefined) {
	if (!spaceId) return { remaining: states, removedSessionIds: [] as string[] };

	const remaining: Record<string, T> = {};
	const removedSessionIds: string[] = [];
	for (const [sessionId, state] of Object.entries(states)) {
		if (state.spaceId === spaceId) {
			removedSessionIds.push(sessionId);
		} else {
			remaining[sessionId] = state;
		}
	}
	return { remaining, removedSessionIds };
}
