<script lang="ts">
import type { DisplayPlanLog, DisplayRecordingMeta } from "@neta-art/cohub";
import { DISPLAY_RECORDINGS_DIR, DISPLAY_TURNS_DIR } from "@neta-art/cohub";
import {
	ChevronLeft,
	ChevronRight,
	MousePointer2,
	Pause,
	Play,
} from "lucide-svelte";
import { onDestroy, untrack } from "svelte";
import { identityColor } from "$lib/avatar-identity";
import { getLocale } from "$lib/i18n/locale.svelte";
import { m } from "$lib/paraglide/messages.js";
import { sdk } from "$lib/sdk";
import DisplayCursors, {
	type DisplayCursorMark,
	type DisplayRect,
} from "./DisplayCursors.svelte";
import { containedRect } from "./display-input";
import {
	chapterAt,
	chaptersOf,
	formatClock,
	loadRecordings,
	loadTurnSteps,
} from "./display-replay";

const {
	spaceId,
	recording = null,
	turnId = null,
}: {
	spaceId: string;
	recording?: DisplayRecordingMeta | null;
	turnId?: string | null;
} = $props();

const POINTER_SHOWN_MS = 2_500;
const STEP_LEAD_MS = 400;

const locale = $derived(getLocale());
let meta = $state<DisplayRecordingMeta | null>(untrack(() => recording));
let plans = $state<Record<string, DisplayPlanLog[]>>({});
let loaded = $state(false);
let failed = $state(false);
const chapters = $derived(chaptersOf(Object.values(plans).flat()));
const files = $derived(meta?.files ?? []);
const start = $derived(meta?.since ?? chapters[0]?.at ?? 0);
const end = $derived(
	meta?.endedAt ?? Math.max(start, chapters.at(-1)?.at ?? start),
);

let video = $state<HTMLVideoElement | null>(null);
let image = $state<HTMLImageElement | null>(null);
let stage = $state<HTMLDivElement | null>(null);
let fileIndex = $state(0);
let src = $state<string | null>(null);
let stills = $state<Record<string, string | null>>({});
let wall = $state(0);
let playing = $state(false);
let showPointer = $state(true);
let selected = $state(-1);
let rect = $state<DisplayRect | null>(null);
let pendingSeek: number | null = null;
let frame = 0;
const urls = new Map<string, Promise<string | null>>();

const current = $derived(
	meta ? chapterAt(chapters, wall + STEP_LEAD_MS) : selected,
);
const chapter = $derived(chapters[current] ?? null);
const stillPlan = $derived(
	meta ? null : (chapter?.plan ?? chapters[0]?.plan ?? null),
);
const stillUrl = $derived(
	stillPlan?.image
		? (stills[`${stillPlan.turnId}/${stillPlan.image}`] ?? null)
		: null,
);
const marks = $derived.by((): DisplayCursorMark[] => {
	const point = chapter?.step.point;
	if (!showPointer || !point || (meta && wall - chapter.at > POINTER_SHOWN_MS))
		return [];
	return [
		{
			key: "agent",
			agent: true,
			x: point.x,
			y: point.y,
			kind: point.kind,
			seq: current,
			color: identityColor(chapter.plan.sessionId ?? chapter.plan.turnId),
		},
	];
});

$effect(() => {
	const id = turnId;
	const given = recording;
	untrack(() => void load(id, given));
});

async function load(id: string | null, given: DisplayRecordingMeta | null) {
	try {
		const turns = id ? [id] : (given?.turns ?? []);
		await Promise.all(
			turns.map((turn) =>
				loadTurnSteps(spaceId, turn, (value) => {
					plans = { ...plans, [turn]: value };
				}),
			),
		);
		const covering =
			id && !given
				? Object.values(plans)
						.flat()
						.find((plan) => plan.recording)?.recording
				: null;
		if (covering) {
			await loadRecordings(spaceId, (list, fresh) => {
				const found = list.find((item) => item.id === covering);
				if (!found) {
					if (fresh && meta) meta = null;
					return;
				}
				const first = !meta;
				meta = found;
				if (first)
					seek(Math.max(found.since, (chapters[0]?.at ?? found.since) - 1_000));
			}).catch(() => undefined);
		}
		if (!meta && selected < 0 && chapters.length) selected = 0;
	} catch {
		failed = true;
	} finally {
		loaded = true;
	}
}

function url(path: string) {
	let pending = urls.get(path);
	if (!pending) {
		pending = sdk
			.space(spaceId)
			.files.resolve(path, { purpose: "preview" })
			.then((file) => file?.url ?? null)
			.catch(() => null);
		urls.set(path, pending);
	}
	return pending;
}

