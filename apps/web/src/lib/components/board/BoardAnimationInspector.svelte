<script lang="ts">
import type { BoardAnimation, BoardTrack } from "@cohub/protocol";
import { BOARD_CAMERA_TARGET } from "@cohub/protocol";
import { resolveBoardProperty } from "@neta-art/cohub/board";
import type { BoardKeyRef } from "@neta-art/cohub/board/editor";
import { Spline, Trash2 } from "lucide-svelte";
import { floatNear } from "#lib/actions/portal.ts";
import {
	boardGroupLabel,
	boardPropertyLabel,
} from "#lib/board/animation-labels.ts";
import {
	BOARD_EASE_PRESETS,
	type BoardDockSelection,
	type BoardTrackGroup,
	boardKeyId,
	formatBoardBezier,
	parseBoardBezier,
	parseBoardKeyId,
} from "#lib/board/animation-timeline.ts";
import type { BoardEditor } from "#lib/board/editor.svelte.ts";
import BoardEaseCurve from "#lib/components/board/BoardEaseCurve.svelte";
import ToggleSwitch from "#lib/components/ToggleSwitch.svelte";
import { getLocale } from "#lib/i18n/locale.svelte.ts";
import { m } from "#lib/paraglide/messages.js";

const {
	editor,
	edit,
	animation,
	groups,
	selection,
	onSelect,
}: {
	editor: BoardEditor;
	edit: <T>(change: () => T) => T;
	animation: BoardAnimation;
	groups: readonly BoardTrackGroup[];
	selection: Exclude<BoardDockSelection, null>;
	onSelect: (selection: BoardDockSelection) => void;
} = $props();

const locale = $derived(getLocale());

const keys = $derived(
	selection.type === "keys"
		? [...selection.ids]
				.map(parseBoardKeyId)
				.filter((ref) =>
					animation.tracks[ref.trackId]?.keyframes.some(
						(keyframe) => keyframe.at === ref.at,
					),
				)
		: [],
);
const focused = $derived.by(() => {
	const ref: BoardKeyRef | undefined =
		selection.type === "segment"
			? selection.key
			: keys.length === 1
				? keys[0]
				: undefined;
	const track = ref ? animation.tracks[ref.trackId] : undefined;
	const index =
		track?.keyframes.findIndex((keyframe) => keyframe.at === ref?.at) ?? -1;
	if (!ref || !track || index < 0) return null;
	const keyframe = track.keyframes[index];
	if (!keyframe) return null;
	return { ref, track, keyframe, previous: track.keyframes[index - 1] };
});
const marker = $derived(
	selection.type === "marker"
		? animation.markers.find((entry) => entry.at === selection.at)
		: undefined,
);

const kind = $derived.by(() => {
	if (!focused) return "discrete";
	const target = focused.track.target;
	const type =
		target === BOARD_CAMERA_TARGET
			? BOARD_CAMERA_TARGET
			: (editor.document.items[target]?.type ??
				(editor.animations[target] ? "animation" : ""));
	const resolved = resolveBoardProperty(type, focused.track.property);
	return resolved.ok ? resolved.spec.kind : "discrete";
});

const title = $derived.by(() => {
	if (!focused) return "";
	const group = groups.find((entry) => entry.target === focused.track.target);
	const name = group
		? boardGroupLabel(group, { locale })
		: focused.track.target;
	return `${name} · ${boardPropertyLabel(focused.track.property, { locale })}`;
});

const ease = $derived(focused?.keyframe.ease ?? "linear");
const preset = $derived(
	BOARD_EASE_PRESETS.find((entry) => entry.value === ease)?.id ?? "custom",
);
const curve = $derived(parseBoardBezier(ease));
let curveOpen = $state(false);
let curveAnchor = $state<HTMLButtonElement | null>(null);
let curvePopover = $state<HTMLDivElement | null>(null);
const segmentTrack = $derived(
	selection.type === "segment" ? selection.key.trackId : null,
);

$effect(() => {
	segmentTrack;
	curveOpen = false;
});

$effect(() => {
	if (!curveOpen) return;
	const down = (event: PointerEvent) => {
		const target = event.target as Node;
		if (!curvePopover?.contains(target) && !curveAnchor?.contains(target))
			curveOpen = false;
	};
	document.addEventListener("pointerdown", down, true);
	return () => document.removeEventListener("pointerdown", down, true);
});

const EASE_LABELS = $derived<Record<string, string>>({
	linear: m.board_ease_linear({}, { locale }),
	ease: m.board_ease_ease({}, { locale }),
	"ease-in": m.board_ease_in({}, { locale }),
	"ease-out": m.board_ease_out({}, { locale }),
	"ease-in-out": m.board_ease_in_out({}, { locale }),
	"smooth-out": m.board_ease_smooth_out({}, { locale }),
	overshoot: m.board_ease_overshoot({}, { locale }),
	"step-end": m.board_ease_hold({}, { locale }),
	custom: m.board_ease_custom({}, { locale }),
});

