<script lang="ts" module>
import type { BoardKeyframeClip } from "@neta-art/cohub/board/editor";

let clipboard: BoardKeyframeClip | null = null;

const HEIGHT_KEY = "cohub:board:animation-dock-height";
const MIN_HEIGHT = 136;

function storedHeight(fallback: number): number {
	try {
		const value = Number(localStorage.getItem(HEIGHT_KEY));
		return Number.isFinite(value) && value >= MIN_HEIGHT ? value : fallback;
	} catch {
		return fallback;
	}
}
</script>

<script lang="ts">
import type {
	BoardPlaybackCommand,
	BoardPlaybackSnapshot,
} from "@cohub/protocol";
import type { BoardKeyRef } from "@neta-art/cohub/board/editor";
import {
	ChevronDown,
	Circle,
	Clapperboard,
	Ellipsis,
	Pause,
	Play,
	Plus,
	Scissors,
	Settings2,
	SkipBack,
	SkipForward,
	X,
} from "lucide-svelte";
import { untrack } from "svelte";
import { SvelteMap } from "svelte/reactivity";
import {
	type BoardDockSelection,
	type BoardTrackRow,
	boardAnimationExtent,
	boardKeyId,
	boardTrackGroups,
	formatBoardTime,
	parseBoardKeyId,
} from "$lib/board/animation-timeline";
import { createBoardAnimationTransport } from "$lib/board/board-animation-transport.svelte";
import type { BoardEditor } from "$lib/board/editor.svelte";
import BoardAnimationInspector from "$lib/components/board/BoardAnimationInspector.svelte";
import BoardAnimationLanes from "$lib/components/board/BoardAnimationLanes.svelte";
import BoardAnimationSettings from "$lib/components/board/BoardAnimationSettings.svelte";
import BoardMenu, {
	type BoardMenuItem,
} from "$lib/components/board/BoardMenu.svelte";
import BoardSequenceDialog from "$lib/components/board/BoardSequenceDialog.svelte";
import { getLocale } from "$lib/i18n/locale.svelte";
import { m } from "$lib/paraglide/messages.js";

const {
	editor,
	playback,
	isMobile = false,
	onPlayback,
	onDropResources,
	onClose,
}: {
	editor: BoardEditor;
	playback: BoardPlaybackSnapshot | null;
	isMobile?: boolean;
	onPlayback: (command: BoardPlaybackCommand) => unknown;
	onDropResources?: (data: DataTransfer, at: number) => void;
	onClose: () => void;
} = $props();

const locale = $derived(getLocale());
const transport = createBoardAnimationTransport({
	editor: untrack(() => editor),
	playback: () => playback,
	send: (command) => onPlayback(command),
	hold: true,
});
const animationId = $derived(transport.animationId);
const animation = $derived(transport.animation);
const time = $derived(transport.time);

let height = $state(untrack(() => storedHeight(isMobile ? 220 : 248)));
let root = $state<HTMLElement | null>(null);
let pickerAnchor = $state<HTMLButtonElement | null>(null);
let settingsAnchor = $state<HTMLButtonElement | null>(null);
let moreAnchor = $state<HTMLButtonElement | null>(null);
let menu = $state<"picker" | "settings" | "more" | null>(null);
let sequenceOpen = $state(false);
let selection = $state.raw<BoardDockSelection>(null);
let lanes = $state<ReturnType<typeof BoardAnimationLanes> | null>(null);
let dropAt = $state<number | null>(null);
const opened = new SvelteMap<string, boolean>();

