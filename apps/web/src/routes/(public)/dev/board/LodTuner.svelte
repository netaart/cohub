<script lang="ts">
import type { BoardLod } from "@neta-art/cohub/board/render";
import type {
	BoardDeviceTier,
	BoardStage,
	BoardStageStats,
} from "@neta-art/cohub/board/stage";
import { onDestroy } from "svelte";

let {
	lod = $bindable(),
	stage,
	tier,
}: {
	lod: BoardLod;
	stage: BoardStage | null;
	tier: BoardDeviceTier;
} = $props();

const FIELDS = [
	{ key: "media", label: "Media edge", min: 0, max: 64, step: 1, unit: "px" },
	{ key: "text", label: "Text size", min: 0, max: 16, step: 0.5, unit: "px" },
	{ key: "card", label: "Card edge", min: 0, max: 96, step: 2, unit: "px" },
	{ key: "live", label: "Live budget", min: 50, max: 4000, step: 50, unit: "" },
] as const;

let stats = $state<BoardStageStats | null>(null);
let fps = $state(0);
let p95 = $state(0);

const frames: number[] = [];
let last = performance.now();
let windowStart = last;
let frame = requestAnimationFrame(function measure(now) {
	frames.push(now - last);
	last = now;
	if (now - windowStart >= 1000) {
		const sorted = frames.toSorted((a, b) => a - b);
		fps = Math.round((frames.length * 1000) / (now - windowStart));
		p95 = sorted[Math.floor(sorted.length * 0.95)] ?? 0;
		frames.length = 0;
		windowStart = now;
		stats = stage?.stats() ?? null;
	}
	frame = requestAnimationFrame(measure);
});
onDestroy(() => cancelAnimationFrame(frame));

function set(key: keyof BoardLod, value: number) {
	lod = { ...lod, [key]: value };
	const url = new URL(location.href);
	url.searchParams.set(key, String(value));
	history.replaceState(history.state, "", url);
}
</script>

<aside class="lod-tuner" aria-label="Level of detail">
	{#each FIELDS as field (field.key)}
		<label>
			<span>{field.label}</span>
			<input
				type="range"
				min={field.min}
				max={field.max}
				step={field.step}
				value={lod[field.key]}
				oninput={(event) => set(field.key, Number(event.currentTarget.value))}
			/>
			<output>{lod[field.key]}{field.unit}</output>
		</label>
	{/each}
	<dl>
		<dt>Device</dt><dd>{tier}</dd>
		<dt>Frame</dt><dd>{fps} fps · p95 {p95.toFixed(1)} ms</dd>
		{#if stats}
			<dt>Stage</dt>
			<dd>
				p95 {stats.frame.p95.toFixed(1)} · max {stats.frame.max.toFixed(1)} ms
				/ {stats.interval.toFixed(1)}
			</dd>
			<dt>Cards</dt><dd>{stats.live} live · {stats.far} far</dd>
			<dt>Textures</dt>
			<dd>
				{stats.textures} ({stats.cooling} cooling) · {(stats.textureBytes / 2 ** 20).toFixed(0)} MB
			</dd>
			<dt>Pending</dt>
			<dd>
				{stats.loading} loads · {stats.prefetching} prefetch{stats.settling ? " · settling" : ""}
			</dd>
		{/if}
	</dl>
</aside>

<style>
	.lod-tuner {
		position: absolute;
		top: 44px;
		right: 8px;
		z-index: 50;
		display: grid;
		gap: 6px;
		width: 300px;
		padding: 10px 12px;
		border-radius: 8px;
		background: color-mix(in srgb, var(--bg-primary) 88%, transparent);
		box-shadow: 0 1px 8px rgb(0 0 0 / 0.2);
		font: 12px/1.4 ui-monospace, monospace;
		font-variant-numeric: tabular-nums;
		color: var(--text-primary);
	}
	label {
		display: grid;
		grid-template-columns: 84px 1fr 56px;
		align-items: center;
		gap: 8px;
	}
	input {
		min-width: 0;
	}
	output {
		text-align: right;
	}
	dl {
		display: grid;
		grid-template-columns: 64px 1fr;
		gap: 2px 8px;
		margin: 4px 0 0;
	}
	dt {
		color: var(--text-secondary);
	}
	dd {
		margin: 0;
	}
</style>
