import { libraryInbox } from "$lib/features/library/library-inbox.svelte";
import { chatsInbox } from "$lib/features/sessions/chats-inbox.svelte";
import { spacesInbox } from "$lib/features/spaces/spaces-inbox.svelte";
import { syncStatus } from "$lib/sync/sync-status.svelte";

export function startLiveLists(): () => void {
	const stops = [
		syncStatus.start(),
		spacesInbox.start(),
		chatsInbox.start(),
		libraryInbox.start(),
	];
	return () => {
		for (const stop of stops.reverse()) stop();
	};
}
