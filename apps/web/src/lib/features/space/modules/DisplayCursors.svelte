<script lang="ts" module>
import type { DisplayPointerKind } from "@neta-art/cohub";

export type DisplayCursorMark = {
	key: string;
	x: number;
	y: number;
	color: string;
	label?: string;
	kind?: DisplayPointerKind;
	seq?: number;
	agent?: boolean;
};

export type DisplayRect = {
	left: number;
	top: number;
	width: number;
	height: number;
};
</script>

<script lang="ts">
import { onDestroy, untrack } from "svelte";

const {
	rect,
	marks,
	scale = 1,
	idleMs = 3_000,
}: {
	rect: DisplayRect | null;
	marks: DisplayCursorMark[];
	scale?: number;
	idleMs?: number;
} = $props();

let faded = $state<Record<string, boolean>>({});
const timers = new Map<string, ReturnType<typeof setTimeout>>();
const stamps = new Map<string, string>();

$effect(() => {
	const current = marks.map((mark) => [mark.key, `${mark.x}|${mark.y}|${mark.seq ?? ""}`] as const);
	untrack(() => {
		for (const [key, stamp] of current) {
			if (stamps.get(key) === stamp) continue;
			stamps.set(key, stamp);
			clearTimeout(timers.get(key));
			if (faded[key]) faded = { ...faded, [key]: false };
			timers.set(key, setTimeout(() => (faded = { ...faded, [key]: true }), idleMs));
		}
		const live = new Set(current.map(([key]) => key));
		for (const key of [...stamps.keys()])
			if (!live.has(key)) {
				clearTimeout(timers.get(key));
				timers.delete(key);
				stamps.delete(key);
			}
	});
});

onDestroy(() => {
	for (const timer of timers.values()) clearTimeout(timer);
});
</script>

{#if rect}
	<div
		class="display-cursors"
		style:left="{rect.left}px"
		style:top="{rect.top}px"
		style:width="{rect.width}px"
		style:height="{rect.height}px"
		aria-hidden="true"
	>
		{#each marks as mark (mark.key)}
			<div
				class="display-cursor"
				class:is-agent={mark.agent}
				class:is-faded={faded[mark.key]}
				style:--cursor-color={mark.color}
				style:transform="translate3d({mark.x * rect.width}px, {mark.y * rect.height}px, 0) scale({1 / scale})"
			>
				{#if mark.agent && (mark.kind === "click" || mark.kind === "scroll")}
					{#key mark.seq}<span class="display-ripple"></span>{/key}
				{/if}
				<svg class="display-arrow" width="18" height="20" viewBox="0 0 18 20">
					<path d="M1.5 1.5 L1.5 16.2 L5.6 12.4 L8.3 18.3 L11 17.1 L8.4 11.3 L14 11.1 Z" />
				</svg>
				{#if mark.label}<span class="display-cursor-name">{mark.label}</span>{/if}
			</div>
		{/each}
	</div>
{/if}

<style>
	.display-cursors {
		position: absolute;
		pointer-events: none;
		overflow: visible;
	}
	.display-cursor {
		position: absolute;
		left: 0;
		top: 0;
		transform-origin: 0 0;
		transition:
			transform 90ms linear,
			opacity 300ms ease-out;
		will-change: transform;
	}
	.display-cursor.is-agent {
		transition:
			transform 280ms cubic-bezier(0.2, 0.8, 0.2, 1),
			opacity 300ms ease-out;
	}
	.display-cursor.is-faded {
		opacity: 0;
	}
	.display-arrow {
		display: block;
		filter: drop-shadow(0 1px 2px rgb(0 0 0 / 0.35));
	}
	.display-arrow path {
		fill: var(--cursor-color);
		stroke: var(--bg-primary);
		stroke-width: 1.5;
		stroke-linejoin: round;
	}
	.display-cursor-name {
		position: absolute;
		left: 14px;
		top: 16px;
		max-width: 140px;
		overflow: hidden;
		padding: 1px 6px;
		border-radius: 4px;
		background: var(--cursor-color);
		color: var(--bg-primary);
		font-size: 11px;
		line-height: 16px;
		white-space: nowrap;
		text-overflow: ellipsis;
	}
	.display-ripple {
		position: absolute;
		left: -14px;
		top: -14px;
		width: 28px;
		height: 28px;
		border: 2px solid var(--cursor-color);
		border-radius: 999px;
		opacity: 0;
		animation: display-ripple 520ms ease-out;
	}
	@keyframes display-ripple {
		from {
			opacity: 0.9;
			transform: scale(0.3);
		}
		to {
			opacity: 0;
			transform: scale(1.4);
		}
	}
	@media (prefers-reduced-motion: reduce) {
		.display-cursor,
		.display-cursor.is-agent {
			transition: opacity 300ms ease-out;
		}
		.display-ripple {
			animation: none;
			opacity: 0.6;
		}
	}
</style>
