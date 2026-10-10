import { createChatsWorkspaceScope } from "$lib/features/space/modules/workspace-scope";
import { chatsInbox, openNewChatSpacePicker } from "./chats-inbox.svelte";

export const chatsWorkspaceScope = createChatsWorkspaceScope({
	spaceOfSession: (sessionId) =>
		chatsInbox.findById(sessionId)?.spaceId ?? null,
	onActiveSession: (session, space) => chatsInbox.syncSession(session, space),
	onSessionForked: (session, fork) => chatsInbox.recordFork(session, fork),
	pickSpace: openNewChatSpacePicker,
	knownSpace: (spaceId) => chatsInbox.spaceSummary(spaceId),
	knownSession: (sessionId) => {
		const row = chatsInbox.findById(sessionId);
		if (!row) return null;
		// Keep the inbox-only Space summary out of the Space's caches.
		const { space: _space, ...session } = row;
		return session;
	},
});
