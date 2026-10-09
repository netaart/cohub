import { toSearchDisplayText } from "@cohub/protocol/search";
import type { SessionRecord } from "@neta-art/cohub";

const CHAT_TITLE_LIMIT = 120;

export function chatTitle(
	session:
		| Pick<SessionRecord, "title" | "latestMessageText">
		| null
		| undefined,
) {
	return (
		toSearchDisplayText(session?.title) ||
		toSearchDisplayText(session?.latestMessageText).slice(0, CHAT_TITLE_LIMIT)
	);
}

export function chatHref(
	spaceId: string,
	sessionId: string,
	sequence?: number,
) {
	const base = `/spaces/${spaceId}/sessions/${sessionId}`;
	return sequence === undefined ? base : `${base}?turn=${sequence}`;
}