function setKeyframe(
	patch: Parameters<BoardEditor["setKeyframe"]>[1],
): boolean {
	if (!focused) return false;
	const ref = focused.ref;
	const landed = edit(() => editor.setKeyframe(ref, patch));
	if (!landed) return false;
	onSelect(
		selection.type === "segment"
			? { type: "segment", key: landed }
			: { type: "keys", ids: new Set([boardKeyId(landed)]) },
	);
	return true;
}

function commit(
	event: Event & { currentTarget: HTMLInputElement },
	shown: string | number,
	apply: (raw: string) => boolean,
) {
	if (!apply(event.currentTarget.value.trim()))
		event.currentTarget.value = String(shown);
}

function setTrack(
	patch: Partial<Pick<BoardTrack, "interpolation" | "composite" | "orient">>,
) {
	const trackId = focused?.ref.trackId;
	if (trackId) edit(() => editor.setTrack(trackId, patch));
}

function number(raw: string): number | null {
	const value = Number(raw);
	return raw.trim() && Number.isFinite(value) ? value : null;
}

function setTime(raw: string) {
	const seconds = number(raw);
	return (
		seconds !== null && seconds >= 0 && setKeyframe({ at: seconds * 1000 })
	);
}

function setComponent(axis: "x" | "y", raw: string) {
	const value = number(raw);
	const current = focused?.keyframe.value;
	if (value === null || !current || typeof current !== "object") return false;
	return setKeyframe({
		value: { ...(current as Record<string, number>), [axis]: value },
	});
}

function setScalar(raw: string) {
	const value = number(raw);
	return value !== null && setKeyframe({ value });
}

function setEase(id: string) {
	const entry = BOARD_EASE_PRESETS.find((candidate) => candidate.id === id);
	if (entry)
		setKeyframe({ ease: entry.value === "linear" ? null : entry.value });
	else curveOpen = true;
}

function setMarker(patch: { label?: string; pause?: boolean }) {
	if (!marker) return;
	const next = { ...marker, ...patch };
	if (!next.label) delete next.label;
	if (!next.pause) delete next.pause;
	edit(() =>
		editor.setMarkers(
			animation.markers.map((entry) => (entry === marker ? next : entry)),
		),
	);
}

function remove() {
	if (selection.type === "marker" && marker) {
		edit(() =>
			editor.setMarkers(animation.markers.filter((entry) => entry !== marker)),
		);
	} else if (keys.length) edit(() => editor.removeKeyframes(keys));
	onSelect(null);
}

const vector = $derived(
	focused &&
		typeof focused.keyframe.value === "object" &&
		focused.keyframe.value !== null &&
		"x" in focused.keyframe.value
		? (focused.keyframe.value as { x: number; y: number })
		: null,
);
const round = (value: number) => Number(value.toFixed(3));
</script>

