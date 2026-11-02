<script lang="ts">
import type { BoardAnimation, BoardKeyframe } from "@cohub/protocol";
import type { BoardKeyRef } from "@neta-art/cohub/board/editor";
import {
	ArrowUpRight,
	Camera,
	ChevronRight,
	Code,
	Diamond,
	Film,
	Frame,
	Image,
	Maximize2,
	Minus,
	PenLine,
	Plus,
	Sparkles,
	Square,
	Type,
} from "lucide-svelte";
import {
	boardGroupLabel,
	boardPropertyLabel,
} from "$lib/board/animation-labels";
import {
	type BoardDockSelection,
	type BoardTrackGroup,
	type BoardTrackRow,
	boardKeyId,
	boardRowState,
	boardRulerTicks,
	formatBoardTime,
	parseBoardKeyId,
	snapBoardTime,
} from "$lib/board/animation-timeline";
import { getLocale } from "$lib/i18n/locale.svelte";
import { m } from "$lib/paraglide/messages.js";

const {
	groups,
	animation,
	extent,
	time,
	selection,
	recordingTargets,
	isOpen,
	onToggleGroup,
	onFocusTarget,
	onSeek,
	onSelect,
	onKey,
	onMoveKeys,
	onMoveMarker,
	onAddMarker,
}: {
	groups: readonly BoardTrackGroup[];
	animation: BoardAnimation;
	extent: number;
	time: number;
	selection: BoardDockSelection;
	recordingTargets: ReadonlySet<string>;
	isOpen: (target: string) => boolean;
	onToggleGroup: (target: string) => void;
	onFocusTarget: (target: string) => void;
	onSeek: (at: number) => void;
	onSelect: (selection: BoardDockSelection) => void;
	onKey: (row: BoardTrackRow, on: boolean) => void;
	onMoveKeys: (keys: BoardKeyRef[], delta: number) => void;
	onMoveMarker: (from: number, to: number) => void;
	onAddMarker: (at: number) => void;
} = $props();

const PAD = 14;
const TAIL = 40;
const SNAP_PX = 6;
const DRAG_PX = 3;
const MAX_ZOOM = 400;

const locale = $derived(getLocale());

let scroller = $state<HTMLDivElement | null>(null);
let content = $state<HTMLDivElement | null>(null);
let viewport = $state(0);
let treeWidth = $state(0);
let zoom = $state(1);

const laneViewport = $derived(Math.max(80, viewport - treeWidth - PAD - TAIL));
const fit = $derived(laneViewport / Math.max(1, extent));
const scale = $derived(fit * zoom);
const laneWidth = $derived(extent * scale + PAD + TAIL);
const ticks = $derived(boardRulerTicks(scale, extent));

const selectedKeys = $derived(
	selection?.type === "keys" ? selection.ids : new Set<string>(),
);

type KeyDrag = {
	pointerId: number;
	startX: number;
	anchor: number;
	earliest: number;
	refs: BoardKeyRef[];
	candidates: number[];
	moved: boolean;
	delta: number;
};
type MarkerDrag = {
	pointerId: number;
	startX: number;
	candidates: number[];
	from: number;
	to: number;
	moved: boolean;
};
type Marquee = {
	pointerId: number;
	x0: number;
	y0: number;
	x1: number;
	y1: number;
	additive: boolean;
	moved: boolean;
};

let keyDrag = $state<KeyDrag | null>(null);
let markerDrag = $state<MarkerDrag | null>(null);
let marquee = $state<Marquee | null>(null);
let scrubbing = $state<{ pointerId: number; candidates: number[] } | null>(
	null,
);

function timeAt(clientX: number): number {
	const left = content?.getBoundingClientRect().left ?? 0;
	return Math.max(0, (clientX - left - treeWidth - PAD) / scale);
}

function contentPoint(event: PointerEvent) {
	const rect = content?.getBoundingClientRect();
	return {
		x: event.clientX - (rect?.left ?? 0),
		y: event.clientY - (rect?.top ?? 0),
	};
}

