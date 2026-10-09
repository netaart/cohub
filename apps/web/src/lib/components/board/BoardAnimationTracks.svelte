<script lang="ts">
import {
	Camera,
	Diamond,
	Palette,
	Sparkles,
	Trash2,
	Type,
} from "lucide-svelte";
import type { BoardTrackRow } from "$lib/board/animation-tracks";
import { getLocale } from "$lib/i18n/locale.svelte";
import { m } from "$lib/paraglide/messages.js";

const {
	rows,
	duration,
	time,
	selectedKey,
	readonly = false,
	onSelectKeyframe,
	onRemoveKeyframe,
}: {
	rows: BoardTrackRow[];
	duration: number;
	time: number;
	selectedKey: string | null;
	readonly?: boolean;
	onSelectKeyframe: (row: BoardTrackRow, at: number) => void;
	onRemoveKeyframe: (row: BoardTrackRow, at: number) => void;
} = $props();

const locale = $derived(getLocale());
const safeDuration = $derived(Math.max(1, duration));
const playheadPercent = $derived(
	Math.min(100, Math.max(0, (time / safeDuration) * 100)),
);

function keyId(row: BoardTrackRow, at: number) {
	return `${row.id}:${at}`;
}

function iconFor(row: BoardTrackRow) {
	if (row.kind === "camera") return Camera;
	if (row.property.startsWith("style.")) return Palette;
	if (row.property.startsWith("props.") || row.itemType === "text") return Type;
	return Sparkles;
}

function rowLabel(row: BoardTrackRow) {
	if (row.kind !== "camera") return row.label;
	if (row.property === "focus") return m.board_camera_focus({}, { locale });
	if (row.property === "zoom") return m.board_camera_zoom({}, { locale });
	if (row.property === "shake") return m.board_camera_shake({}, { locale });
	return row.label;
}

function offsetPercent(at: number) {
	return (at / safeDuration) * 100;
}

function formatValue(value: unknown): string {
	if (typeof value === "number")
		return Number.isInteger(value) ? String(value) : value.toFixed(2);
	if (value && typeof value === "object") {
		const record = value as Record<string, unknown>;
		if (typeof record.x === "number" && typeof record.y === "number")
			return `${Math.round(record.x)}, ${Math.round(record.y)}`;
	}
	if (typeof value === "boolean")
		return value ? m.space_on({}, { locale }) : m.space_off({}, { locale });
	if (typeof value === "string") return value;
	return "";
}
</script>

{#if rows.length === 0}
	<p class="tracks-empty">{m.board_track_no_tracks({}, { locale })}</p>
{:else}
	<div class="tracks" role="list">
		{#each rows as row (row.id)}
			{@const Icon = iconFor(row)}
			{@const selectedAt = selectedKey?.startsWith(`${row.id}:`)
				? Number(selectedKey.slice(row.id.length + 1))
				: null}
			<div
				class="track-row"
				class:track-row--camera={row.kind === "camera"}
				role="listitem"
			>
				<div class="track-label" title="{rowLabel(row)} · {row.property}">
					<Icon class="h-3 w-3 shrink-0" />
					<span class="track-name">{rowLabel(row)}</span>
				</div>
				<div class="track-lane">
					<div class="track-line"></div>
					<div class="track-playhead" style:left="{playheadPercent}%"></div>
					{#each row.keyframes as keyframe (keyframe.at)}
						<button
							type="button"
							class="track-key"
							class:track-key--selected={selectedAt === keyframe.at}
							style:left="{offsetPercent(keyframe.at)}%"
							title="{formatValue(keyframe.value)} · {(keyframe.at / 1000).toFixed(2)}s"
							aria-label="{rowLabel(row)} {(keyframe.at / 1000).toFixed(2)}s"
							onclick={() => onSelectKeyframe(row, keyframe.at)}
						>
							<Diamond class="h-2.5 w-2.5" fill="currentColor" />
						</button>
					{/each}
				</div>
				{#if !readonly && selectedAt !== null}
					<button
						type="button"
						class="track-remove"
						title={m.board_track_keyframe_remove({}, { locale })}
						aria-label={m.board_track_keyframe_remove({}, { locale })}
						onclick={() => onRemoveKeyframe(row, selectedAt)}
					>
						<Trash2 class="h-3 w-3" />
					</button>
				{:else}
					<span class="track-remove-spacer" aria-hidden="true"></span>
				{/if}
			</div>
		{/each}
	</div>
{/if}

<style>
	.tracks {
		display: flex;
		flex-direction: column;
		gap: 1px;
		max-height: 132px;
		overflow-y: auto;
		overscroll-behavior: contain;
		scrollbar-width: thin;
	}

	.tracks-empty {
		padding: 10px 4px;
		color: var(--text-tertiary);
		font-size: 11px;
		text-align: center;
	}

	.track-row {
		display: flex;
		align-items: center;
		gap: 8px;
		min-height: 22px;
		border-radius: 5px;
		padding: 0 2px;
	}
	.track-row:hover { background: color-mix(in srgb, var(--bg-hover) 60%, transparent); }

	.track-label {
		display: flex;
		flex-shrink: 0;
		align-items: center;
		gap: 5px;
		width: 112px;
		min-width: 0;
		color: var(--text-secondary);
		font-size: 11px;
	}
	.track-row--camera .track-label { color: var(--brand-muted-fg); }
	.track-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

	.track-lane {
		position: relative;
		flex: 1;
		height: 22px;
		min-width: 0;
	}

	.track-line {
		position: absolute;
		top: 50%;
		right: 0;
		left: 0;
		height: 1px;
		translate: 0 -50%;
		background: var(--border-subtle);
	}

	.track-playhead {
		position: absolute;
		top: 2px;
		bottom: 2px;
		width: 1px;
		background: color-mix(in srgb, var(--text-primary) 45%, transparent);
		pointer-events: none;
	}

	.track-key {
		position: absolute;
		top: 50%;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 16px;
		height: 16px;
		translate: -50% -50%;
		border-radius: 4px;
		color: var(--text-tertiary);
		cursor: pointer;
		transition: color 100ms ease;
	}
	.track-row--camera .track-key { color: var(--brand-muted-fg); }
	.track-key:hover { color: var(--text-primary); }
	.track-key--selected { color: var(--brand); }

	.track-remove,
	.track-remove-spacer {
		display: inline-flex;
		flex-shrink: 0;
		width: 20px;
		height: 20px;
	}
	.track-remove {
		align-items: center;
		justify-content: center;
		border-radius: 5px;
		color: var(--text-tertiary);
		cursor: pointer;
	}
	.track-remove:hover { background: var(--error-bg); color: var(--error-soft); }

	@media (pointer: coarse) {
		.track-label { width: 84px; }
		.track-row { min-height: 30px; }
		.track-key { width: 24px; height: 24px; }
		.track-remove,
		.track-remove-spacer { width: 30px; height: 30px; }
	}
</style>