const order = $derived.by(() => {
	const ranks = new Map<string, number>();
	editor.items.forEach((item, index) => {
		ranks.set(item.id, index);
	});
	return (id: string) => ranks.get(id) ?? Number.MAX_SAFE_INTEGER;
});
const groups = $derived(
	animation
		? boardTrackGroups({
				document: editor.document,
				animation,
				selection: editor.selection,
				order,
			})
		: [],
);
const extent = $derived(animation ? boardAnimationExtent(animation) : 1);
const recordingTargets = $derived(
	editor.recording ? new Set(editor.selection) : new Set<string>(),
);
const spans = $derived(
	new Map(groups.flatMap((group) => (group.span ? [[group.target, group.span] as const] : []))),
);
const unplaced = $derived(
	animation ? editor.selection.filter((id) => !spans.has(id)) : [],
);
const clipTargets = $derived(
	selection?.type === "clips" ? [...selection.targets] : [],
);
const splitTargets = $derived(
	(clipTargets.length ? clipTargets : editor.selection).filter((id) => {
		const span = spans.get(id);
		return span !== undefined && time > span.start && time < span.end;
	}),
);
const manualCount = $derived(
	Object.values(editor.animations).filter((entry) => entry.play === "manual")
		.length,
);

$effect(() => {
	animationId;
	selection = null;
});

$effect(() => {
	if (!transport.playing && animationId && !editor.playhead)
		untrack(() => transport.hold());
});

function isOpen(target: string) {
	return (
		opened.get(target) ??
		(editor.selection.includes(target) || groups.length <= 4)
	);
}

function edit<T>(change: () => T): T {
	transport.hold();
	return change();
}

function create() {
	edit(() =>
		editor.createAnimation(m.board_animation_default_name({}, { locale })),
	);
}

function keyRow(row: BoardTrackRow, on: boolean) {
	edit(() => editor.keyProperty(row.target, row.property, on));
}

function moveKeys(keys: BoardKeyRef[], delta: number) {
	const moved = edit(() => editor.moveKeyframes(keys, delta));
	selection = { type: "keys", ids: new Set(moved.map(boardKeyId)) };
}

function moveMarker(from: number, to: number) {
	if (!animation || animation.markers.some((marker) => marker.at === to))
		return;
	edit(() =>
		editor.setMarkers(
			animation.markers.map((marker) =>
				marker.at === from ? { ...marker, at: to } : marker,
			),
		),
	);
	selection = { type: "marker", at: to };
}

function addMarker(at: number) {
	if (!animation || animation.markers.some((marker) => marker.at === at))
		return;
	edit(() => editor.setMarkers([...animation.markers, { at }]));
	selection = { type: "marker", at };
}

export function dropTime(clientX: number, clientY: number, free = false): number | null {
	return animation ? (lanes?.timeAtPoint(clientX, clientY, free) ?? null) : null;
}

export function showDrop(at: number | null) {
	dropAt = at;
}

export function place(ids: readonly string[], at: number, together = false) {
	if (!ids.length || !edit(() => editor.placeOnTimeline(ids, at, { together }))) return;
	selection = { type: "clips", targets: new Set(ids) };
}

function selectClips(targets: ReadonlySet<string>) {
	selection = targets.size ? { type: "clips", targets } : null;
	const items = [...targets].filter((id) => editor.itemById(id));
	if (items.length) editor.setSelection(items);
}

function split() {
	const copies = edit(() => editor.splitAtPlayhead(splitTargets));
	if (copies.length) selectClips(new Set(copies));
}

function insertTime() {
	const range = selection?.type === "range" ? selection : null;
	edit(() =>
		editor.insertTime(range?.from ?? time, range ? range.to - range.from : 1000),
	);
}

function removeTime() {
	if (selection?.type !== "range") return;
	const { from, to } = selection;
	edit(() => editor.removeTime(from, to));
	selection = null;
	transport.seek(from);
}

function dragOver(event: DragEvent) {
	if (!onDropResources || !event.dataTransfer?.types.length) return;
	event.preventDefault();
	event.dataTransfer.dropEffect = "copy";
	dropAt = dropTime(event.clientX, event.clientY, event.altKey);
}

function drop(event: DragEvent) {
	const at = dropAt;
	dropAt = null;
	if (!onDropResources || !event.dataTransfer || at === null) return;
	event.preventDefault();
	transport.hold();
	onDropResources(event.dataTransfer, at);
}

function focusTarget(target: string) {
	if (!editor.itemById(target)) return;
	editor.setSelection([target]);
	opened.set(target, true);
}

const selectedKeys = $derived(
	selection?.type === "keys" ? [...selection.ids].map(parseBoardKeyId) : [],
);

