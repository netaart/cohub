import type {
	ContentBlock,
	MessageRecord,
	SessionTurnIndexItem,
	SessionTurnRecord,
} from "@neta-art/cohub";

function messageText(
	content: ContentBlock[] | null | undefined,
	fallback: string | null | undefined,
) {
	if (fallback?.trim()) return fallback;
	return (
		(content ?? [])
			.flatMap((block) => {
				if (block.type === "text") return [block.text];
				if (block.type === "thinking") return [block.thinking];
				return [];
			})
			.join("\n\n")
			.trim() || null
	);
}

function baseMessage(
	turn: SessionTurnRecord,
	role: MessageRecord["role"],
	id: string,
	sequence: number,
	content: ContentBlock[] | null,
	text: string | null,
): MessageRecord {
	return {
		id,
		sessionId: turn.sessionId,
		role,
		content: content ?? [],
		text,
		sequence,
		provider: role === "assistant" ? turn.provider : null,
		model: role === "assistant" ? turn.model : null,
		stopReason: role === "assistant" ? turn.stopReason : null,
		errorMessage: role === "assistant" ? turn.errorMessage : null,
		usage: role === "assistant" ? turn.finalUsage : null,
		meta: {
			...(turn.meta ?? {}),
			messageKind: role === "user" ? "turn_user" : "turn_assistant",
			turnId: turn.id,
			turnSequence: turn.sequence,
		},
		authorUuid: turn.userUuid,
		authorProfile: turn.authorProfile ?? null,
		startedAt: turn.startedAt,
		completedAt: turn.completedAt,
		durationMs: turn.durationMs,
		createdAt: turn.createdAt,
	};
}

/** Projects the Web turn representation into the existing mobile message renderer. */
export function messagesFromTurns(turns: SessionTurnRecord[]) {
	const messages: MessageRecord[] = [];
	for (const turn of turns) {
		const userContent = turn.userContent ?? [];
		const userText = messageText(userContent, turn.userText);
		if (userText || userContent.length > 0) {
			messages.push(
				baseMessage(
					turn,
					"user",
					`${turn.id}:user`,
					turn.sequence * 2 - 1,
					userContent,
					userText,
				),
			);
		}
		const assistantText = messageText(
			turn.assistantContent,
			turn.assistantText,
		);
		const hasAssistantState = Boolean(
			assistantText ||
				(turn.assistantContent?.length ?? 0) > 0 ||
				turn.errorMessage ||
				turn.status === "failed" ||
				turn.status === "interrupted",
		);
		if (hasAssistantState) {
			messages.push(
				baseMessage(
					turn,
					"assistant",
					`${turn.id}:assistant`,
					turn.sequence * 2,
					turn.assistantContent,
					assistantText,
				),
			);
		}
	}
	return messages.sort((a, b) => a.sequence - b.sequence);
}

/** Merges live message events over the projected turn history without duplicating a turn. */
export function mergeDisplayMessages(
	history: MessageRecord[],
	live: MessageRecord[],
) {
	const byTurnRole = new Map<string, MessageRecord>();
	const result: MessageRecord[] = [];
	for (const message of history) {
		const turnId = message.meta?.turnId;
		if (typeof turnId === "string")
			byTurnRole.set(`${turnId}:${message.role}`, message);
		else result.push(message);
	}
	for (const message of live) {
		const turnId = message.meta?.turnId;
		if (typeof turnId === "string") {
			byTurnRole.set(`${turnId}:${message.role}`, message);
		} else {
			const index = result.findIndex((item) => item.id === message.id);
			if (index >= 0) result[index] = message;
			else result.push(message);
		}
	}
	result.push(...byTurnRole.values());
	const byId = new Map(result.map((message) => [message.id, message]));
	return [...byId.values()].sort((a, b) => a.sequence - b.sequence);
}

export function mergeTurns(
	existing: SessionTurnRecord[],
	incoming: SessionTurnRecord[],
) {
	const bySequence = new Map<number, SessionTurnRecord>();
	for (const turn of existing) bySequence.set(turn.sequence, turn);
	for (const turn of incoming) bySequence.set(turn.sequence, turn);
	return [...bySequence.values()].sort((a, b) => a.sequence - b.sequence);
}

export function turnSequenceForMessage(message: Pick<MessageRecord, "meta">) {
	const value = message.meta?.turnSequence;
	return typeof value === "number" && Number.isInteger(value) ? value : null;
}

export function turnIndexPreview(turn: SessionTurnIndexItem) {
	const value = turn.userPreview || turn.assistantPreview || "Empty turn";
	return value.replace(/\s+/g, " ").trim();
}
