<script lang="ts">
import type { SpacePublicProfile } from "@neta-art/cohub";
import { avatarInitials } from "$lib/avatar-initials";
import { avatarImageUrl } from "$lib/avatar-url";
import Avatar, { type AvatarSize } from "$lib/components/Avatar.svelte";

type Props = {
	name?: string | null;
	profile?: SpacePublicProfile | null;
	avatarUrl?: string | null;
	seed?: string | null;
	size?: AvatarSize;
	class?: string;
	loading?: "eager" | "lazy";
};

let {
	name = null,
	profile = null,
	avatarUrl = null,
	seed = null,
	size = "sm",
	class: className = "",
	loading = "lazy",
}: Props = $props();

const imageSize = $derived(size === "lg" ? "lg" : size === "md" ? "md" : "sm");
const rawAvatarUrl = $derived(
	avatarUrl?.trim() || profile?.avatarUrl?.trim() || null,
);
</script>

<Avatar
	src={avatarImageUrl(rawAvatarUrl, imageSize)}
	seed={seed?.trim() || name}
	mark={avatarInitials(name, "SP")}
	shape="tile"
	{size}
	{loading}
	class={className}
/>
