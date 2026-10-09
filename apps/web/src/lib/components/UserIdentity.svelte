<script lang="ts">
import type { AvatarSize } from "$lib/components/Avatar.svelte";
import UserAvatar from "$lib/components/UserAvatar.svelte";

type Props = {
	name: string;
	avatarUrl?: string | null;
	seed?: string | null;
	username?: string | null;
	/** Optional extra title text (e.g. uuid); always includes the display name. */
	title?: string | null;
	size?: AvatarSize;
	class?: string;
	avatarClass?: string;
	nameClass?: string;
	showName?: boolean;
};

let {
	name,
	avatarUrl = null,
	seed = null,
	username = null,
	title = null,
	size = "xxs",
	class: className = "",
	avatarClass = "border-0",
	nameClass = "min-w-0 truncate",
	showName = true,
}: Props = $props();
const resolvedTitle = $derived(
	[title?.trim() || name, username?.trim() ? `@${username.trim()}` : null]
		.filter(Boolean)
		.join(" · "),
);
</script>

<span
	class={`inline-flex min-w-0 max-w-full cursor-default items-center gap-1.5 ${className}`}
	title={resolvedTitle}
>
	<UserAvatar {name} {avatarUrl} {seed} {size} class={avatarClass} />
	{#if showName}
		<span class={nameClass}>{name}</span>
	{/if}
</span>
