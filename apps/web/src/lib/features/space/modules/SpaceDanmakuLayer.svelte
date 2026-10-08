<script lang="ts">
import { onMount } from "svelte";
import UserAvatar from "$lib/components/UserAvatar.svelte";
import { buildSpaceSessionTurnRoute } from "$lib/space-routes";
import type { SpaceDanmakuController } from "./space-danmaku-controller.svelte";

type Props = {
	controller: SpaceDanmakuController;
	spaceId: string;
	hidden?: boolean;
};
let { controller, spaceId, hidden = false }: Props = $props();

const items = $derived(controller.items);

function formatAge(value: string) {
	const elapsedMs = Date.now() - new Date(value).getTime();
	if (!Number.isFinite(elapsedMs) || elapsedMs < 60_000) return "now";
	const minutes = Math.floor(elapsedMs / 60_000);
	if (minutes < 60) return `${minutes}m`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return `${hours}h`;
	return `${Math.floor(hours / 24)}d`;
}

// Respect prefers-reduced-motion: render a calm fade-in-place instead of the
// horizontal fly-through. Initialized synchronously to avoid a first-frame flash.
let reducedMotion = $state(
	typeof window !== "undefined" &&
		window.matchMedia("(prefers-reduced-motion: reduce)").matches,
);

onMount(() => {
	const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
	const sync = () => {
		reducedMotion = mq.matches;
	};
	sync();
	mq.addEventListener("change", sync);
	return () => mq.removeEventListener("change", sync);
});
</script>

{#if !hidden && items.length > 0}
	<div class="danmaku-layer" class:reduced={reducedMotion}>
		{#each items as item (item.id)}
			<div
				class="danmaku-item"
				style="--lane: {item.lane}; --duration: {item.durationMs}ms"
			>
				<a
					class="danmaku-pill"
					href={buildSpaceSessionTurnRoute(spaceId, item.sessionId, item.sequence)}
					title="Open this message in {item.authorName}'s chat"
					aria-label="Open {item.authorName}'s message in its chat"
				>
					<UserAvatar
						name={item.authorName}
						avatarUrl={item.avatarUrl}
						seed={item.userUuid}
						size="xxs"
					/>
					<span class="danmaku-name">{item.authorName}</span>
					<span class="danmaku-sep" aria-hidden="true">·</span>
					<span class="danmaku-text">{item.text}</span>
					{#if item.source === "catchup"}
						<span class="danmaku-age">{formatAge(item.createdAt)}</span>
					{/if}
				</a>
			</div>
		{/each}
	</div>
{/if}

<style>
	/* The layer only exists while there are items to show — zero footprint
	   when idle. It overlays the workspace content but never captures
	   pointer events. */
	.danmaku-layer {
		position: absolute;
		inset: 0;
		z-index: var(--z-workspace-overlay);
		pointer-events: none;
		overflow: hidden;
		--lane-height: 42px;
	}

	.danmaku-item {
		position: absolute;
		left: 100%;
		top: calc(var(--lane) * var(--lane-height) + 12px);
		will-change: transform;
		animation: danmaku-fly var(--duration) linear forwards;
	}

	/* The pill is clickable even though the layer passes through pointer
	   events to the workspace beneath. Hover pauses the fly-through so the
	   user has a still target to click. */
	.danmaku-pill {
		pointer-events: auto;
		display: inline-flex;
		align-items: center;
		gap: 6px;
		max-width: min(420px, 60vw);
		padding: 3px 12px 3px 3px;
		border-radius: 999px;
		border: 1px solid var(--border-subtle);
		background: color-mix(in srgb, var(--bg-elevated) 80%, transparent);
		backdrop-filter: blur(10px);
		-webkit-backdrop-filter: blur(10px);
		box-shadow: 0 6px 18px
			color-mix(in srgb, var(--overlay-scrim-strong) 10%, transparent);
		font-size: 14px;
		line-height: 1.4;
		color: var(--text-secondary);
		white-space: nowrap;
		text-decoration: none;
		cursor: pointer;
		transition: border-color 120ms ease, box-shadow 120ms ease;
	}

	.danmaku-pill:hover {
		border-color: color-mix(in srgb, var(--brand) 40%, var(--border-subtle));
		box-shadow: 0 8px 22px
			color-mix(in srgb, var(--brand) 12%, transparent);
	}

	.danmaku-item:hover,
	.danmaku-item:focus-within {
		animation-play-state: paused;
	}

	/* Travel = item width (-100%) + viewport width (-100vw), so the item
	   enters from the right edge and fully exits the left edge. Pure
	   transform animation → GPU-composited, no layout work. */
	@keyframes danmaku-fly {
		from {
			transform: translateX(0);
		}
		to {
			transform: translateX(calc(-100% - 100vw));
		}
	}

	.danmaku-name {
		font-weight: 550;
		color: var(--text-tertiary);
		flex-shrink: 0;
		max-width: 110px;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.danmaku-sep {
		color: var(--text-tertiary);
		opacity: 0.5;
		flex-shrink: 0;
	}

	.danmaku-text {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		min-width: 0;
	}

	.danmaku-age {
		flex-shrink: 0;
		font-size: 10px;
		font-variant-numeric: tabular-nums;
		color: var(--text-placeholder);
	}

	/* Reduced motion: no horizontal travel, just a gentle fade in place
	   pinned to the right edge. */
	.danmaku-layer.reduced .danmaku-item {
		left: auto;
		right: 12px;
		animation-name: danmaku-fade;
	}

	@keyframes danmaku-fade {
		0% {
			opacity: 0;
			transform: translateY(4px);
		}
		12% {
			opacity: 1;
			transform: translateY(0);
		}
		82% {
			opacity: 1;
		}
		100% {
			opacity: 0;
		}
	}

	@media (max-width: 640px) {
		.danmaku-layer {
			--lane-height: 36px;
		}
		.danmaku-pill {
			max-width: min(280px, 72vw);
			font-size: 12px;
		}
		.danmaku-name {
			max-width: 80px;
		}
	}
</style>