function allTimes(exclude: ReadonlySet<string>): number[] {
	const times = new Set<number>([0, animation.duration, Math.round(time)]);
	for (const marker of animation.markers) times.add(marker.at);
	for (const [trackId, track] of Object.entries(animation.tracks))
		for (const keyframe of track.keyframes)
			if (!exclude.has(boardKeyId({ trackId, at: keyframe.at })))
				times.add(keyframe.at);
	return [...times];
}

function snap(at: number, event: PointerEvent, candidates: number[]) {
	return event.altKey ? at : snapBoardTime(at, candidates, SNAP_PX / scale);
}

function pressKey(event: PointerEvent, ref: BoardKeyRef) {
	if (event.button !== 0) return;
	event.stopPropagation();
	const id = boardKeyId(ref);
	let ids = new Set(selectedKeys);
	if (event.shiftKey || event.metaKey || event.ctrlKey) {
		if (ids.has(id)) ids.delete(id);
		else ids.add(id);
	} else if (!ids.has(id)) ids = new Set([id]);
	onSelect(ids.size ? { type: "keys", ids } : null);
	if (!ids.has(id)) return;
	const refs = [...ids].map(parseBoardKeyId);
	scroller?.setPointerCapture(event.pointerId);
	keyDrag = {
		pointerId: event.pointerId,
		startX: event.clientX,
		anchor: ref.at,
		earliest: Math.min(...refs.map((entry) => entry.at)),
		refs,
		candidates: allTimes(ids),
		moved: false,
		delta: 0,
	};
}

function pressMarker(event: PointerEvent, at: number) {
	if (event.button !== 0) return;
	event.stopPropagation();
	onSelect({ type: "marker", at });
	scroller?.setPointerCapture(event.pointerId);
	markerDrag = {
		pointerId: event.pointerId,
		startX: event.clientX,
		candidates: allTimes(new Set()).filter(
			(candidate) =>
				!animation.markers.some((marker) => marker.at === candidate),
		),
		from: at,
		to: at,
		moved: false,
	};
}

function pressRuler(event: PointerEvent) {
	if (event.button !== 0) return;
	scroller?.setPointerCapture(event.pointerId);
	scrubbing = { pointerId: event.pointerId, candidates: allTimes(new Set()) };
	onSeek(snap(timeAt(event.clientX), event, scrubbing.candidates));
}

function pressLane(event: PointerEvent) {
	if (event.button !== 0) return;
	scroller?.setPointerCapture(event.pointerId);
	const point = contentPoint(event);
	marquee = {
		pointerId: event.pointerId,
		x0: point.x,
		y0: point.y,
		x1: point.x,
		y1: point.y,
		additive: event.shiftKey || event.metaKey || event.ctrlKey,
		moved: false,
	};
}

function move(event: PointerEvent) {
	if (keyDrag?.pointerId === event.pointerId) {
		const dx = event.clientX - keyDrag.startX;
		if (!keyDrag.moved && Math.abs(dx) < DRAG_PX) return;
		keyDrag.moved = true;
		const target = snap(keyDrag.anchor + dx / scale, event, keyDrag.candidates);
		keyDrag.delta = Math.round(
			Math.max(target - keyDrag.anchor, -keyDrag.earliest),
		);
	} else if (markerDrag?.pointerId === event.pointerId) {
		const dx = event.clientX - markerDrag.startX;
		if (!markerDrag.moved && Math.abs(dx) < DRAG_PX) return;
		markerDrag.moved = true;
		markerDrag.to = Math.round(
			snap(
				Math.max(0, markerDrag.from + dx / scale),
				event,
				markerDrag.candidates,
			),
		);
	} else if (marquee?.pointerId === event.pointerId) {
		const point = contentPoint(event);
		marquee.x1 = point.x;
		marquee.y1 = point.y;
		marquee.moved ||=
			Math.hypot(point.x - marquee.x0, point.y - marquee.y0) >= DRAG_PX;
	} else if (scrubbing?.pointerId === event.pointerId) {
		onSeek(snap(timeAt(event.clientX), event, scrubbing.candidates));
	}
}

