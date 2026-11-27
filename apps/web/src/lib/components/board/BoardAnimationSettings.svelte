<script lang="ts">
import type { BoardAnimation } from "@cohub/protocol";
import { BOARD_CAMERA_VIEWPORT } from "@neta-art/cohub/board";
import { onMount } from "svelte";
import { floatNear } from "#lib/actions/portal.ts";
import { boardAnimationReach } from "#lib/board/board-media-playback.ts";
import type { BoardEditor } from "#lib/board/editor.svelte.ts";
import Segmented from "#lib/components/Segmented.svelte";
import ToggleSwitch from "#lib/components/ToggleSwitch.svelte";
import { getLocale } from "#lib/i18n/locale.svelte.ts";
import { m } from "#lib/paraglide/messages.js";

const {
	editor,
	animationId,
	animation,
	anchor,
	onClose,
}: {
	editor: BoardEditor;
	animationId: string;
	animation: BoardAnimation;
	anchor: HTMLElement;
	onClose: () => void;
} = $props();

const locale = $derived(getLocale());
let panel = $state<HTMLDivElement | null>(null);

const VIEWPORTS = [
	{ ratio: "16:9", ...BOARD_CAMERA_VIEWPORT },
	{ ratio: "9:16", width: 900, height: 1600 },
	{ ratio: "1:1", width: 1080, height: 1080 },
];
const size = ({ width, height }: { width: number; height: number }) =>
	`${width}x${height}`;
const viewport = $derived(size(animation.viewport ?? BOARD_CAMERA_VIEWPORT));
const viewports = $derived([
	...VIEWPORTS.map((entry) => ({
		value: size(entry),
		label: `${entry.ratio} · ${entry.width} × ${entry.height}`,
	})),
	...(VIEWPORTS.some((entry) => size(entry) === viewport)
		? []
		: [{ value: viewport, label: viewport.replace("x", " × ") }]),
]);
const framesCamera = $derived(
	boardAnimationReach(editor.document, animationId).camera,
);

function setViewport(value: string) {
	const [width = 0, height = 0] = value.split("x").map(Number);
	const unset = value === size(BOARD_CAMERA_VIEWPORT);
	update({ viewport: unset ? undefined : { width, height } });
}

const update = (settings: Parameters<BoardEditor["updateAnimation"]>[1]) =>
	editor.updateAnimation(animationId, settings);

function seconds(
	event: Event & { currentTarget: HTMLInputElement },
	stored: number,
	apply: (ms: number) => boolean,
) {
	const raw = event.currentTarget.value.trim();
	const value = Number(raw);
	if (!raw || !Number.isFinite(value) || value < 0 || !apply(value * 1000))
		event.currentTarget.value = (stored / 1000).toFixed(2);
}

onMount(() => {
	const down = (event: PointerEvent) => {
		const target = event.target as Node;
		if (!panel?.contains(target) && !anchor.contains(target)) onClose();
	};
	const key = (event: KeyboardEvent) => {
		if (event.key !== "Escape") return;
		event.stopPropagation();
		onClose();
	};
	document.addEventListener("pointerdown", down, true);
	document.addEventListener("keydown", key, true);
	panel?.querySelector<HTMLInputElement>("input")?.focus();
	return () => {
		document.removeEventListener("pointerdown", down, true);
		document.removeEventListener("keydown", key, true);
	};
});
</script>

<div
	bind:this={panel}
	class="settings menu-surface"
	role="dialog"
	aria-label={m.board_animation_settings({}, { locale })}
	use:floatNear={{ getAnchor: () => anchor, placement: "top-start", gap: 6, width: 280, zIndex: 130 }}
>
	<label class="field">
		<span>{m.board_animation_name({}, { locale })}</span>
		<input class="input" type="text" maxlength="280" value={animation.name ?? ""} placeholder={animationId} onchange={(event) => update({ name: event.currentTarget.value.trim() })} />
	</label>
	<label class="field">
		<span>{m.board_animation_duration({}, { locale })}</span>
		<span class="with-unit">
			<input class="input input--number" type="text" inputmode="decimal" value={(animation.duration / 1000).toFixed(2)} onchange={(event) => seconds(event, animation.duration, (duration) => update({ duration }))} />
			<span>s</span>
		</span>
	</label>
	<div class="field">
		<span>{m.board_animation_play({}, { locale })}</span>
		<Segmented
			label={m.board_animation_play({}, { locale })}
			value={animation.play}
			options={[
				{ value: "manual", label: m.board_animation_play_manual({}, { locale }) },
				{ value: "auto", label: m.board_animation_play_auto({}, { locale }) },
				{ value: "always", label: m.board_animation_play_always({}, { locale }) },
			]}
			onchange={(play) => update({ play })}
		/>
	</div>
	{#if animation.play !== "always"}
		<div class="row">
			<span>{m.board_animation_loop({}, { locale })}</span>
			<ToggleSwitch checked={animation.loop} label={m.board_animation_loop({}, { locale })} onchange={(loop) => update({ loop })} />
		</div>
	{/if}
	{#if framesCamera}
		<label class="field">
			<span>{m.board_animation_viewport({}, { locale })}</span>
			<select class="input" value={viewport} onchange={(event) => setViewport(event.currentTarget.value)}>
				{#each viewports as option (option.value)}<option value={option.value}>{option.label}</option>{/each}
			</select>
		</label>
	{/if}
</div>

<style>
	.settings {
		display: flex;
		flex-direction: column;
		gap: 10px;
		padding: 10px;
		color: var(--text-primary);
		font-size: 12px;
	}
	.field {
		display: flex;
		flex-direction: column;
		gap: 4px;
	}
	.field > span:first-child,
	.row > span {
		color: var(--text-secondary);
		font-size: 11px;
	}
	.row {
		display: flex;
		align-items: center;
		justify-content: space-between;
	}
	.with-unit {
		display: flex;
		align-items: center;
		gap: 4px;
		color: var(--text-tertiary);
	}
	.input {
		height: 28px;
		min-width: 0;
		border: 1px solid var(--border-subtle);
		border-radius: 6px;
		background: var(--bg-input);
		padding: 0 8px;
		color: var(--text-primary);
		font-size: 12px;
		outline: none;
	}
	.input:focus { border-color: var(--brand-border); }
	.input--number {
		flex: 1;
		width: 0;
		font-family: var(--font-mono);
		font-variant-numeric: tabular-nums;
		text-align: right;
	}
	@media (pointer: coarse) {
		.input { height: 36px; }
	}
</style>
