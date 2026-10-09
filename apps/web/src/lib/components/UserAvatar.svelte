<script lang="ts">
import { User } from "lucide-svelte";
import { avatarInitials } from "$lib/avatar-initials";
import { avatarImageUrl } from "$lib/avatar-url";
import Avatar, { type AvatarSize } from "$lib/components/Avatar.svelte";

type Props = {
	name?: string | null;
	avatarUrl?: string | null;
	seed?: string | null;
	size?: AvatarSize;
	class?: string;
	loading?: "eager" | "lazy";
};

let {
	name = null,
	avatarUrl = null,
	seed = null,
	size = "sm",
	class: className = "",
	loading = "lazy",
}: Props = $props();

const imageSize = $derived(size === "lg" ? "lg" : size === "md" ? "md" : "sm");
const mark = $derived(avatarInitials(name, "") || null);
</script>

<Avatar
	src={avatarImageUrl(avatarUrl, imageSize)}
	seed={seed?.trim() || name}
	{mark}
	{size}
	{loading}
	class={className}
>
	<User class="h-[55%] w-[55%]" />
</Avatar>
