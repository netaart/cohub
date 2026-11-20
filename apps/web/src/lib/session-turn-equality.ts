import type { SessionTurnRecord } from "@cohub/protocol/model";

function areJsonValuesEqual(a: unknown, b: unknown) {
	if (a === b) return true;
	if (a == null || b == null) return a === b;
	if (typeof a !== "object" || typeof b !== "object") return false;
	return JSON.stringify(a) === JSON.stringify(b);
}

/** Cheap scalar fields first; only stringify nested payloads when needed. */
export function areSessionTurnRecordsEqual(
	current: SessionTurnRecord | null | undefined,
	next: SessionTurnRecord | null | undefined,
) {
	if (current === next) return true;
	if (!current || !next) return false;
	return (
		current.id === next.id &&
		current.sessionId === next.sessionId &&
		current.sequence === next.sequence &&
		current.status === next.status &&
		current.intent === next.intent &&
		current.userUuid === next.userUuid &&
		current.sourceSessionId === next.sourceSessionId &&
		current.sourceTurnId === next.sourceTurnId &&
		current.userText === next.userText &&
		current.assistantText === next.assistantText &&
		current.provider === next.provider &&
		current.model === next.model &&
		current.stopReason === next.stopReason &&
		current.errorMessage === next.errorMessage &&
		current.finalUsageIsTotal === next.finalUsageIsTotal &&
		current.startedAt === next.startedAt &&
		current.completedAt === next.completedAt &&
		current.durationMs === next.durationMs &&
		current.createdAt === next.createdAt &&
		current.updatedAt === next.updatedAt &&
		areJsonValuesEqual(current.userContent, next.userContent) &&
		areJsonValuesEqual(current.assistantContent, next.assistantContent) &&
		areJsonValuesEqual(current.finalUsage, next.finalUsage) &&
		areJsonValuesEqual(current.totalUsage, next.totalUsage) &&
		areJsonValuesEqual(current.summary, next.summary) &&
		areJsonValuesEqual(current.intermediateIndex, next.intermediateIndex) &&
		areJsonValuesEqual(current.intermediateSummary, next.intermediateSummary) &&
		areJsonValuesEqual(current.meta, next.meta) &&
		areJsonValuesEqual(current.authorProfile, next.authorProfile)
	);
}

export function areSessionTurnsEqual(
	currentTurns: SessionTurnRecord[],
	nextTurns: SessionTurnRecord[],
) {
	if (currentTurns.length !== nextTurns.length) return false;
	return currentTurns.every((turn, index) =>
		areSessionTurnRecordsEqual(turn, nextTurns[index]),
	);
}

export function preserveSessionTurnRefs(
	currentTurns: SessionTurnRecord[],
	nextTurns: SessionTurnRecord[],
): SessionTurnRecord[] {
	const currentById = new Map(currentTurns.map((turn) => [turn.id, turn]));
	let changed = currentTurns.length !== nextTurns.length;
	const turns = nextTurns.map((turn, index): SessionTurnRecord => {
		const current = currentById.get(turn.id);
		if (current && areSessionTurnRecordsEqual(current, turn)) {
			if (currentTurns[index] !== current) changed = true;
			return current;
		}
		if (currentTurns[index] !== turn) changed = true;
		return turn;
	});
	return changed ? turns : currentTurns;
}
