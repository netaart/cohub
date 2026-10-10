<script lang="ts">
/**
 * Shared shell for /sessions, /sessions/new, /sessions/:id.
 * Keeps UserSessionsPage (and the Space workspace it hosts) mounted across
 * child navigations, so switching chats never remounts windows or panels.
 */
import type { Snippet } from "svelte";
import { page } from "$app/state";
import UserSessionsPage from "$lib/features/sessions/UserSessionsPage.svelte";

let { children }: { children: Snippet } = $props();

// Child +page loads supply sessionId / isNew / newChatSpaceId; layout owns the UI.
// Prefer newChatSpaceId over spaceId so draft targets never collide with app-layout
// workspace spaceId (which drives left-sidebar layout prefs).
const data = $derived({
	sessionId: (page.data.sessionId as string | null | undefined) ?? null,
	turnSequence: (page.data.turnSequence as string | null | undefined) ?? null,
	isNew: Boolean(page.data.isNew),
	spaceId:
		(page.data.newChatSpaceId as string | null | undefined) ??
		(page.data.spaceId as string | null | undefined) ??
		null,
});
</script>

<UserSessionsPage {data} />
{@render children()}
