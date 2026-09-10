import { translate } from "@/src/i18n/core";
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
		// Intermediate events belong to the execution trace, not the final reply slot.
		if (message.meta?.messageKind === "assistant_intermediate") continue;
		const turnId = message.meta?.turnId;
		if (typeof turnId === "string") {
			const key = `${turnId}:${message.role}`;
			const previous = byTurnRole.get(key);
			byTurnRole.set(key, previous ? {
				...previous,
				...message,
				meta: {
					...(previous.meta ?? {}),
					...(message.meta ?? {}),
					turnSequence: turnSequenceForMessage(message) ?? turnSequenceForMessage(previous),
				},
			} : message);
		} else {
			const index = result.findIndex((item) => item.id === message.id);
			if (index >= 0) result[index] = message;
			else result.push(message);
		}
	}
	result.push(...byTurnRole.values());
	const byId = new Map(result.map((message) => [message.id, message]));
	const merged = [...byId.values()];
	const confirmed = new Set<string>();
	for (const message of merged) {
		if (message.meta?.optimistic === true) continue;
		const clientMessageId = message.meta?.clientMessageId;
		if (typeof clientMessageId === "string") confirmed.add(`client:${clientMessageId}`);
		const sequence = turnSequenceForMessage(message);
		if (sequence !== null) confirmed.add(`seq:${sequence}:${message.role}`);
	}
	return merged
		.filter((message) => {
			if (message.meta?.optimistic !== true) return true;
			const clientMessageId = message.meta?.clientMessageId;
			if (typeof clientMessageId === "string" && confirmed.has(`client:${clientMessageId}`)) return false;
			const sequence = turnSequenceForMessage(message);
			return !(sequence !== null && confirmed.has(`seq:${sequence}:${message.role}`));
		})
		.sort((a, b) => a.sequence - b.sequence);
}

export function nextTurnSequence(
	turns: Pick<SessionTurnRecord, "sequence">[],
	messages: Pick<MessageRecord, "meta">[],
) {
	const fromTurns = turns.reduce((max, turn) => Math.max(max, turn.sequence), 0);
	const fromMessages = messages.reduce((max, message) => {
		const sequence = turnSequenceForMessage(message);
		return sequence !== null ? Math.max(max, sequence) : max;
	}, 0);
	return Math.max(fromTurns, fromMessages) + 1;
}

export function withFallbackUserContent(
	turn: SessionTurnRecord,
	content: ContentBlock[],
	text: string,
) {
	const existing = turn.userContent ?? [];
	const existingHasImage = existing.some((block) => block.type === "image");
	const fallbackHasImage = content.some((block) => block.type === "image");
	if (existingHasImage || !fallbackHasImage) return turn;
	return {
		...turn,
		userContent: content,
		userText: turn.userText?.trim() || text || turn.userText,
	};
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
	if (typeof value === "number" && Number.isInteger(value)) return value;
	const turn = message.meta?.turn;
	if (turn && typeof turn === "object" && "sequence" in turn && typeof turn.sequence === "number" && Number.isInteger(turn.sequence)) {
		return turn.sequence;
	}
	return null;
}

export function withTurnSequences(messages: MessageRecord[], turns: SessionTurnRecord[]) {
	const sequenceByTurnId = new Map(turns.map((turn) => [turn.id, turn.sequence]));
	return messages.map((message) => {
		if (turnSequenceForMessage(message) !== null) return message;
		const turnId = message.meta?.turnId;
		if (typeof turnId !== "string") return message;
		const sequence = sequenceByTurnId.get(turnId);
		if (sequence == null) return message;
		return { ...message, meta: { ...(message.meta ?? {}), turnSequence: sequence } };
	});
}

export function messageIndexForTurn(messages: Pick<MessageRecord, "role" | "meta">[], sequence: number) {
	const userIndex = messages.findIndex((message) => message.role === "user" && turnSequenceForMessage(message) === sequence);
	if (userIndex >= 0) return userIndex;
	return messages.findIndex((message) => turnSequenceForMessage(message) === sequence);
}

export function turnIndexPreview(turn: SessionTurnIndexItem) {
	const value = turn.userPreview || turn.assistantPreview || translate("turn.empty");
	return value.replace(/\s+/g, " ").trim();
}

/** Cached or in-flight threads must not look like a brand-new empty Chat. */
export function chatThreadPlaceholder(input: {
	messageCount: number;
	historyLoaded: boolean;
	error?: string | null;
	hasLiveActivity?: boolean;
}): "opening" | "empty" | null {
	if (input.messageCount > 0 || input.hasLiveActivity) return null;
	if (input.historyLoaded) return "empty";
	if (input.error) return null;
	return "opening";
}