function isTyping(target: EventTarget | null) {
	return (
		target instanceof HTMLElement &&
		(target.isContentEditable ||
			target.closest("input, textarea, select") !== null)
	);
}

function handleKeydown(event: KeyboardEvent) {
	if (
		!animation ||
		!root?.contains(event.target as Node) ||
		isTyping(event.target)
	)
		return;
	const mod = event.metaKey || event.ctrlKey;
	const handled = (() => {
		if (event.key === " " && !mod) {
			transport.toggle();
			return true;
		}
		if (event.key === "Escape" && selection) {
			selection = null;
			return true;
		}
		if (event.key.toLowerCase() === "s" && !mod && splitTargets.length) {
			split();
			return true;
		}
		if ((event.key === "Delete" || event.key === "Backspace") && selection) {
			if (selection.type === "clips") {
				const targets = [...selection.targets];
				edit(() => editor.removeFromTimeline(targets));
			} else if (selection.type === "range") {
				removeTime();
				return true;
			} else if (selection.type === "marker") {
				const at = selection.at;
				edit(() =>
					editor.setMarkers(
						animation.markers.filter((marker) => marker.at !== at),
					),
				);
			} else if (selectedKeys.length)
				edit(() => editor.removeKeyframes(selectedKeys));
			selection = null;
			return true;
		}
		if (mod && event.key.toLowerCase() === "c" && selectedKeys.length) {
			clipboard = editor.copyKeyframes(selectedKeys, animationId ?? undefined);
			return true;
		}
		if (mod && event.key.toLowerCase() === "v" && clipboard?.length) {
			const clip = clipboard;
			const pasted = edit(() => editor.pasteKeyframes(clip));
			if (pasted.length)
				selection = { type: "keys", ids: new Set(pasted.map(boardKeyId)) };
			return true;
		}
		if (mod && event.key.toLowerCase() === "a") {
			const ids = new Set<string>();
			for (const [trackId, track] of Object.entries(animation.tracks))
				for (const keyframe of track.keyframes)
					ids.add(boardKeyId({ trackId, at: keyframe.at }));
			selection = ids.size ? { type: "keys", ids } : null;
			return true;
		}
		if (
			!mod &&
			(event.key === "ArrowLeft" || event.key === "ArrowRight")
		) {
			const step = (event.shiftKey ? 1000 : 1000 / 30) *
				(event.key === "ArrowLeft" ? -1 : 1);
			transport.seek(Math.round(time + step));
			return true;
		}
		return false;
	})();
	if (!handled) return;
	event.preventDefault();
	event.stopPropagation();
}

function resize(event: PointerEvent) {
	if (event.button !== 0) return;
	const handle = event.currentTarget as HTMLElement;
	handle.setPointerCapture(event.pointerId);
	const startY = event.clientY;
	const startHeight = height;
	const max = () => Math.max(MIN_HEIGHT, window.innerHeight * 0.6);
	const move = (next: PointerEvent) => {
		height = Math.round(
			Math.min(max(), Math.max(MIN_HEIGHT, startHeight + startY - next.clientY)),
		);
	};
	const end = () => {
		handle.removeEventListener("pointermove", move);
		handle.removeEventListener("pointerup", end);
		handle.removeEventListener("pointercancel", end);
		try {
			localStorage.setItem(HEIGHT_KEY, String(height));
		} catch {}
	};
	handle.addEventListener("pointermove", move);
	handle.addEventListener("pointerup", end);
	handle.addEventListener("pointercancel", end);
}

const pickerItems = $derived<BoardMenuItem[]>([
	...transport.ids.map((id) => ({
		id,
		label: editor.animations[id]?.name || id,
		checked: id === animationId,
		run: () => transport.choose(id),
	})),
	...(transport.ids.length ? [{ id: "separator", separator: true as const }] : []),
	{ id: "new", label: m.board_animation_new({}, { locale }), run: create },
	...(manualCount > 1
		? [
				{
					id: "sequence",
					label: m.board_sequence_create({}, { locale }),
					run: () => {
						sequenceOpen = true;
					},
				},
			]
		: []),
]);