$effect(() => {
	const file = files[fileIndex];
	const id = meta?.id;
	if (!file || !id) return;
	void url(`${DISPLAY_RECORDINGS_DIR}/${id}/${file.name}`).then((value) => {
		if (meta?.id === id && files[fileIndex] === file) src = value;
	});
});

$effect(() => {
	const plan = stillPlan;
	if (!plan?.image) return;
	const key = `${plan.turnId}/${plan.image}`;
	if (key in stills) return;
	void url(`${DISPLAY_TURNS_DIR}/${key}`).then((value) => {
		stills = { ...stills, [key]: value };
	});
});

function fileAt(at: number) {
	let index = 0;
	for (const [i, file] of files.entries()) if (file.at <= at) index = i;
	return index;
}

function seek(at: number) {
	const target = Math.min(Math.max(at, start), end);
	wall = target;
	if (!meta) return;
	const index = fileAt(target);
	const offset = (target - (files[index]?.at ?? start)) / 1000;
	if (index !== fileIndex || !video?.readyState) {
		fileIndex = index;
		pendingSeek = offset;
	} else if (video) video.currentTime = offset;
}

function onLoaded() {
	if (!video) return;
	if (pendingSeek !== null) video.currentTime = Math.max(0, pendingSeek);
	pendingSeek = null;
	measure();
	if (playing) void video.play().catch(() => (playing = false));
}

function tick() {
	frame = 0;
	const file = files[fileIndex];
	if (video && file) wall = file.at + video.currentTime * 1000;
	if (playing) frame = requestAnimationFrame(tick);
}

function toggle() {
	if (!video) return;
	if (video.paused) {
		if (wall >= end - 50) seek(start);
		playing = true;
		void video.play().catch(() => (playing = false));
		frame ||= requestAnimationFrame(tick);
	} else {
		video.pause();
	}
}

function onPause() {
	playing = false;
	tick();
}

function onEnded() {
	if (fileIndex + 1 >= files.length) return onPause();
	playing = true;
	fileIndex += 1;
	pendingSeek = 0;
}

function step(delta: number) {
	if (!chapters.length) return;
	jump(Math.min(chapters.length - 1, Math.max(0, current + delta)));
}

function jump(index: number) {
	const target = chapters[index];
	if (!target) return;
	if (meta) seek(target.at - STEP_LEAD_MS);
	else selected = index;
}

function measure() {
	const box = stage?.getBoundingClientRect();
	const media = meta ? video : image;
	if (!box || !media) return;
	const width =
		media instanceof HTMLVideoElement ? media.videoWidth : media.naturalWidth;
	const height =
		media instanceof HTMLVideoElement ? media.videoHeight : media.naturalHeight;
	rect = containedRect(
		{ left: 0, top: 0, width: box.width, height: box.height },
		width,
		height,
	);
}

$effect(() => {
	const element = stage;
	if (!element) return;
	const observer = new ResizeObserver(measure);
	observer.observe(element);
	return () => observer.disconnect();
});

function onKey(event: KeyboardEvent) {
	const target = event.target as HTMLElement | null;
	if (target?.closest("input, textarea, [contenteditable='true']")) return;
	if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
		event.preventDefault();
		step(event.key === "ArrowLeft" ? -1 : 1);
	} else if (event.key === " " && meta) {
		event.preventDefault();
		toggle();
	}
}

let scrubbing = false;
function scrub(event: PointerEvent) {
	const bar = event.currentTarget as HTMLElement;
	const box = bar.getBoundingClientRect();
	seek(start + ((event.clientX - box.left) / box.width) * (end - start));
}

function fraction(at: number) {
	return end > start
		? Math.min(1, Math.max(0, (at - start) / (end - start)))
		: 0;
}

function stepTitle(index: number) {
	const item = chapters[index];
	if (!item) return "";
	const { step } = item;
	if (step.label) return step.label;
	const name = step.target?.name
		? `“${step.target.name}”`
		: (step.target?.role ?? "");
	const verbs = {
		element: m.display_step_element({}, { locale }),
		input: m.display_step_input({}, { locale }),
		launch: m.display_step_launch({}, { locale }),
		open: m.display_step_open({}, { locale }),
		wait: m.display_step_wait({}, { locale }),
	};
	return [verbs[step.type] ?? step.type, name].filter(Boolean).join(" ");
}

const stopIndex = $derived.by(() => {
	const stops = new Map<string, number>();
	for (const [index, item] of chapters.entries())
		if (item.plan.stopped && item.index === item.plan.stopped.step)
			stops.set(item.plan.plan, index);
	return stops;
});

onDestroy(() => {
	if (frame) cancelAnimationFrame(frame);
});
</script>

<svelte:window onkeydown={onKey} />

