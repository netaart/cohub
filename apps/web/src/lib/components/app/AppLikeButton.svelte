<script lang="ts">
import { Heart } from "lucide-svelte";
import { onMount, untrack } from "svelte";
import { ResourceLike } from "$lib/features/likes/resource-like.svelte";
import { formatCompactNumber, formatNumber } from "$lib/i18n/format";
import { getLocale } from "$lib/i18n/locale.svelte";
import { m } from "$lib/paraglide/messages.js";

type Props = {
	appId: string;
	count: number;
	likeSticker?: string | null;
};

const { appId, count, likeSticker = null }: Props = $props();

const BURST_DOTS = 6;
const pop = (tilt: number): Keyframe[] => [
	{ transform: `scale(0.3) rotate(${tilt}deg)` },
	{ transform: `scale(1.3) rotate(${tilt * -0.4}deg)`, offset: 0.45 },
	{ transform: "scale(0.92) rotate(0deg)", offset: 0.72 },
	{ transform: "scale(1) rotate(0deg)" },
];
const DIP: Keyframe[] = [
	{ transform: "scale(1)" },
	{ transform: "scale(0.78)", offset: 0.4 },
	{ transform: "scale(1)" },
];

const like = new ResourceLike(
	"app",
	untrack(() => appId),
	untrack(() => count),
);
$effect(() => like.setTotal(count));

let mark = $state<HTMLSpanElement>();
let failedSticker = $state<string | null>(null);
const sticker = $derived(
	likeSticker && likeSticker !== failedSticker ? likeSticker : null,
);

const reducedMotion = () =>
	window.matchMedia("(prefers-reduced-motion: reduce)").matches;

$effect(() => {
	const toggled = like.toggled;
	if (!toggled) return;
	untrack(() => {
		if (!mark || reducedMotion()) return;
		if (toggled.liked)
			mark.animate(pop(sticker ? -14 : 0), {
				duration: 460,
				easing: "cubic-bezier(0.2, 0.8, 0.3, 1)",
			});
		else mark.animate(DIP, { duration: 220, easing: "ease-out" });
	});
});

onMount(() => {
	void like.load();
	const stopWatching = like.watch();
	return () => {
		stopWatching();
		like.dispose();
	};
});

const locale = $derived(getLocale());
const countText = $derived(
	like.count > 0 ? formatCompactNumber(like.count, locale) : "",
);
const title = $derived(
	like.failed
		? m.app_like_failed({}, { locale })
		: like.count > 0
			? m.app_like_count_title(
					{ count: formatNumber(like.count, locale) },
					{ locale },
				)
			: m.app_like({}, { locale }),
);
</script>

<button
	type="button"
	class="like inline-flex h-9 shrink-0 cursor-pointer items-center gap-1.5 rounded-[5px] px-2 transition-colors hover:bg-bg-hover focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand/50 sm:h-7 sm:px-1.5 {like.liked
		? 'text-brand'
		: 'text-text-tertiary hover:text-text-primary'}"
	class:failed={like.failed}
	aria-pressed={like.liked}
	aria-label={m.app_like({}, { locale })}
	{title}
	onclick={() => void like.toggle()}
>
	<span class="relative flex items-center justify-center">
		{#key like.toggled}
			{#if like.toggled?.liked}
				<span class="burst" aria-hidden="true">
					<span class="ring"></span>
					{#each { length: BURST_DOTS }, index}
						<span class="dot" style:--turn="{index / BURST_DOTS + 1 / 12}turn"></span>
					{/each}
				</span>
			{/if}
		{/key}
		<span bind:this={mark} class="flex">
			{#if sticker}
				<img
					src={sticker}
					alt=""
					width="18"
					height="18"
					draggable="false"
					decoding="async"
					class="sticker h-[18px] w-[18px] shrink-0 object-contain"
					class:resting={!like.liked}
					onerror={() => (failedSticker = sticker)}
				/>
			{:else}
				<Heart
					class="h-3.5 w-3.5 shrink-0"
					fill={like.liked ? "currentColor" : "none"}
					aria-hidden="true"
				/>
			{/if}
		</span>
	</span>
	{#if countText}
		<span class="flex overflow-hidden">
			{#key like.toggled}
				<span
					class="font-mono leading-none tabular-nums"
					class:roll-up={like.toggled?.liked === true}
					class:roll-down={like.toggled?.liked === false}
					>{countText}</span
				>
			{/key}
		</span>
	{/if}
</button>
<span class="sr-only" aria-live="polite"
	>{like.failed ? m.app_like_failed({}, { locale }) : ""}</span
>

<style>
	.sticker {
		transition:
			filter 200ms ease,
			opacity 200ms ease;
	}

	.sticker.resting {
		filter: grayscale(1);
		opacity: 0.55;
	}

	.like:hover .sticker.resting {
		opacity: 0.8;
	}

	.burst {
		position: absolute;
		inset: 50% auto auto 50%;
		pointer-events: none;
	}

	.ring {
		position: absolute;
		width: 30px;
		height: 30px;
		margin: -15px;
		border: 2.5px solid currentColor;
		border-radius: 9999px;
		opacity: 0;
		animation: like-ring 400ms ease-out;
	}

	.dot {
		--reach: 17px;
		position: absolute;
		width: 5px;
		height: 5px;
		margin: -2.5px;
		border-radius: 9999px;
		background: currentColor;
		opacity: 0;
		animation: like-dot 560ms cubic-bezier(0.2, 0.7, 0.3, 1) 60ms;
	}

	.dot:nth-child(even) {
		--reach: 21px;
		width: 4px;
		height: 4px;
		margin: -2px;
		background: color-mix(in oklab, currentColor 60%, white);
	}

	.roll-up {
		animation: like-roll-up 240ms ease-out;
	}

	.roll-down {
		animation: like-roll-down 240ms ease-out;
	}

	.failed {
		animation: like-shake 320ms ease-in-out;
	}

	@keyframes like-ring {
		from {
			transform: scale(0.2);
			opacity: 0.9;
		}
		to {
			transform: scale(1.1);
			opacity: 0;
			border-width: 0;
		}
	}

	@keyframes like-dot {
		from {
			transform: rotate(var(--turn)) translateY(-6px) scale(1);
			opacity: 1;
		}
		65% {
			transform: rotate(var(--turn)) translateY(calc(var(--reach) * -0.92))
				scale(0.9);
			opacity: 1;
		}
		to {
			transform: rotate(var(--turn)) translateY(calc(var(--reach) * -1))
				scale(0);
			opacity: 0;
		}
	}

	@keyframes like-roll-up {
		from {
			transform: translateY(70%);
			opacity: 0;
		}
	}

	@keyframes like-roll-down {
		from {
			transform: translateY(-70%);
			opacity: 0;
		}
	}

	@keyframes like-shake {
		25% {
			transform: translateX(-2px);
		}
		75% {
			transform: translateX(2px);
		}
	}

	@media (prefers-reduced-motion: reduce) {
		.burst {
			display: none;
		}

		.roll-up,
		.roll-down,
		.failed {
			animation: none;
		}
	}
</style>
