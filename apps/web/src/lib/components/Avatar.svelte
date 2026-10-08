<script lang="ts" module>
export type AvatarSize = "xxs" | "xs" | "sm" | "md" | "lg";
export type AvatarShape = "circle" | "tile";

type Scale = { box: string; tile: string; pair: string; single: string };

const SIZES = {
	xxs: {
		box: "h-4 w-4",
		tile: "rounded-[5px]",
		pair: "text-[7px] font-semibold",
		single: "text-[9px] font-medium",
	},
	xs: {
		box: "h-5 w-5",
		tile: "rounded-[6px]",
		pair: "text-[8px] font-semibold",
		single: "text-[11px] font-medium",
	},
	sm: {
		box: "h-7 w-7",
		tile: "rounded-[8px]",
		pair: "text-[11px] font-semibold",
		single: "text-[14px] font-medium",
	},
	md: {
		box: "h-9 w-9",
		tile: "rounded-[10px]",
		pair: "text-[13px] font-semibold",
		single: "text-[18px] font-medium",
	},
	lg: {
		box: "h-12 w-12",
		tile: "rounded-[14px]",
		pair: "text-[17px] font-semibold",
		single: "text-[24px] font-medium",
	},
} as const satisfies Record<AvatarSize, Scale>;

const MAX_IMAGE_FAILURES = 2;
</script>

<script lang="ts">
import type { Snippet } from "svelte";
import { isSingleGlyph } from "$lib/avatar-initials";
import { identityTone, identityToken } from "$lib/avatar-identity";

type Props = {
	src?: string | null;
	seed?: string | null;
	mark?: string | null;
	size?: AvatarSize;
	shape?: AvatarShape;
	class?: string;
	loading?: "eager" | "lazy";
	children?: Snippet;
};

let {
	src = null,
	seed = null,
	mark = null,
	size = "sm",
	shape = "circle",
	class: className = "",
	loading = "lazy",
	children,
}: Props = $props();

let failure = $state({ src: "", count: 0 });
const failures = $derived(failure.src === src ? failure.count : 0);
const showImage = $derived(Boolean(src) && failures < MAX_IMAGE_FAILURES);
const imageSrc = $derived(
	src && failures > 0
		? `${src}${src.includes("?") ? "&" : "?"}cohub_retry=${failures}`
		: src,
);

const scale = $derived(SIZES[size]);
const tone = $derived(showImage ? null : identityTone(seed));
</script>

<span
	class={`avatar inline-flex shrink-0 items-center justify-center overflow-hidden ${scale.box} ${shape === "tile" ? scale.tile : "rounded-full"} ${className}`}
	data-toned={tone ? "" : undefined}
	style:--avatar-tone={tone ? `var(${identityToken(tone)})` : undefined}
	aria-hidden="true"
>
	{#if showImage && imageSrc}
		<img
			src={imageSrc}
			alt=""
			class="h-full w-full object-cover"
			{loading}
			decoding="async"
			onerror={() => {
				failure = { src: src ?? "", count: failures + 1 };
			}}
		/>
	{:else if mark}
		<span class={`whitespace-nowrap leading-none tracking-[0.02em] ${isSingleGlyph(mark) ? scale.single : scale.pair}`}>{mark}</span>
	{:else}
		{@render children?.()}
	{/if}
</span>