function release(event: PointerEvent) {
	if (keyDrag?.pointerId === event.pointerId) {
		const drag = keyDrag;
		keyDrag = null;
		if (drag.moved && drag.delta !== 0) onMoveKeys(drag.refs, drag.delta);
		else if (!drag.moved && drag.refs.length === 1) onSeek(drag.anchor);
	} else if (markerDrag?.pointerId === event.pointerId) {
		const drag = markerDrag;
		markerDrag = null;
		if (drag.moved && drag.to !== drag.from) onMoveMarker(drag.from, drag.to);
		else onSeek(drag.from);
	} else if (marquee?.pointerId === event.pointerId) {
		const box = marquee;
		marquee = null;
		if (!box.moved) {
			if (!box.additive) onSelect(null);
			return;
		}
		const origin = content?.getBoundingClientRect();
		if (!origin) return;
		const left = origin.left + Math.min(box.x0, box.x1);
		const right = origin.left + Math.max(box.x0, box.x1);
		const top = origin.top + Math.min(box.y0, box.y1);
		const bottom = origin.top + Math.max(box.y0, box.y1);
		const ids = new Set(box.additive ? selectedKeys : []);
		for (const element of content?.querySelectorAll<HTMLElement>(
			"[data-key]",
		) ?? []) {
			const rect = element.getBoundingClientRect();
			const x = rect.left + rect.width / 2;
			const y = rect.top + rect.height / 2;
			if (x >= left && x <= right && y >= top && y <= bottom)
				ids.add(element.dataset.key as string);
		}
		onSelect(ids.size ? { type: "keys", ids } : null);
	} else if (scrubbing?.pointerId === event.pointerId) scrubbing = null;
}

function cancel(event: PointerEvent) {
	if (keyDrag?.pointerId === event.pointerId) keyDrag = null;
	if (markerDrag?.pointerId === event.pointerId) markerDrag = null;
	if (marquee?.pointerId === event.pointerId) marquee = null;
	if (scrubbing?.pointerId === event.pointerId) scrubbing = null;
}

function setZoom(next: number, clientX?: number) {
	const element = scroller;
	const clamped = Math.min(MAX_ZOOM, Math.max(1, next));
	if (!element || clamped === zoom) return;
	const anchor =
		clientX === undefined
			? element.getBoundingClientRect().left + treeWidth + laneViewport / 2
			: clientX;
	const at = timeAt(anchor);
	const before = at * scale;
	zoom = clamped;
	const after = at * fit * clamped;
	element.scrollLeft += after - before;
}

function wheel(event: WheelEvent) {
	if (!event.ctrlKey && !event.metaKey) return;
	event.preventDefault();
	setZoom(zoom * Math.exp(-event.deltaY * 0.0025), event.clientX);
}

function rowIcon(group: BoardTrackGroup) {
	if (group.kind === "camera") return Camera;
	if (group.kind === "animation") return Film;
	if (group.kind === "script") return Code;
	switch (group.itemType) {
		case "text":
			return Type;
		case "shape":
			return Square;
		case "image":
		case "video":
			return Image;
		case "frame":
			return Frame;
		case "arrow":
			return ArrowUpRight;
		case "draw":
			return PenLine;
		case "custom":
			return Code;
		default:
			return Sparkles;
	}
}

type Entry = { key: string; group: BoardTrackGroup; row: BoardTrackRow | null };

const entries = $derived.by(() => {
	const list: Entry[] = [];
	for (const group of groups) {
		list.push({ key: group.target, group, row: null });
		if (isOpen(group.target))
			for (const row of group.rows) list.push({ key: row.key, group, row });
	}
	return list;
});

let scrollTop = $state(0);
let viewHeight = $state(0);
let coarse = $state(false);
$effect(() => {
	const query = matchMedia("(pointer: coarse)");
	coarse = query.matches;
	const change = () => {
		coarse = query.matches;
	};
	query.addEventListener("change", change);
	return () => query.removeEventListener("change", change);
});
const rowHeight = $derived(coarse ? 34 : 24);
const OVERSCAN = 6;