<div class="replay">
	<div class="replay-main">
		<div bind:this={stage} class="replay-stage">
			{#if meta}
				{#if src}
					<!-- svelte-ignore a11y_media_has_caption -->
					<video
						bind:this={video}
						{src}
						class="replay-media"
						playsinline
						preload="auto"
						onloadedmetadata={onLoaded}
						onplay={() => { playing = true; frame ||= requestAnimationFrame(tick); }}
						onpause={onPause}
						onended={onEnded}
						onseeked={tick}
						onclick={toggle}
					></video>
				{/if}
			{:else if stillUrl}
				<img bind:this={image} src={stillUrl} alt="" class="replay-media" onload={measure} />
			{:else if loaded}
				<div class="replay-empty">{failed ? m.display_replay_unavailable({}, { locale }) : chapters.length ? m.display_replay_no_image({}, { locale }) : m.display_replay_empty({}, { locale })}</div>
			{/if}
			<DisplayCursors {rect} {marks} idleMs={POINTER_SHOWN_MS} />
			{#if chapter}
				<div class="replay-caption" class:is-stopped={stopIndex.get(chapter.plan.plan) === current}>
					{stepTitle(current)}
				</div>
			{/if}
		</div>

		<div class="replay-bar">
			<button type="button" class="replay-icon" aria-label={m.display_replay_previous({}, { locale })} title={m.display_replay_previous({}, { locale })} disabled={!chapters.length} onclick={() => step(-1)}><ChevronLeft class="h-4 w-4" /></button>
			{#if meta}
				<button type="button" class="replay-icon" aria-label={playing ? m.display_replay_pause({}, { locale }) : m.display_replay_play({}, { locale })} onclick={toggle}>
					{#if playing}<Pause class="h-4 w-4" />{:else}<Play class="h-4 w-4" />{/if}
				</button>
			{/if}
			<button type="button" class="replay-icon" aria-label={m.display_replay_next({}, { locale })} title={m.display_replay_next({}, { locale })} disabled={!chapters.length} onclick={() => step(1)}><ChevronRight class="h-4 w-4" /></button>
			{#if meta}
				<span class="replay-time">{formatClock(wall - start)} / {formatClock(end - start)}</span>
				<div
					class="replay-track"
					role="slider"
					tabindex="0"
					aria-label={m.display_replay_seek({}, { locale })}
					aria-valuemin={0}
					aria-valuemax={Math.round((end - start) / 1000)}
					aria-valuenow={Math.round((wall - start) / 1000)}
					onpointerdown={(event) => { scrubbing = true; (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId); scrub(event); }}
					onpointermove={(event) => scrubbing && scrub(event)}
					onpointerup={() => (scrubbing = false)}
					onpointercancel={() => (scrubbing = false)}
				>
					{#each meta.pauses as [from, to], index (index)}
						<span class="replay-pause" style:left="{fraction(from) * 100}%" style:width="{(fraction(to ?? end) - fraction(from)) * 100}%"></span>
					{/each}
					<span class="replay-progress" style:width="{fraction(wall) * 100}%"></span>
					{#each chapters as item, index (index)}
						<span class="replay-tick" class:is-stopped={stopIndex.get(item.plan.plan) === index} style:left="{fraction(item.at) * 100}%"></span>
					{/each}
				</div>
			{:else}
				<span class="replay-time">{chapters.length ? `${current + 1} / ${chapters.length}` : ""}</span>
				<span class="flex-1"></span>
			{/if}
			<button type="button" class="replay-icon" class:is-on={showPointer} aria-pressed={showPointer} aria-label={m.display_replay_pointer({}, { locale })} title={m.display_replay_pointer({}, { locale })} onclick={() => (showPointer = !showPointer)}><MousePointer2 class="h-4 w-4" /></button>
		</div>
	</div>

	{#if chapters.length}
		<ol class="replay-steps">
			{#each chapters as item, index (index)}
				{@const stopped = stopIndex.get(item.plan.plan) === index ? item.plan.stopped : null}
				<li>
					<button type="button" class="replay-step" class:is-current={index === current} onclick={() => jump(index)}>
						<span class="replay-step-time">{meta ? formatClock(item.at - start) : index + 1}</span>
						<span class="replay-step-title">{stepTitle(index)}</span>
						{#if stopped}
							<span class="tag" data-tone="warning">{stopped.reason}</span>
						{:else if item.step.effect === "none" && item.step.type !== "wait"}
							<span class="tag">{m.display_replay_no_change({}, { locale })}</span>
						{/if}
					</button>
				</li>
			{/each}
		</ol>
	{/if}
</div>

<style>
	.replay {
		display: grid;
		grid-template-columns: minmax(0, 1fr) 260px;
		height: min(78vh, 720px);
		min-height: 0;
	}
	.replay-main {
		display: flex;
		min-width: 0;
		min-height: 0;
		flex-direction: column;
		background: var(--bg-primary);
	}
	.replay-stage {
		position: relative;
		flex: 1;
		min-height: 0;
		overflow: hidden;
		background: var(--bg-content);
	}
	.replay-media {
		position: absolute;
		inset: 0;
		width: 100%;
		height: 100%;
		object-fit: contain;
	}
	.replay-empty {
		position: absolute;
		inset: 0;
		display: flex;
		align-items: center;
		justify-content: center;
		padding: 24px;
		color: var(--text-tertiary);
		font-size: 12px;
		text-align: center;
	}
	.replay-caption {
		position: absolute;
		left: 50%;
		bottom: 12px;
		max-width: calc(100% - 24px);
		overflow: hidden;
		padding: 5px 10px;
		border: 1px solid var(--border-subtle);
		border-radius: 7px;
		background: var(--bg-elevated);
		color: var(--text-secondary);
		font-size: 12px;
		white-space: nowrap;
		text-overflow: ellipsis;
		transform: translateX(-50%);
		pointer-events: none;
	}
	.replay-caption.is-stopped {
		border-color: var(--warning-700);
		color: var(--text-primary);
	}
	.replay-bar {
		display: flex;
		align-items: center;
		gap: 4px;
		padding: 6px 8px;
		border-top: 1px solid var(--border-subtle);
	}
	.replay-icon {
		display: inline-flex;
		width: 32px;
		height: 32px;
		flex: none;
		align-items: center;
		justify-content: center;
		border: 0;
		border-radius: 6px;
		background: none;
		color: var(--text-secondary);
		cursor: pointer;
	}
	.replay-icon:hover:not(:disabled) {
		background: var(--bg-hover);
		color: var(--text-primary);
	}
	.replay-icon:disabled {
		opacity: 0.4;
		cursor: default;
	}
	.replay-icon.is-on {
		color: var(--brand);
	}
	.replay-bar > .replay-icon:last-child {
		margin-left: auto;
	}
	.replay-icon:focus-visible,
	.replay-track:focus-visible,
	.replay-step:focus-visible {
		outline: 2px solid var(--brand);
		outline-offset: 1px;
	}
	.replay-time {
		flex: none;
		padding: 0 6px;
		color: var(--text-tertiary);
		font-size: 11px;
		font-variant-numeric: tabular-nums;
	}
	.replay-track {
		position: relative;
		flex: 1;
		height: 24px;
		cursor: pointer;
		touch-action: none;
	}
	.replay-track::before {
		position: absolute;
		top: 10px;
		right: 0;
		left: 0;
		height: 4px;
		border-radius: 2px;
		background: var(--bg-hover);
		content: "";
	}
	.replay-pause,
	.replay-progress {
		position: absolute;
		top: 10px;
		left: 0;
		height: 4px;
		border-radius: 2px;
	}
	.replay-pause {
		background: repeating-linear-gradient(90deg, var(--border-strong) 0 3px, transparent 3px 6px);
	}
	.replay-progress {
		background: var(--brand);
	}
	.replay-tick {
		position: absolute;
		top: 7px;
		width: 2px;
		height: 10px;
		margin-left: -1px;
		border-radius: 1px;
		background: var(--text-secondary);
	}
	.replay-tick.is-stopped {
		background: var(--warning-700);
	}
	.replay-steps {
		min-height: 0;
		margin: 0;
		padding: 6px;
		overflow-y: auto;
		border-left: 1px solid var(--border-subtle);
		list-style: none;
	}
	.replay-step {
		display: flex;
		width: 100%;
		min-height: 32px;
		align-items: center;
		gap: 8px;
		padding: 4px 8px;
		border: 0;
		border-radius: 6px;
		background: none;
		color: var(--text-secondary);
		font: inherit;
		font-size: 12px;
		text-align: left;
		cursor: pointer;
	}
	.replay-step:hover {
		background: var(--bg-hover);
	}
	.replay-step.is-current {
		background: var(--bg-hover);
		color: var(--text-primary);
	}
	.replay-step-time {
		flex: none;
		min-width: 34px;
		color: var(--text-placeholder);
		font-size: 11px;
		font-variant-numeric: tabular-nums;
	}
	.replay-step-title {
		min-width: 0;
		flex: 1;
		overflow: hidden;
		white-space: nowrap;
		text-overflow: ellipsis;
	}
	@media (max-width: 1023px) {
		.replay {
			grid-template-columns: minmax(0, 1fr);
			grid-template-rows: minmax(0, 1fr) minmax(96px, 32%);
			height: 82vh;
		}
		.replay-steps {
			border-top: 1px solid var(--border-subtle);
			border-left: 0;
		}
		.replay-icon {
			width: 44px;
			height: 44px;
		}
		.replay-bar {
			flex-wrap: wrap;
		}
		.replay-track {
			order: -1;
			flex-basis: 100%;
		}
	}
</style>