<div class="inspector" role="group" aria-label={m.board_animation_inspector({}, { locale })}>
	{#if selection.type === "marker" && marker}
		<span class="title">{m.board_marker({}, { locale })}</span>
		<label class="field">
			<span>{m.board_marker_label({}, { locale })}</span>
			<input class="input input--wide" type="text" maxlength="280" value={marker.label ?? ""} onchange={(event) => setMarker({ label: event.currentTarget.value.trim() })} />
		</label>
		<span class="field">
			<span>{m.board_marker_pause({}, { locale })}</span>
			<ToggleSwitch checked={marker.pause === true} label={m.board_marker_pause({}, { locale })} onchange={(pause) => setMarker({ pause })} />
		</span>
	{:else if selection.type === "segment" && focused}
		<span class="title" title={title}>{title}</span>
		<label class="field">
			<span>{m.board_ease({}, { locale })}</span>
			<select class="input" value={preset} onchange={(event) => setEase(event.currentTarget.value)}>
				{#each BOARD_EASE_PRESETS as entry (entry.id)}
					<option value={entry.id}>{EASE_LABELS[entry.id]}</option>
				{/each}
				<option value="custom">{EASE_LABELS.custom}</option>
			</select>
		</label>
		<button
			bind:this={curveAnchor}
			type="button"
			class="icon-key"
			title={m.board_ease_curve({}, { locale })}
			aria-label={m.board_ease_curve({}, { locale })}
			aria-expanded={curveOpen}
			onclick={() => { curveOpen = !curveOpen; }}
		>
			<Spline class="h-3.5 w-3.5" />
		</button>
		<input
			class="input input--code"
			type="text"
			value={ease}
			aria-label={m.board_ease({}, { locale })}
			spellcheck="false"
			onchange={(event) => commit(event, ease, (raw) => setKeyframe({ ease: raw || null }))}
		/>
		{#if curveOpen && curveAnchor}
			<div
				bind:this={curvePopover}
				class="curve-popover menu-surface"
				use:floatNear={{ getAnchor: () => curveAnchor, placement: "top-start", gap: 8, zIndex: 130 }}
			>
				<BoardEaseCurve
					curve={curve ?? [0, 0, 1, 1]}
					label={m.board_ease_curve({}, { locale })}
					onChange={(next) => setKeyframe({ ease: formatBoardBezier(next) })}
				/>
			</div>
		{/if}
	{:else if focused}
		<span class="title" title={title}>{title}</span>
		<label class="field">
			<span>{m.board_keyframe_time({}, { locale })}</span>
			<input class="input input--number" type="text" inputmode="decimal" value={(focused.keyframe.at / 1000).toFixed(2)} onchange={(event) => commit(event, (focused.keyframe.at / 1000).toFixed(2), setTime)} />
			<span class="unit">s</span>
		</label>
		<span class="field">
			<span>{m.board_keyframe_value({}, { locale })}</span>
			{#if vector}
				<input class="input input--number" type="text" inputmode="decimal" aria-label="X" value={round(vector.x)} onchange={(event) => commit(event, round(vector.x), (raw) => setComponent("x", raw))} />
				<input class="input input--number" type="text" inputmode="decimal" aria-label="Y" value={round(vector.y)} onchange={(event) => commit(event, round(vector.y), (raw) => setComponent("y", raw))} />
			{:else if typeof focused.keyframe.value === "number"}
				<input class="input input--number" type="text" inputmode="decimal" value={round(focused.keyframe.value)} onchange={(event) => commit(event, round(focused.keyframe.value as number), setScalar)} />
			{:else if kind === "color" && typeof focused.keyframe.value === "string"}
				<input class="input" type="text" value={focused.keyframe.value} spellcheck="false" onchange={(event) => commit(event, String(focused.keyframe.value), (value) => value !== "" && setKeyframe({ value }))} />
			{:else}
				<code class="readout" title={JSON.stringify(focused.keyframe.value)}>{JSON.stringify(focused.keyframe.value)}</code>
			{/if}
		</span>
		{#if kind !== "discrete"}
			<label class="field">
				<span>{m.board_interpolation({}, { locale })}</span>
				<select class="input" value={focused.track.interpolation} onchange={(event) => setTrack({ interpolation: event.currentTarget.value as BoardTrack["interpolation"] })}>
					<option value="auto">{m.board_interpolation_auto({}, { locale })}</option>
					<option value="step">{m.board_interpolation_step({}, { locale })}</option>
					{#if kind === "vec2"}<option value="spline">{m.board_interpolation_spline({}, { locale })}</option>{/if}
				</select>
			</label>
		{/if}
		{#if focused.track.property === "position"}
			<span class="field">
				<span>{m.board_orient({}, { locale })}</span>
				<ToggleSwitch checked={focused.track.orient === true} label={m.board_orient({}, { locale })} onchange={(orient) => setTrack({ orient })} />
			</span>
		{/if}
	{:else if keys.length > 1}
		<span class="title">{m.board_keyframes_count({ count: keys.length }, { locale })}</span>
	{/if}
	<span class="spacer"></span>
	{#if selection.type !== "segment"}
		<button type="button" class="icon-key icon-key--danger" title={m.board_delete({}, { locale })} aria-label={m.board_delete({}, { locale })} onclick={remove}>
			<Trash2 class="h-3.5 w-3.5" />
		</button>
	{/if}
</div>

<style>
	.inspector {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 4px 12px;
		min-height: 36px;
		border-top: 1px solid var(--border-subtle);
		padding: 4px 10px;
		font-size: 11px;
	}
	.title {
		max-width: 220px;
		overflow: hidden;
		color: var(--text-primary);
		font-weight: 600;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.field {
		display: inline-flex;
		align-items: center;
		gap: 5px;
		color: var(--text-tertiary);
	}
	.input {
		height: 24px;
		border: 1px solid var(--border-subtle);
		border-radius: 6px;
		background: var(--bg-input);
		padding: 0 6px;
		color: var(--text-primary);
		font-size: 11px;
		outline: none;
	}
	.input:focus { border-color: var(--brand-border); }
	.input--number {
		width: 64px;
		font-family: var(--font-mono);
		font-variant-numeric: tabular-nums;
		text-align: right;
	}
	.input--wide { width: 160px; }
	.input--code {
		width: 200px;
		font-family: var(--font-mono);
	}
	.unit { color: var(--text-tertiary); }
	.readout {
		max-width: 180px;
		overflow: hidden;
		color: var(--text-secondary);
		font-family: var(--font-mono);
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.spacer { flex: 1; }
	.icon-key {
		display: inline-grid;
		place-items: center;
		width: 26px;
		height: 26px;
		border-radius: 6px;
		color: var(--text-tertiary);
	}
	.icon-key:hover,
	.icon-key[aria-expanded="true"] { background: var(--bg-hover); color: var(--text-primary); }
	.icon-key--danger:hover { background: var(--color-error-bg); color: var(--error-700); }
	.curve-popover { padding: 8px; }

	@media (pointer: coarse) {
		.input { height: 32px; font-size: 12px; }
		.icon-key { width: 36px; height: 36px; }
	}
</style>
