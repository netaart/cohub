<script lang="ts">
import { untrack } from "svelte";
import type { BoardBezier } from "#lib/board/animation-timeline.ts";

const {
	curve,
	label,
	onChange,
}: {
	curve: BoardBezier;
	label: string;
	onChange: (curve: BoardBezier) => void;
} = $props();

const SIZE = 168;
const PAD = 16;
const SPAN = SIZE - PAD * 2;
const Y_MIN = -0.5;
const Y_SPAN = 2;

let draft = $state<BoardBezier>(untrack(() => curve));
let dragging = $state<0 | 1 | null>(null);
$effect(() => {
	const next = curve;
	if (dragging === null) draft = next;
});

const sx = (x: number) => PAD + x * SPAN;
const sy = (y: number) => PAD + (1 - (y - Y_MIN) / Y_SPAN) * SPAN;
const p0 = $derived({ x: sx(0), y: sy(0) });
const p3 = $derived({ x: sx(1), y: sy(1) });
const p1 = $derived({ x: sx(draft[0]), y: sy(draft[1]) });
const p2 = $derived({ x: sx(draft[2]), y: sy(draft[3]) });

function point(event: PointerEvent): [number, number] {
	const rect = (event.currentTarget as SVGElement)
		.closest("svg")
		?.getBoundingClientRect();
	if (!rect) return [0, 0];
	const x = ((event.clientX - rect.left) * (SIZE / rect.width) - PAD) / SPAN;
	const y =
		Y_MIN +
		(1 - ((event.clientY - rect.top) * (SIZE / rect.height) - PAD) / SPAN) *
			Y_SPAN;
	const round = (value: number) => Math.round(value * 100) / 100;
	return [
		round(Math.min(1, Math.max(0, x))),
		round(Math.min(2, Math.max(-1, y))),
	];
}

function press(event: PointerEvent, handle: 0 | 1) {
	event.preventDefault();
	(event.currentTarget as Element).setPointerCapture(event.pointerId);
	dragging = handle;
}

function move(event: PointerEvent) {
	if (dragging === null) return;
	const [x, y] = point(event);
	draft =
		dragging === 0 ? [x, y, draft[2], draft[3]] : [draft[0], draft[1], x, y];
}

function release() {
	if (dragging === null) return;
	dragging = null;
	onChange(draft);
}

function nudge(event: KeyboardEvent, handle: 0 | 1) {
	const step = event.shiftKey ? 0.1 : 0.01;
	const delta: Record<string, [number, number]> = {
		ArrowLeft: [-step, 0],
		ArrowRight: [step, 0],
		ArrowUp: [0, step],
		ArrowDown: [0, -step],
	};
	const change = delta[event.key];
	if (!change) return;
	event.preventDefault();
	event.stopPropagation();
	const index = handle * 2;
	const next = [...draft] as [number, number, number, number];
	next[index] =
		Math.round(Math.min(1, Math.max(0, next[index] + change[0])) * 100) / 100;
	next[index + 1] =
		Math.round(Math.min(2, Math.max(-1, next[index + 1] + change[1])) * 100) /
		100;
	draft = next;
	onChange(next);
}
</script>

<svg
	class="ease-curve"
	viewBox="0 0 {SIZE} {SIZE}"
	role="group"
	aria-label={label}
	onpointermove={move}
	onpointerup={release}
	onpointercancel={release}
>
	<rect class="frame" x={sx(0)} y={sy(1)} width={SPAN} height={sy(0) - sy(1)} />
	<line class="arm" x1={p0.x} y1={p0.y} x2={p1.x} y2={p1.y} />
	<line class="arm" x1={p3.x} y1={p3.y} x2={p2.x} y2={p2.y} />
	<path class="curve" d="M {p0.x} {p0.y} C {p1.x} {p1.y} {p2.x} {p2.y} {p3.x} {p3.y}" />
	{#each [p1, p2] as handle, index (index)}
		<circle
			class="handle"
			class:handle--active={dragging === index}
			cx={handle.x}
			cy={handle.y}
			r="6"
			role="slider"
			tabindex="0"
			aria-label="{label} {index + 1}"
			aria-valuenow={draft[index * 2]}
			aria-valuetext="{draft[index * 2]}, {draft[index * 2 + 1]}"
			onpointerdown={(event) => press(event, index as 0 | 1)}
			onkeydown={(event) => nudge(event, index as 0 | 1)}
		/>
	{/each}
</svg>

<style>
	.ease-curve {
		display: block;
		width: 168px;
		height: 168px;
		touch-action: none;
		user-select: none;
	}
	.frame {
		fill: color-mix(in srgb, var(--text-primary) 4%, transparent);
		stroke: var(--border-subtle);
	}
	.arm {
		stroke: var(--text-tertiary);
		stroke-width: 1;
	}
	.curve {
		fill: none;
		stroke: var(--brand);
		stroke-width: 2;
	}
	.handle {
		fill: var(--bg-elevated);
		stroke: var(--brand);
		stroke-width: 2;
		cursor: grab;
	}
	.handle--active,
	.handle:focus-visible {
		fill: var(--brand);
		outline: none;
	}
</style>
