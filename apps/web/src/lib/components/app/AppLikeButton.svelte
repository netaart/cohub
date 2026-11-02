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
};

const { appId, count }: Props = $props();

const like = new ResourceLike(
	"app",
	untrack(() => appId),
	untrack(() => count),
);
$effect(() => like.setTotal(count));

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
	class="inline-flex h-9 shrink-0 cursor-pointer items-center gap-1.5 rounded-[5px] px-2 transition-colors hover:bg-bg-hover focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand/50 sm:h-7 sm:px-1.5 {like.liked
		? 'text-brand'
		: 'text-text-tertiary hover:text-text-primary'}"
	class:failed={like.failed}
	aria-pressed={like.liked}
	aria-label={m.app_like({}, { locale })}
	{title}
	onclick={() => void like.toggle()}
>
	{#key like.likes}
		<span class="flex" class:popping={like.likes > 0}>
			<Heart
				class="h-3.5 w-3.5 shrink-0"
				fill={like.liked ? "currentColor" : "none"}
				aria-hidden="true"
			/>
		</span>
	{/key}
	{#if countText}
		<span class="font-mono leading-none tabular-nums">{countText}</span>
	{/if}
</button>
<span class="sr-only" aria-live="polite"
	>{like.failed ? m.app_like_failed({}, { locale }) : ""}</span
>

<style>
	.popping {
		animation: like-pop 280ms cubic-bezier(0.34, 1.56, 0.64, 1);
	}

	.failed {
		animation: like-shake 320ms ease-in-out;
	}

	@keyframes like-pop {
		40% {
			transform: scale(1.3);
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
		.popping,
		.failed {
			animation: none;
		}
	}
</style>
