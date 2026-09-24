<script lang="ts" module>
type Size = "xxs" | "xs" | "sm" | "md" | "lg";
type Tile = { box: string; pair: string; single: string };

/** A lone glyph (CJK, emoji, single letter) renders larger than a pair. */
const SIZES = {
	xxs: {
		box: "h-4 w-4 rounded-[5px]",
		pair: "text-[7px] font-semibold",
		single: "text-[9px] font-medium",
	},
	xs: {
		box: "h-5 w-5 rounded-[6px]",
		pair: "text-[8px] font-semibold",
		single: "text-[11px] font-medium",
	},
	sm: {
		box: "h-7 w-7 rounded-[8px]",
		pair: "text-[10px] font-semibold",
		single: "text-[14px] font-medium",
	},
	md: {
		box: "h-9 w-9 rounded-[10px]",
		pair: "text-[11px] font-semibold",
		single: "text-[16px] font-medium",
	},
	lg: {
		box: "h-12 w-12 rounded-[14px]",
		pair: "text-[13px] font-semibold",
		single: "text-[20px] font-medium",
	},
} as const satisfies Record<Size, Tile>;
</script>

<script lang="ts">
import type { SpacePublicProfile } from "@neta-art/cohub";
import { avatarInitials, isSingleGlyph } from "$lib/avatar-initials";
import { avatarImageUrl } from "$lib/avatar-url";

type Props = {
	name?: string | null;
	profile?: SpacePublicProfile | null;
	avatarUrl?: string | null;
	size?: Size;
	class?: string;
	loading?: "eager" | "lazy";
};

let {
	name = null,
	profile = null,
	avatarUrl = null,
	size = "sm",
	class: className = "",
	loading = "lazy",
}: Props = $props();

const mark = $derived(avatarInitials(name, "SP"));
const markClass = $derived(
	isSingleGlyph(mark) ? SIZES[size].single : SIZES[size].pair,
);

const rawAvatarUrl = $derived(
	avatarUrl?.trim() || profile?.avatarUrl?.trim() || null,
);
const imageSize = $derived(size === "lg" ? "lg" : size === "md" ? "md" : "sm");
const resolvedAvatarUrl = $derived(avatarImageUrl(rawAvatarUrl, imageSize));
</script>

<span
	class={`inline-flex shrink-0 items-center justify-center overflow-hidden border border-border-subtle bg-bg-elevated text-text-secondary shadow-[inset_0_1px_0_var(--color-border-subtle)] ${SIZES[size].box} ${className}`}
	aria-hidden="true"
>
	{#if resolvedAvatarUrl}
		<img src={resolvedAvatarUrl} alt="" class="h-full w-full object-cover" {loading} decoding="async" />
	{:else}
		<span class={`whitespace-nowrap leading-none tracking-[0.02em] ${markClass}`}>{mark}</span>
	{/if}
</span>