const moreItems = $derived<BoardMenuItem[]>([
	{
		id: "follow",
		label: m.board_camera_follow({}, { locale }),
		checked: editor.cameraPolicy === "follow",
		run: () =>
			editor.setCameraPolicy(
				editor.cameraPolicy === "follow" ? "free" : "follow",
			),
	},
	{
		id: "record-view",
		label: m.board_camera_record({}, { locale }),
		run: () => edit(() => editor.keyCamera()),
	},
	{
		id: "marker",
		label: m.board_marker_add({}, { locale }),
		run: () => addMarker(Math.round(time)),
	},
	{ id: "time-separator", separator: true as const },
	{
		id: "insert-time",
		label:
			selection?.type === "range"
				? m.board_timeline_insert_range({}, { locale })
				: m.board_timeline_insert_second({}, { locale }),
		run: insertTime,
	},
	...(selection?.type === "range"
		? [
				{
					id: "remove-time",
					label: m.board_timeline_remove_range({}, { locale }),
					run: removeTime,
				},
			]
		: []),
]);
</script>

<svelte:window onkeydowncapture={handleKeydown} />

<section
	bind:this={root}
	class="dock"
	style:height="{height}px"
	aria-label={m.board_timeline({}, { locale })}
	tabindex="-1"
>
	{#if !isMobile}
		<div class="resize" role="separator" aria-orientation="horizontal" aria-label={m.board_timeline_resize({}, { locale })} onpointerdown={resize}></div>
	{/if}
	<header class="head">
		<button
			bind:this={pickerAnchor}
			type="button"
			class="picker"
			aria-haspopup="menu"
			aria-expanded={menu === "picker"}
			onclick={() => { menu = menu === "picker" ? null : "picker"; }}
		>
			<Clapperboard class="h-3.5 w-3.5 shrink-0" />
			<span class="picker-name">{animation ? animation.name || animationId : m.board_animation_none({}, { locale })}</span>
			<ChevronDown class="h-3 w-3 shrink-0" />
		</button>
		{#if animation}
			<button
				bind:this={settingsAnchor}
				type="button"
				class="key"
				title={m.board_animation_settings({}, { locale })}
				aria-label={m.board_animation_settings({}, { locale })}
				aria-expanded={menu === "settings"}
				onclick={() => { menu = menu === "settings" ? null : "settings"; }}
			>
				<Settings2 class="h-3.5 w-3.5" />
			</button>
			<span class="divider"></span>
			<button type="button" class="key key--start" title={m.board_to_start({}, { locale })} aria-label={m.board_to_start({}, { locale })} onclick={() => transport.seek(0)}>
				<SkipBack class="h-3.5 w-3.5" />
			</button>
			<button
				type="button"
				class="key key--play"
				title={transport.playing ? m.board_pause({}, { locale }) : m.board_play({}, { locale })}
				aria-label={transport.playing ? m.board_pause({}, { locale }) : m.board_play({}, { locale })}
				onclick={transport.toggle}
			>
				{#if transport.playing}<Pause class="h-3.5 w-3.5" fill="currentColor" />{:else}<Play class="h-3.5 w-3.5" fill="currentColor" />{/if}
			</button>
			<button type="button" class="key" title={m.board_next_marker({}, { locale })} aria-label={m.board_next_marker({}, { locale })} disabled={!transport.nextMarker} onclick={transport.next}>
				<SkipForward class="h-3.5 w-3.5" />
			</button>
			<span class="time">
				<span class="time-now">{formatBoardTime(time)}</span>
				<span class="time-total">/ {formatBoardTime(animation.duration)}</span>
			</span>
		{/if}
		<span class="spacer"></span>
		{#if animation && unplaced.length}
			<button
				type="button"
				class="timeline-add"
				title={m.board_timeline_add_hint({}, { locale })}
				onclick={() => place(unplaced, time)}
			>
				<Plus class="h-3 w-3" />
				<span class="timeline-add-label">{m.board_timeline_add({}, { locale })}</span>
			</button>
		{/if}
		{#if animation && splitTargets.length}
			<button
				type="button"
				class="key"
				title={m.board_timeline_split({}, { locale })}
				aria-label={m.board_timeline_split({}, { locale })}
				onclick={split}
			>
				<Scissors class="h-3.5 w-3.5" />
			</button>
		{/if}
		{#if animation}
			<button
				type="button"
				class="autokey"
				aria-pressed={editor.recording}
				aria-label={m.board_autokey({}, { locale })}
				title={m.board_autokey_hint({}, { locale })}
				onclick={() => edit(() => editor.setRecording(!editor.recording))}
			>
				<Circle class="h-2.5 w-2.5" fill={editor.recording ? "currentColor" : "none"} />
				<span class="autokey-label">{m.board_autokey({}, { locale })}</span>
			</button>
			<button
				bind:this={moreAnchor}
				type="button"
				class="key"
				title={m.board_more({}, { locale })}
				aria-label={m.board_more({}, { locale })}
				aria-haspopup="menu"
				aria-expanded={menu === "more"}
				onclick={() => { menu = menu === "more" ? null : "more"; }}
			>
				<Ellipsis class="h-3.5 w-3.5" />
			</button>
		{/if}
		<button type="button" class="key" title={m.board_timeline_close({}, { locale })} aria-label={m.board_timeline_close({}, { locale })} onclick={onClose}>
			<X class="h-3.5 w-3.5" />
		</button>
	</header>

	{#if !animation}
		<div class="empty">
			<p class="empty-title">{m.board_animation_empty_title({}, { locale })}</p>
			<p class="empty-hint">{m.board_animation_empty_hint({}, { locale })}</p>
			<button type="button" class="primary-key empty-action" onclick={create}>{m.board_animation_new({}, { locale })}</button>
		</div>
	{:else}
		<div
			class="body"
			role="presentation"
			ondragover={dragOver}
			ondragleave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node)) dropAt = null; }}
			ondrop={drop}
		>
			<BoardAnimationLanes
				bind:this={lanes}
				{groups}
				{dropAt}
				{animation}
				{extent}
				{time}
				{selection}
				{recordingTargets}
				{isOpen}
				onToggleGroup={(target) => opened.set(target, !isOpen(target))}
				onFocusTarget={focusTarget}
				onSeek={(at) => transport.seek(at)}
				onSelect={(next) => { selection = next; }}
				onKey={keyRow}
				onMoveKeys={moveKeys}
				onMoveMarker={moveMarker}
				onAddMarker={addMarker}
				onSelectClips={selectClips}
				onShiftClips={(targets, delta) => edit(() => editor.shiftOnTimeline(targets, delta))}
				onTrimClip={(target, edge, at) => edit(() => editor.trimOnTimeline(target, edge, at))}
			/>
			{#if groups.length === 0}
				<p class="hint">{m.board_animation_select_hint({}, { locale })}</p>
			{/if}
		</div>
		{#if selection && selection.type !== "clips" && selection.type !== "range"}
			<BoardAnimationInspector
				{editor}
				{edit}
				{animation}
				{groups}
				{selection}
				onSelect={(next) => { selection = next; }}
			/>
		{/if}
	{/if}
</section>

{#if menu === "picker" && pickerAnchor}
	<BoardMenu anchor={pickerAnchor} items={pickerItems} label={m.board_animation_select({}, { locale })} onClose={() => { menu = null; }} />
{:else if menu === "more" && moreAnchor}
	<BoardMenu anchor={moreAnchor} items={moreItems} label={m.board_more({}, { locale })} placement="top-start" onClose={() => { menu = null; }} />
{:else if menu === "settings" && settingsAnchor && animation && animationId}
	<BoardAnimationSettings {editor} {animationId} {animation} anchor={settingsAnchor} onClose={() => { menu = null; }} />
{/if}
{#if sequenceOpen}<BoardSequenceDialog {editor} onClose={() => { sequenceOpen = false; }} />{/if}

<style>
	.dock {
		container-type: inline-size;
		position: relative;
		display: flex;
		flex: none;
		flex-direction: column;
		min-height: 0;
		border-top: 1px solid var(--border-subtle);
		background: var(--bg-elevated);
		outline: none;
	}
	.resize {
		position: absolute;
		top: -4px;
		right: 0;
		left: 0;
		z-index: 6;
		height: 8px;
		cursor: ns-resize;
		touch-action: none;
	}
	.resize:hover { background: linear-gradient(transparent 3px, var(--brand-border) 3px, var(--brand-border) 5px, transparent 5px); }

	.head {
		display: flex;
		flex: none;
		align-items: center;
		gap: 2px;
		min-height: 38px;
		border-bottom: 1px solid var(--border-subtle);
		padding: 0 6px;
		overflow-x: auto;
		scrollbar-width: none;
	}
	.picker {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		max-width: 200px;
		height: 28px;
		border-radius: 7px;
		padding: 0 8px;
		color: var(--text-primary);
		font-size: 12px;
		font-weight: 600;
	}
	.picker:hover,
	.picker[aria-expanded="true"] { background: var(--bg-hover); }
	.picker-name {
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.key {
		display: inline-grid;
		flex: none;
		place-items: center;
		width: 28px;
		height: 28px;
		border-radius: 7px;
		color: var(--text-secondary);
	}
	.key:hover:not(:disabled),
	.key[aria-expanded="true"] { background: var(--bg-hover); color: var(--text-primary); }
	.key:disabled { opacity: 0.35; }
	.key--play { color: var(--text-primary); }
	.divider {
		flex: none;
		width: 1px;
		height: 16px;
		margin: 0 4px;
		background: var(--border-subtle);
	}
	.time {
		display: inline-flex;
		gap: 4px;
		margin-left: 6px;
		font-family: var(--font-mono);
		font-size: 11px;
		font-variant-numeric: tabular-nums;
		white-space: nowrap;
	}
	.time-now { color: var(--text-primary); }
	.time-total { color: var(--text-tertiary); }
	.spacer { flex: 1; }
	.timeline-add {
		display: inline-flex;
		flex: none;
		align-items: center;
		gap: 4px;
		height: 26px;
		margin-right: 4px;
		border-radius: 999px;
		background: var(--brand-muted);
		padding: 0 10px;
		color: var(--brand-muted-fg);
		font-size: 11px;
		font-weight: 600;
		white-space: nowrap;
	}
	.timeline-add:hover { background: color-mix(in srgb, var(--brand) 22%, transparent); }
	.autokey {
		display: inline-flex;
		flex: none;
		align-items: center;
		gap: 6px;
		height: 26px;
		border: 1px solid var(--border-subtle);
		border-radius: 999px;
		padding: 0 10px;
		color: var(--text-secondary);
		font-size: 11px;
		font-weight: 500;
		white-space: nowrap;
	}
	.autokey:hover { color: var(--text-primary); }
	.autokey[aria-pressed="true"] {
		border-color: color-mix(in srgb, var(--error-500) 50%, transparent);
		background: color-mix(in srgb, var(--error-500) 12%, transparent);
		color: var(--error-500);
	}

	.body {
		position: relative;
		display: flex;
		min-height: 0;
		flex: 1;
	}
	.hint {
		position: absolute;
		top: 36px;
		right: 0;
		left: 188px;
		padding: 12px 16px;
		color: var(--text-tertiary);
		font-size: 12px;
		text-align: center;
		pointer-events: none;
	}

	.empty {
		display: flex;
		flex: 1;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		gap: 6px;
		padding: 16px;
		text-align: center;
	}
	.empty-title {
		color: var(--text-primary);
		font-size: 13px;
		font-weight: 600;
	}
	.empty-hint {
		max-width: 420px;
		color: var(--text-tertiary);
		font-size: 12px;
		line-height: 1.5;
	}
	.empty-action {
		margin-top: 6px;
		padding: 6px 12px;
		font-size: 12px;
	}

	@container (max-width: 560px) {
		.time-total,
		.autokey-label,
		.timeline-add-label,
		.key--start { display: none; }
		.autokey { width: 34px; justify-content: center; padding: 0; }
		.picker { max-width: 128px; }
	}

	@media (pointer: coarse) {
		.key { width: 38px; height: 38px; }
		.picker { height: 38px; }
		.autokey,
		.timeline-add { height: 34px; }
		.hint { left: 132px; }
	}
</style>
