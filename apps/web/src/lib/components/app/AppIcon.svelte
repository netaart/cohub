<script lang="ts" module>
type Size = "xs" | "sm" | "md";
type Tile = { box: string; pair: string; single: string };

/**
 * `md` spans a two-line list row (16px title + 12px caption). A lone glyph
 * (CJK, emoji, single letter) renders larger than a two-letter pair.
 */
const SIZES = {
	xs: {
		box: "h-4 w-4 rounded-[4px]",
		pair: "text-[7px] font-semibold",
		single: "text-[9px] font-medium",
	},
	sm: {
		box: "h-5 w-5 rounded-[5px]",
		pair: "text-[8px] font-semibold",
		single: "text-[11px] font-medium",
	},
	md: {
		box: "h-7 w-7 rounded-[7px]",
		pair: "text-[11px] font-semibold",
		single: "text-[14px] font-medium",
	},
} as const satisfies Record<Size, Tile>;
</script>

<script lang="ts">
import type { AppMeta } from "@neta-art/cohub";
import { appDisplayTitle, appIconUrl } from "$lib/app-page-meta";
import { avatarInitials, isSingleGlyph } from "$lib/avatar-initials";

type Props = {
	meta?: AppMeta | null;
	slug?: string | null;
	size?: Size;
	class?: string;
	loading?: "eager" | "lazy";
};

let {
	meta = null,
	slug = null,
	size = "sm",
	class: className = "",
	loading = "lazy",
}: Props = $props();

const iconUrl = $derived(appIconUrl(meta));
const label = $derived(appDisplayTitle(meta, slug ?? "App"));

const mark = $derived(avatarInitials(label, "A"));
const markClass = $derived(
	isSingleGlyph(mark) ? SIZES[size].single : SIZES[size].pair,
);

/**
 * Transient CDN failures should not strand a row on the placeholder, but a
 * URL that is genuinely broken must not retry forever either. A short budget
 * of retries keeps the list calm while still healing a flaky first paint.
 */
const MAX_ICON_RETRIES = 2;
let failures = $state(0);
let attempt = $state(0);

// A different icon (space or app switch) always starts from a clean slate.
$effect(() => {
	iconUrl;
	failures = 0;
	attempt = 0;
});

const showIcon = $derived(Boolean(iconUrl) && failures < MAX_ICON_RETRIES);
const src = $derived(
	attempt > 0 && iconUrl
		? `${iconUrl}${iconUrl.includes("?") ? "&" : "?"}cohub_icon_retry=${attempt}`
		: iconUrl,
);
</script>

<span
	class={`inline-flex shrink-0 items-center justify-center overflow-hidden border border-border-subtle bg-bg-elevated text-text-tertiary ${SIZES[size].box} ${className}`}
	aria-hidden="true"
>
	{#if showIcon && src}
		<img
			{src}
			alt=""
			class="h-full w-full object-cover"
			{loading}
			decoding="async"
			onerror={() => {
				failures += 1;
				if (failures < MAX_ICON_RETRIES) attempt += 1;
			}}
		/>
	{:else}
		<span class={`whitespace-nowrap leading-none tracking-[0.02em] ${markClass}`}>{mark}</span>
	{/if}
</span>