const visible = $derived.by(() => {
	const first = Math.max(0, Math.floor(scrollTop / rowHeight) - OVERSCAN);
	const last = Math.min(
		entries.length,
		Math.ceil((scrollTop + viewHeight) / rowHeight) + OVERSCAN,
	);
	return {
		before: first,
		entries: entries.slice(first, last),
		after: entries.length - last,
	};
});

function tracksOf(row: BoardTrackRow) {
	return [
		...(row.trackId
			? [{ trackId: row.trackId, keyframes: row.keyframes, layer: false }]
			: []),
		...row.layers.map((layer) => ({ ...layer, layer: true })),
	];
}

function segmentSelected(trackId: string, keyframe: BoardKeyframe) {
	return (
		selection?.type === "segment" &&
		selection.key.trackId === trackId &&
		selection.key.at === keyframe.at
	);
}
</script>

<div
	bind:this={scroller}
	bind:clientWidth={viewport}
	bind:clientHeight={viewHeight}
	role="presentation"
	onscroll={(event) => { scrollTop = event.currentTarget.scrollTop; }}
	class="lanes"
	class:lanes--dragging={keyDrag?.moved}
	style:--pad="{PAD}px"
	style:--scale={scale}
	style:--time={time}
	style:--drag={keyDrag?.moved ? keyDrag.delta : 0}
	onpointermove={move}
	onpointerup={release}
	onpointercancel={cancel}
	onwheel={wheel}
