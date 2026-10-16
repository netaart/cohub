import type { ChatMessage } from "./session-tree";

export function canForkChatMessage(message: ChatMessage): boolean {
	const turn = message.meta?.turn;
	if (
		!turn ||
		message.role !== "assistant" ||
		message.meta?.streaming === true ||
		!message.meta?.messageKind ||
		!["assistant_final", "assistant_error", "assistant_interrupted"].includes(
			message.meta.messageKind,
		)
	) {
		return false;
	}

	// Codex forks use the native turn history rather than a Cohub checkpoint.
	if (turn.meta?.harness === "codex") {
		return ["completed", "failed", "interrupted"].includes(turn.status);
	}

	const agent = turn.meta?.agent;
	const hasForkCheckpoint = Boolean(
		typeof turn.meta?.agentSessionEntryId === "string" ||
			(agent &&
				typeof agent === "object" &&
				!Array.isArray(agent) &&
				typeof (agent as Record<string, unknown>).leafEntryId === "string"),
	);
	return (
		hasForkCheckpoint ||
		(turn.executionKind === "direct_generation" &&
			["completed", "failed", "interrupted", "cancelled"].includes(turn.status))
	);
}
