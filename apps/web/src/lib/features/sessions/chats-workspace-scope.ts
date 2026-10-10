import { createChatsWorkspaceScope } from "$lib/features/space/modules/workspace-scope";
import { sessionStore } from "$lib/stores/session-store";
import { chatsInbox, openNewChatSpacePicker } from "./chats-inbox.svelte";

export const chatsWorkspaceScope = createChatsWorkspaceScope({
	spaceOfSession: (sessionId) =>
		chatsInbox.findById(sessionId)?.spaceId ?? null,
	onActiveSession: (session, space) => chatsInbox.syncSession(session, space),
	onSessionForked: (session, fork) => chatsInbox.recordFork(session, fork),
	pickSpace: openNewChatSpacePicker,
	knownSpace: (spaceId) => chatsInbox.spaceSummary(spaceId),
	knownSession: (sessionId) => sessionStore.get(sessionId) ?? null,
});