>
	<div bind:this={content} class="lanes-content" style:width="calc({treeWidth}px + {laneWidth}px)">
		<div class="row row--ruler">
			<div class="label label--corner" bind:clientWidth={treeWidth}>
				<button type="button" class="zoom-key" title={m.board_zoom_out({}, { locale })} aria-label={m.board_zoom_out({}, { locale })} disabled={zoom <= 1} onclick={() => setZoom(zoom / 1.6)}><Minus class="h-3 w-3" /></button>
				<button type="button" class="zoom-key" title={m.board_timeline_fit({}, { locale })} aria-label={m.board_timeline_fit({}, { locale })} disabled={zoom === 1} onclick={() => setZoom(1)}><Maximize2 class="h-3 w-3" /></button>
				<button type="button" class="zoom-key" title={m.board_zoom_in({}, { locale })} aria-label={m.board_zoom_in({}, { locale })} onclick={() => setZoom(zoom * 1.6)}><Plus class="h-3 w-3" /></button>
			</div>
			<div
				class="lane ruler"
				role="slider"
				tabindex="-1"
				aria-label={m.board_playhead({}, { locale })}
				aria-valuemin={0}
				aria-valuemax={extent}
				aria-valuenow={Math.round(time)}
				aria-valuetext={formatBoardTime(time)}
				onpointerdown={pressRuler}
				ondblclick={(event) => onAddMarker(Math.round(timeAt(event.clientX)))}
			>
				<div class="ruler-end" style:--at={animation.duration}></div>
				{#each ticks.times as at (at)}
					<span class="tick" style:--at={at}>{formatBoardTime(at, ticks.step)}</span>
				{/each}
				{#each animation.markers as marker, index (index)}
					{@const at = markerDrag?.from === marker.at && markerDrag.moved ? markerDrag.to : marker.at}
					<button
						type="button"
						class="marker"
						class:marker--pause={marker.pause}
						class:marker--selected={selection?.type === "marker" && selection.at === marker.at}
						style:--at={at}
						title={marker.label ? `${marker.label} · ${formatBoardTime(marker.at)}` : formatBoardTime(marker.at)}
						aria-label={marker.label ?? m.board_marker({}, { locale })}
						onpointerdown={(event) => pressMarker(event, marker.at)}
					>
						{#if marker.label}<span class="marker-label">{marker.label}</span>{/if}
					</button>
				{/each}
			</div>
		</div>

		<div style:height="{visible.before * rowHeight}px"></div>
		{#each visible.entries as entry (entry.key)}
			{#if entry.row}
				{@const row = entry.row}
				{@const state = boardRowState(row, time)}
				<div class="row" class:row--recording={recordingTargets.has(row.target) && row.keyable}>
					<div class="label label--property">
						<button
							type="button"
							class="key-toggle"
							data-state={state}
							disabled={!row.keyable}
							title={state === "keyed" ? m.board_track_keyframe_remove({}, { locale }) : m.board_track_keyframe_add({}, { locale })}
							aria-label={state === "keyed" ? m.board_track_keyframe_remove({}, { locale }) : m.board_track_keyframe_add({}, { locale })}
							aria-pressed={state === "keyed"}
							onclick={() => onKey(row, state !== "keyed")}
						>
							<Diamond class="h-3 w-3" fill={state === "none" ? "none" : "currentColor"} />
						</button>
						<span class="label-text" title={row.property}>{boardPropertyLabel(row.property, { locale })}</span>
					</div>
					<div class="lane" role="presentation" onpointerdown={pressLane}>
						<div class="lane-line"></div>
						{#each tracksOf(row) as track (track.trackId)}
							{#each track.keyframes as keyframe, index (index)}
								{@const previous = track.keyframes[index - 1]}
								{#if previous}
									<button
										type="button"
										class="segment"
										class:segment--selected={segmentSelected(track.trackId, keyframe)}
										class:segment--eased={keyframe.ease !== undefined && keyframe.ease !== "linear"}
										style:--from={previous.at}
										style:--to={keyframe.at}
										title={m.board_ease({}, { locale })}
										aria-label={m.board_ease({}, { locale })}
										onpointerdown={(event) => event.stopPropagation()}
										onclick={() => onSelect({ type: "segment", key: { trackId: track.trackId, at: keyframe.at } })}
									></button>
								{/if}
							{/each}
							{#each track.keyframes as keyframe, index (index)}
								{@const id = boardKeyId({ trackId: track.trackId, at: keyframe.at })}
								<button
									type="button"
									class="key"
									class:key--layer={track.layer}
									class:key--step={row.kind === "discrete"}
									data-key={id}
									data-selected={selectedKeys.has(id) || undefined}
									style:--at={keyframe.at}
									title="{boardPropertyLabel(row.property, { locale })} · {formatBoardTime(keyframe.at)}"
									aria-label="{boardPropertyLabel(row.property, { locale })} {formatBoardTime(keyframe.at)}"
									aria-pressed={selectedKeys.has(id)}
									onpointerdown={(event) => pressKey(event, { trackId: track.trackId, at: keyframe.at })}
								></button>
							{/each}
						{/each}
					</div>
				</div>
			{:else}
				{@const group = entry.group}
				{@const open = isOpen(group.target)}
				{@const Icon = rowIcon(group)}
				{@const label = boardGroupLabel(group, { locale })}
				<div class="row row--group" class:row--camera={group.kind === "camera"}>
					<div class="label">
						<button type="button" class="chevron" class:chevron--open={open} aria-expanded={open} aria-label={label} onclick={() => onToggleGroup(group.target)}>
							<ChevronRight class="h-3 w-3" />
						</button>
						<Icon class="h-3 w-3 shrink-0" />
						<button type="button" class="label-text" title={label} onclick={() => onFocusTarget(group.target)}>{label}</button>
					</div>
					<div class="lane" role="presentation" onpointerdown={pressLane}>
						<div class="lane-line"></div>
						{#if group.kind === "animation" && group.times.length > 1}
							<div class="clip" style:--from={group.times[0]} style:--to={group.times.at(-1)}>{label}</div>
						{/if}
						{#if !open}
							{#each group.times as at (at)}
								<span class="summary" style:--at={at}></span>
							{/each}
						{/if}
					</div>
				</div>
			{/if}
		{/each}
		<div style:height="{visible.after * rowHeight}px"></div>

		<div class="playhead" aria-hidden="true"></div>
		{#if marquee?.moved}
			<div
				class="marquee"
				style:left="{Math.min(marquee.x0, marquee.x1)}px"
				style:top="{Math.min(marquee.y0, marquee.y1)}px"
				style:width="{Math.abs(marquee.x1 - marquee.x0)}px"
				style:height="{Math.abs(marquee.y1 - marquee.y0)}px"
			></div>
		{/if}
	</div>
</div>

<style>
	.lanes {
		--tree: 188px;
		position: relative;
		min-height: 0;
		flex: 1;
		overflow: auto;
		overscroll-behavior: contain;
		scrollbar-width: thin;
		touch-action: pan-y;
		user-select: none;
	}
	.lanes-content {
		position: relative;
		min-width: 100%;
		padding-bottom: 8px;
	}

	.row {
		display: flex;
		height: 24px;
	}
	.row--ruler {
		position: sticky;
		top: 0;
		z-index: 4;
		height: 34px;
		border-bottom: 1px solid var(--border-subtle);
		background: var(--bg-elevated);
	}
	.row--group .label { color: var(--text-primary); }
	.row--camera .label { color: var(--brand-muted-fg); }

	.label {
		position: sticky;
		left: 0;
		z-index: 3;
		display: flex;
		flex: none;
		align-items: center;
		gap: 4px;
		width: var(--tree);
		min-width: 0;
		border-right: 1px solid var(--border-subtle);
		background: var(--bg-elevated);
		padding: 0 6px;
		color: var(--text-secondary);
		font-size: 11px;
	}
	.label--corner { justify-content: flex-end; gap: 2px; }
	.label--property { padding-left: 22px; color: var(--text-tertiary); }
	.row--recording .label--property { color: var(--error-500); }
	.row:not(.row--ruler):hover .label,
	.row:not(.row--ruler):hover .lane { background-color: color-mix(in srgb, var(--bg-hover) 55%, var(--bg-elevated)); }

	.label-text {
		min-width: 0;
		overflow: hidden;
		text-align: left;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	button.label-text:hover { color: var(--text-primary); }

	.chevron,
	.key-toggle,
	.zoom-key {
		display: inline-grid;
		flex: none;
		place-items: center;
		width: 18px;
		height: 18px;
		border-radius: 4px;
		color: var(--text-tertiary);
	}
	.chevron:hover,
	.key-toggle:hover:not(:disabled),
	.zoom-key:hover:not(:disabled) { background: var(--bg-hover); color: var(--text-primary); }
	.zoom-key:disabled,
	.key-toggle:disabled { opacity: 0.35; }
	.chevron :global(svg) { transition: rotate 120ms ease; }
	.chevron--open :global(svg) { rotate: 90deg; }
	.key-toggle[data-state="animated"] { color: var(--text-secondary); }
	.key-toggle[data-state="keyed"] { color: var(--brand); }
	.row--recording .key-toggle { color: var(--error-500); }

	.lane {
		position: relative;
		flex: none;
		width: calc(100% - var(--tree));
		min-width: 0;
		flex-grow: 1;
	}
	.lane-line {
		position: absolute;
		top: 50%;
		right: 0;
		left: 0;
		height: 1px;
		background: color-mix(in srgb, var(--border-subtle) 70%, transparent);
	}

	.ruler { cursor: ew-resize; touch-action: none; }
	.ruler-end {
		position: absolute;
		top: 0;
		right: 0;
		bottom: 0;
		left: calc(var(--pad) + var(--at) * var(--scale) * 1px);
		background: color-mix(in srgb, var(--text-primary) 4%, transparent);
	}
	.tick {
		position: absolute;
		top: 0;
		bottom: 0;
		left: calc(var(--pad) + var(--at) * var(--scale) * 1px);
		border-left: 1px solid var(--border-subtle);
		padding: 2px 0 0 3px;
		color: var(--text-tertiary);
		font-family: var(--font-mono);
		font-size: 10px;
		font-variant-numeric: tabular-nums;
		pointer-events: none;
	}

	.marker {
		position: absolute;
		bottom: 2px;
		left: calc(var(--pad) + var(--at) * var(--scale) * 1px);
		display: flex;
		align-items: center;
		height: 12px;
		min-width: 9px;
		translate: -4.5px 0;
		border-radius: 2px 2px 2px 0;
		background: var(--text-tertiary);
		cursor: grab;
		touch-action: none;
	}
	.marker--pause { background: var(--warning-500); }
	.marker--selected { outline: 2px solid var(--brand-ring); outline-offset: 1px; }
	.marker-label {
		max-width: 96px;
		overflow: hidden;
		padding: 0 4px;
		color: var(--bg-elevated);
		font-size: 9px;
		font-weight: 600;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.summary {
		position: absolute;
		top: 50%;
		left: calc(var(--pad) + var(--at) * var(--scale) * 1px);
		width: 5px;
		height: 5px;
		translate: -50% -50%;
		rotate: 45deg;
		background: var(--text-tertiary);
		pointer-events: none;
	}

	.clip {
		position: absolute;
		top: 4px;
		bottom: 4px;
		left: calc(var(--pad) + var(--from) * var(--scale) * 1px);
		width: calc((var(--to) - var(--from)) * var(--scale) * 1px);
		overflow: hidden;
		border-radius: 4px;
		background: color-mix(in srgb, var(--brand) 18%, transparent);
		padding: 1px 6px;
		color: var(--brand-muted-fg);
		font-size: 10px;
		text-overflow: ellipsis;
		white-space: nowrap;
		pointer-events: none;
	}

	.segment {
		position: absolute;
		top: 50%;
		left: calc(var(--pad) + var(--from) * var(--scale) * 1px);
		width: calc((var(--to) - var(--from)) * var(--scale) * 1px);
		height: 10px;
		translate: 0 -50%;
		cursor: pointer;
	}
	.segment::after {
		content: "";
		position: absolute;
		top: 50%;
		right: 0;
		left: 0;
		height: 2px;
		translate: 0 -50%;
		border-radius: 1px;
		background: color-mix(in srgb, var(--text-tertiary) 45%, transparent);
	}
	.segment--eased::after { background: color-mix(in srgb, var(--brand) 45%, transparent); }
	.segment:hover::after { background: var(--text-secondary); }
	.segment--selected::after,
	.segment--selected:hover::after { height: 4px; background: var(--brand); }

	.key {
		position: absolute;
		top: 50%;
		left: calc(var(--pad) + var(--at) * var(--scale) * 1px);
		z-index: 1;
		width: 9px;
		height: 9px;
		translate: -50% -50%;
		rotate: 45deg;
		border: 1.5px solid var(--bg-elevated);
		border-radius: 1.5px;
		background: var(--text-secondary);
		cursor: grab;
		touch-action: none;
	}
	.key::before {
		content: "";
		position: absolute;
		inset: -5px;
	}
	.key--step { rotate: 0deg; }
	.key--layer { background: transparent; border-color: var(--text-tertiary); }
	.key:hover { background: var(--text-primary); }
	.key[data-selected] { z-index: 2; background: var(--brand); }
	.lanes--dragging .key[data-selected] {
		translate: calc(-50% + var(--drag) * var(--scale) * 1px) -50%;
		cursor: grabbing;
	}

	.playhead {
		position: absolute;
		top: 0;
		bottom: 0;
		left: calc(var(--tree) + var(--pad) + var(--time) * var(--scale) * 1px);
		z-index: 2;
		width: 1px;
		background: var(--brand);
		pointer-events: none;
	}
	.playhead::before {
		content: "";
		position: absolute;
		top: 0;
		left: -5px;
		width: 11px;
		height: 8px;
		clip-path: polygon(0 0, 100% 0, 50% 100%);
		background: var(--brand);
	}

	.marquee {
		position: absolute;
		z-index: 5;
		border: 1px solid var(--brand);
		background: color-mix(in srgb, var(--brand) 10%, transparent);
		pointer-events: none;
	}

	@media (pointer: coarse) {
		.lanes { --tree: 132px; }
		.row { height: 34px; }
		.row--ruler { height: 38px; }
		.key { width: 13px; height: 13px; }
		.chevron, .key-toggle, .zoom-key { width: 28px; height: 28px; }
	}

	@media (prefers-reduced-motion: reduce) {
		.chevron :global(svg) { transition: none; }
	}
</style>
