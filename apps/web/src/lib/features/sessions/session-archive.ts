import type { SessionRecord } from "@neta-art/cohub";
import { chatsInbox } from "#lib/features/sessions/chats-inbox.svelte.ts";
import { sdk } from "#lib/sdk.ts";
import { listCachedSession } from "#lib/stores/session-list-cache.ts";
import { sessionStore } from "#lib/stores/session-store.ts";

function applyArchivedAt(sessionId: string, archivedAt: string | null) {
	const current = sessionStore.get(sessionId);
	if (!current) return null;
	const record = sessionStore.merge({ ...current, archivedAt });
	chatsInbox.reflectArchive(record);
	return record;
}

export async function setSessionArchived(
	session: SessionRecord,
	archived: boolean,
): Promise<SessionRecord> {
	const previous = sessionStore.get(session.id)?.archivedAt ?? null;
	applyArchivedAt(session.id, archived ? new Date().toISOString() : null);
	try {
		const client = sdk.space(session.spaceId).session(session.id);
		const result = await (archived ? client.archive() : client.unarchive());
		const record = sessionStore.merge(result.session);
		chatsInbox.reflectArchive(record);
		if (!archived)
			void listCachedSession(record.spaceId, record).catch(() => undefined);
		return record;
	} catch (error) {
		applyArchivedAt(session.id, previous);
		throw error;
	}
}
