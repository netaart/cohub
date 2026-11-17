import type {
	MessageToolCallsFile,
	StoredIntermediateMessage,
} from "@neta-art/cohub";
import { sdk } from "#lib/sdk.ts";

export async function loadTurnIntermediate(input: {
	spaceId: string;
	sessionId: string;
	turnId: string;
	messagesObjectKey: string | null;
}): Promise<StoredIntermediateMessage[]> {
	if (!input.messagesObjectKey) return [];
	const file = await sdk
		.space(input.spaceId)
		.session(input.sessionId)
		.turns.intermediate.get(input.turnId, input.messagesObjectKey);
	if (!file) return [];
	return file.messages.map((message) => ({
		...message,
		durationMs:
			typeof message.durationMs === "number" &&
			Number.isFinite(message.durationMs)
				? message.durationMs
				: null,
	}));
}

export async function loadMessageToolCalls(input: {
	spaceId: string;
	sessionId: string;
	turnId: string;
	message: StoredIntermediateMessage;
}): Promise<MessageToolCallsFile | null> {
	return sdk
		.space(input.spaceId)
		.session(input.sessionId)
		.turns.intermediate.getToolCalls(input.turnId, input.message);
}
