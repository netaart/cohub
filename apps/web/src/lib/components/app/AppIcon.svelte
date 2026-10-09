<script lang="ts">
import type { AppMeta } from "@neta-art/cohub";
import { appDisplayTitle, appIconUrl } from "$lib/app-page-meta";
import { avatarInitials } from "$lib/avatar-initials";
import Avatar, { type AvatarSize } from "$lib/components/Avatar.svelte";

type Props = {
	meta?: AppMeta | null;
	slug?: string | null;
	seed?: string | null;
	size?: AvatarSize;
	class?: string;
	loading?: "eager" | "lazy";
};

let {
	meta = null,
	slug = null,
	seed = null,
	size = "sm",
	class: className = "",
	loading = "lazy",
}: Props = $props();

const label = $derived(appDisplayTitle(meta, slug ?? "App"));
</script>

<Avatar
	src={appIconUrl(meta)}
	seed={seed?.trim() || slug || label}
	mark={avatarInitials(label, "A")}
	shape="tile"
	{size}
	{loading}
	class={className}
/>
