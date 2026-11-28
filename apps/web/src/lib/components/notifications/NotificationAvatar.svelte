<script lang="ts">
import type { Notice } from "@neta-art/cohub";
import SpaceAvatar from "#lib/components/SpaceAvatar.svelte";
import UserAvatar from "#lib/components/UserAvatar.svelte";
import { spacesInbox } from "#lib/features/spaces/spaces-inbox.svelte.ts";

const { notice, size = "md" }: { notice: Notice; size?: "sm" | "md" } =
	$props();

const actor = $derived(notice.actors[0] ?? null);
const space = $derived(
	notice.spaceId ? spacesInbox.find(notice.spaceId) : undefined,
);
const failed = $derived(
	notice.kind === "turn.finished" && notice.payload.status === "failed",
);
</script>

<span class="relative shrink-0">
	{#if actor}
		<UserAvatar name={actor.displayName} avatarUrl={actor.avatarUrl} seed={actor.userUuid} {size} />
	{:else}
		<SpaceAvatar name={notice.payload.spaceTitle} profile={space?.publicProfile} seed={notice.spaceId} {size} />
	{/if}
	{#if notice.kind === "turn.finished"}
		<span class="absolute -bottom-0.5 -right-0.5 h-2.5 w-2.5 rounded-full border-2 border-bg-primary {failed ? 'bg-error-soft' : 'bg-success-soft'}"></span>
	{/if}
</span>
