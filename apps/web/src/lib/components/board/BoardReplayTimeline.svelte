<script lang="ts">
import type { BoardReplayEntry } from "@neta-art/cohub/board";
import {
	ChevronFirst,
	ChevronLast,
	ChevronLeft,
	ChevronRight,
	Crosshair,
	Pause,
	Play,
	X,
} from "lucide-svelte";
import type { BoardCollaboratorProfile } from "$lib/board/board-activity";
import { collaborationColorToken } from "$lib/board/board-awareness";
import {
	BOARD_REPLAY_SPEEDS,
	type BoardReplaySpeed,
	replayEntryAt,
	replayFraction,
	replayStep,
	replayVersionAt,
} from "$lib/board/board-replay";
import UserAvatar from "$lib/components/UserAvatar.svelte";
import { getLocale } from "$lib/i18n/locale.svelte";
import { m } from "$lib/paraglide/messages.js";

const {
	entries,
	floor,
	head,
	version,
	playing,
	speed,
	follow,
	hasOlder,
	olderState,
	profiles,
	isMobile = false,
	onSeek,
	onTogglePlay,
	onStep,
	onSpeed,
	onToggleFollow,
	onLoadOlder,
	onClose,
}: {
	entries: readonly BoardReplayEntry[];
	floor: number;
	head: number;
	version: number;
	playing: boolean;
	speed: BoardReplaySpeed;
	follow: boolean;
	hasOlder: boolean;
	olderState: "idle" | "loading" | "failed";
	profiles: Map<string, BoardCollaboratorProfile>;
	isMobile?: boolean;
	onSeek: (version: number) => void;
	onTogglePlay: () => void;
	onStep: (direction: -1 | 1) => void;
	onSpeed: (speed: BoardReplaySpeed) => void;
	onToggleFollow: () => void;
	onLoadOlder: () => void;
	onClose: () => void;
} = $props();

const locale = $derived(getLocale());

let track: HTMLDivElement | null = $state(null);
let scrubbing = $state(false);

const fraction = $derived(replayFraction(entries, floor, version));
const current = $derived(replayEntryAt(entries, version));
const index = $derived(replayStep(entries, floor, version));
const atStart = $derived(version <= floor);
const atEnd = $derived(version >= head);

const relativeFormat = $derived(
	new Intl.RelativeTimeFormat(locale, { numeric: "auto" }),
);
const absoluteFormat = $derived(
	new Intl.DateTimeFormat(locale, {
		dateStyle: "medium",
		timeStyle: "short",
	}),
);

function relative(at: number): string {
	const seconds = Math.round((at - Date.now()) / 1000);
	const abs = Math.abs(seconds);
	if (abs < 60) return relativeFormat.format(seconds, "second");
	if (abs < 3600)
		return relativeFormat.format(Math.round(seconds / 60), "minute");
	if (abs < 86400)
		return relativeFormat.format(Math.round(seconds / 3600), "hour");
	if (abs < 86400 * 30)
		return relativeFormat.format(Math.round(seconds / 86400), "day");
	return absoluteFormat.format(at);
}

function actorName(entry: BoardReplayEntry): string {
	if (entry.kind === "cli") return m.board_replay_actor_cli({}, { locale });
	if (entry.kind === "agent") return m.board_replay_actor_agent({}, { locale });
	return profiles.get(entry.actorId)?.displayName ?? entry.actorId.slice(0, 8);
}

function seekFromPointer(event: PointerEvent) {
	if (!track) return;
	const rect = track.getBoundingClientRect();
	const next = replayVersionAt(
		entries,
		floor,
		(event.clientX - rect.left) / Math.max(rect.width, 1),
	);
	if (next !== version) onSeek(next);
}

function handleTrackPointerDown(event: PointerEvent) {
	if (event.button !== 0) return;
	event.preventDefault();
	track?.setPointerCapture(event.pointerId);
	scrubbing = true;
	seekFromPointer(event);
}

function handleTrackPointerMove(event: PointerEvent) {
	if (scrubbing) seekFromPointer(event);
}

function handleTrackPointerUp(event: PointerEvent) {
	if (!scrubbing) return;
	scrubbing = false;
	track?.releasePointerCapture(event.pointerId);
}

