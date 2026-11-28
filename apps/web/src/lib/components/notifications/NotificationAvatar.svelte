<script lang="ts">
import type { NotificationRecord } from "@neta-art/cohub";
import SpaceAvatar from "#lib/components/SpaceAvatar.svelte";
import UserAvatar from "#lib/components/UserAvatar.svelte";
import { spacesInbox } from "#lib/features/spaces/spaces-inbox.svelte.ts";

const {
	record,
	size = "md",
}: { record: NotificationRecord; size?: "sm" | "md" } = $props();

const actor = $derived(record.actors[0] ?? null);
const space = $derived(
	record.spaceId ? spacesInbox.find(record.spaceId) : undefined,
);
const failed = $derived(
	record.kind === "turn.finished" && record.payload.status === "failed",
);
</script>

<span class="relative shrink-0">
	{#if actor}
		<UserAvatar name={actor.displayName} avatarUrl={actor.avatarUrl} seed={actor.userUuid} {size} />
	{:else}
		<SpaceAvatar name={record.payload.spaceTitle} profile={space?.publicProfile} seed={record.spaceId} {size} />
	{/if}
	{#if record.kind === "turn.finished"}
		<span class="absolute -bottom-0.5 -right-0.5 h-2.5 w-2.5 rounded-full border-2 border-bg-primary {failed ? 'bg-error-soft' : 'bg-success-soft'}"></span>
	{/if}
</span>