function tickLeft(entryIndex: number): string {
	return `${((entryIndex + 1) / entries.length) * 100}%`;
}
</script>

<div
	class="replay-bar"
	class:replay-bar--mobile={isMobile}
	role="toolbar"
	aria-label={m.board_replay_title({}, { locale })}
>
	<div class="replay-head">
		<span class="replay-badge">{m.board_replay_title({}, { locale })}</span>
		<div class="replay-status" aria-live="polite">
			{#if current}
				{#if current.kind === "human"}
					<UserAvatar
						name={profiles.get(current.actorId)?.displayName ?? current.actorId}
						avatarUrl={profiles.get(current.actorId)?.avatarUrl ?? null}
						size="xxs"
					/>
				{:else}
					<span
						class="replay-actor-dot"
						style:background={`var(${collaborationColorToken(current.actorId)})`}
					></span>
				{/if}
				<span class="replay-actor">{actorName(current)}</span>
				<span class="replay-sep">·</span>
				<span class="replay-time" title={absoluteFormat.format(current.at)}>{relative(current.at)}</span>
				<span class="replay-sep">·</span>
				<span class="replay-version">{m.board_replay_version({ version }, { locale })}</span>
			{:else if atStart}
				<span class="replay-actor">{m.board_replay_start({}, { locale })}</span>
				{#if hasOlder}
					<span class="replay-sep">·</span>
					<button
						type="button"
						class="replay-link"
						class:replay-link--failed={olderState === "failed"}
						disabled={olderState === "loading"}
						onclick={onLoadOlder}
					>
						{olderState === "loading"
							? m.common_loading({}, { locale })
							: olderState === "failed"
								? m.board_replay_load_older_failed({}, { locale })
								: m.board_replay_load_older({}, { locale })}
					</button>
				{/if}
			{:else}
				<span class="replay-version">{m.board_replay_version({ version }, { locale })}</span>
			{/if}
		</div>
		<span class="replay-progress">{m.board_replay_progress({ index, total: entries.length }, { locale })}</span>
		<button
			type="button"
			class="replay-btn"
			title={m.common_close({}, { locale })}
			aria-label={m.common_close({}, { locale })}
			onclick={onClose}
		>
			<X class="h-3.5 w-3.5" />
		</button>
	</div>

	<div
		bind:this={track}
		class="replay-track"
		class:replay-track--scrubbing={scrubbing}
		role="slider"
		tabindex="0"
		aria-label={m.board_replay_title({}, { locale })}
		aria-valuemin={floor}
		aria-valuemax={head}
		aria-valuenow={version}
		aria-valuetext={m.board_replay_version({ version }, { locale })}
		onpointerdown={handleTrackPointerDown}
		onpointermove={handleTrackPointerMove}
		onpointerup={handleTrackPointerUp}
		onpointercancel={handleTrackPointerUp}
	>
		<div class="replay-rail"></div>
		<div class="replay-fill" style:width={`${fraction * 100}%`}></div>
		{#each entries as entry, entryIndex (entry.version)}
			<span
				class="replay-tick"
				class:replay-tick--past={entry.version <= version}
				style:left={tickLeft(entryIndex)}
				style:--tick-color={`var(${collaborationColorToken(entry.actorId)})`}
			></span>
		{/each}
		<div class="replay-thumb" style:left={`${fraction * 100}%`}></div>
	</div>

	<div class="replay-controls">
		<button type="button" class="replay-btn" title={m.board_replay_to_start({}, { locale })} aria-label={m.board_replay_to_start({}, { locale })} disabled={atStart} onclick={() => onSeek(floor)}>
			<ChevronFirst class="h-4 w-4" />
		</button>
		<button type="button" class="replay-btn" title={m.board_replay_step_back({}, { locale })} aria-label={m.board_replay_step_back({}, { locale })} disabled={atStart} onclick={() => onStep(-1)}>
			<ChevronLeft class="h-4 w-4" />
		</button>
		<button
			type="button"
			class="replay-btn replay-btn--primary"
			title={playing ? m.board_replay_pause({}, { locale }) : m.board_replay_play({}, { locale })}
			aria-label={playing ? m.board_replay_pause({}, { locale }) : m.board_replay_play({}, { locale })}
			aria-pressed={playing}
			onclick={onTogglePlay}
		>
			{#if playing}
				<Pause class="h-4 w-4" />
			{:else}
				<Play class="h-4 w-4 translate-x-px" />
			{/if}
		</button>
		<button type="button" class="replay-btn" title={m.board_replay_step_forward({}, { locale })} aria-label={m.board_replay_step_forward({}, { locale })} disabled={atEnd} onclick={() => onStep(1)}>
			<ChevronRight class="h-4 w-4" />
		</button>
		<button type="button" class="replay-btn" title={m.board_replay_to_end({}, { locale })} aria-label={m.board_replay_to_end({}, { locale })} disabled={atEnd} onclick={() => onSeek(head)}>
			<ChevronLast class="h-4 w-4" />
		</button>

		<div class="replay-divider"></div>

		<div class="replay-speeds" role="group" aria-label={m.board_replay_speed({}, { locale })}>
			{#each BOARD_REPLAY_SPEEDS as option (option)}
				<button
					type="button"
					class="replay-speed"
					class:replay-speed--active={speed === option}
					aria-pressed={speed === option}
					onclick={() => onSpeed(option)}
				>
					{option}×
				</button>
			{/each}
		</div>

		<div class="replay-divider"></div>

		<button
			type="button"
			class="replay-btn"
			class:replay-btn--on={follow}
			title={m.board_replay_follow({}, { locale })}
			aria-label={m.board_replay_follow({}, { locale })}
			aria-pressed={follow}
			onclick={onToggleFollow}
		>
			<Crosshair class="h-4 w-4" />
		</button>
	</div>
</div>

<style>
	.replay-bar {
		position: absolute;
		left: 50%;
		bottom: 14px;
		z-index: 30;
		display: flex;
		width: min(640px, calc(100% - 28px));
		flex-direction: column;
		gap: 8px;
		border-radius: 12px;
		border: 1px solid var(--border-subtle);
		background: color-mix(in srgb, var(--bg-elevated) 94%, transparent);
		padding: 10px 12px 8px;
		box-shadow: 0 12px 28px color-mix(in srgb, var(--overlay-scrim-strong) 18%, transparent);
		backdrop-filter: blur(14px);
		transform: translateX(-50%);
		animation: replay-enter var(--motion-duration-modal-in, 200ms) cubic-bezier(0.16, 1, 0.3, 1) both;
	}

	@keyframes replay-enter {
		from { opacity: 0; transform: translate(-50%, 8px); }
		to { opacity: 1; transform: translate(-50%, 0); }
	}

	.replay-bar--mobile {
		left: 10px;
		right: 10px;
		bottom: calc(10px + env(safe-area-inset-bottom, 0px));
		width: auto;
		transform: none;
		animation-name: replay-enter-mobile;
	}

	@keyframes replay-enter-mobile {
		from { opacity: 0; transform: translateY(8px); }
		to { opacity: 1; transform: translateY(0); }
	}

	.replay-head {
		display: flex;
		align-items: center;
		gap: 8px;
		min-width: 0;
		font-size: 11px;
		color: var(--text-secondary);
	}

	.replay-badge {
		flex-shrink: 0;
		border-radius: 5px;
		background: color-mix(in srgb, var(--brand) 14%, transparent);
		padding: 2px 6px;
		color: var(--brand);
		font-size: 10px;
		font-weight: 600;
		letter-spacing: 0.04em;
		text-transform: uppercase;
	}

	.replay-status {
		display: flex;
		min-width: 0;
		flex: 1;
		align-items: center;
		gap: 5px;
		white-space: nowrap;
		overflow: hidden;
	}

	.replay-actor {
		overflow: hidden;
		text-overflow: ellipsis;
		color: var(--text-primary);
		font-weight: 500;
	}

	.replay-actor-dot {
		width: 8px;
		height: 8px;
		flex-shrink: 0;
		border-radius: 50%;
	}

	.replay-sep { color: var(--text-tertiary); }
	.replay-time { color: var(--text-tertiary); }

	.replay-version,
	.replay-progress {
		color: var(--text-tertiary);
		font-variant-numeric: tabular-nums;
	}

	.replay-progress { flex-shrink: 0; }

	.replay-link {
		color: var(--brand);
		text-decoration: underline;
		text-underline-offset: 2px;
	}
	.replay-link:disabled { color: var(--text-tertiary); text-decoration: none; }
	.replay-link--failed { color: var(--error-soft); }

	.replay-track {
		position: relative;
		height: 22px;
		cursor: pointer;
		touch-action: none;
		border-radius: 6px;
		outline: none;
	}
	.replay-track:focus-visible {
		box-shadow: 0 0 0 2px color-mix(in srgb, var(--brand) 40%, transparent);
	}
	.replay-track--scrubbing { cursor: grabbing; }

	.replay-rail,
	.replay-fill {
		position: absolute;
		top: 50%;
		left: 0;
		height: 3px;
		border-radius: 2px;
		transform: translateY(-50%);
	}
	.replay-rail {
		right: 0;
		background: color-mix(in srgb, var(--text-tertiary) 28%, transparent);
	}
	.replay-fill {
		background: var(--brand);
		transition: width 120ms cubic-bezier(0.16, 1, 0.3, 1);
	}
	.replay-track--scrubbing .replay-fill,
	.replay-track--scrubbing .replay-thumb { transition: none; }

	.replay-tick {
		position: absolute;
		top: 50%;
		width: 2px;
		height: 9px;
		border-radius: 1px;
		background: var(--tick-color);
		opacity: 0.32;
		transform: translate(-50%, -50%);
		pointer-events: none;
	}
	.replay-tick--past { opacity: 0.85; }

	.replay-thumb {
		position: absolute;
		top: 50%;
		width: 12px;
		height: 12px;
		border-radius: 50%;
		border: 2px solid var(--bg-elevated);
		background: var(--brand);
		box-shadow: 0 1px 4px color-mix(in srgb, var(--overlay-scrim-strong) 30%, transparent);
		transform: translate(-50%, -50%);
		transition: left 120ms cubic-bezier(0.16, 1, 0.3, 1);
		pointer-events: none;
	}

	.replay-controls {
		display: flex;
		align-items: center;
		justify-content: center;
		gap: 2px;
	}

	.replay-btn {
		display: inline-flex;
		width: 28px;
		height: 28px;
		align-items: center;
		justify-content: center;
		border-radius: 7px;
		color: var(--text-secondary);
		transition: background-color 100ms ease, color 100ms ease;
	}
	.replay-btn:hover:not(:disabled) { background: var(--bg-hover); color: var(--text-primary); }
	.replay-btn:disabled { color: var(--text-tertiary); opacity: 0.5; }
	.replay-btn--primary {
		width: 34px;
		height: 30px;
		margin: 0 2px;
		background: var(--brand);
		color: var(--text-on-brand, white);
	}
	.replay-btn--primary:hover:not(:disabled) {
		background: color-mix(in srgb, var(--brand) 88%, black);
		color: var(--text-on-brand, white);
	}
	.replay-btn--on { color: var(--brand); background: color-mix(in srgb, var(--brand) 12%, transparent); }

	.replay-divider {
		width: 1px;
		height: 16px;
		margin: 0 6px;
		background: var(--border-subtle);
	}

	.replay-speeds {
		display: flex;
		gap: 1px;
		border-radius: 7px;
		background: color-mix(in srgb, var(--text-tertiary) 10%, transparent);
		padding: 2px;
	}
	.replay-speed {
		min-width: 30px;
		height: 22px;
		border-radius: 5px;
		color: var(--text-tertiary);
		font-size: 10.5px;
		font-variant-numeric: tabular-nums;
		font-weight: 500;
		transition: background-color 100ms ease, color 100ms ease;
	}
	.replay-speed:hover { color: var(--text-primary); }
	.replay-speed--active { background: var(--bg-elevated); color: var(--text-primary); box-shadow: 0 1px 2px color-mix(in srgb, var(--overlay-scrim-strong) 12%, transparent); }

	@media (pointer: coarse) {
		.replay-btn { width: 40px; height: 40px; }
		.replay-btn--primary { width: 48px; height: 40px; }
		.replay-speed { min-width: 38px; height: 30px; }
		.replay-track { height: 30px; }
		.replay-thumb { width: 16px; height: 16px; }
	}

	@media (prefers-reduced-motion: reduce) {
		.replay-bar { animation: none; }
		.replay-fill,
		.replay-thumb { transition: none; }
	}
</style>
