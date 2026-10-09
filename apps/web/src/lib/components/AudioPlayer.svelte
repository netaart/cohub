<script lang="ts">
import {
	Download,
	LoaderCircle,
	Pause,
	Play,
	TriangleAlert,
	Volume2,
	VolumeX,
} from "lucide-svelte";
import { onDestroy } from "svelte";
import { getLocale } from "$lib/i18n/locale.svelte";
import { m } from "$lib/paraglide/messages.js";

type Props = {
	src: string;
	title?: string | null;
	subtitle?: string | null;
	downloadUrl?: string | null;
	downloadName?: string | null;
	/** Plays once ready; switching it off pauses. */
	autoplay?: boolean;
};

let {
	src,
	title = null,
	subtitle = null,
	downloadUrl = null,
	downloadName = null,
	autoplay = false,
}: Props = $props();

const locale = $derived(getLocale());

const PLAYBACK_RATES = [0.75, 1, 1.25, 1.5, 2] as const;

let audioEl = $state<HTMLAudioElement | null>(null);
let status = $state<"loading" | "ready" | "error">("loading");
let playing = $state(false);
let currentTime = $state(0);
let duration = $state(0);
let rateIndex = $state(1);
let draftSeek: number | null = $state(null);
let volume = $state(100);
let muted = $state(false);
let lastVolume = $state(100);

const seekValue = $derived(draftSeek ?? currentTime);
const seekMax = $derived(duration > 0 ? duration : 0);
const seekPercent = $derived(
	seekMax > 0 ? Math.min(100, (seekValue / seekMax) * 100) : 0,
);
const currentRate = $derived(PLAYBACK_RATES[rateIndex]);

function formatTime(seconds: number) {
	if (!Number.isFinite(seconds) || seconds < 0) return "0:00";
	const total = Math.floor(seconds);
	const hours = Math.floor(total / 3600);
	const minutes = Math.floor((total % 3600) / 60);
	const secs = total % 60;
	const mm = hours > 0 ? String(minutes).padStart(2, "0") : String(minutes);
	const ss = String(secs).padStart(2, "0");
	return hours > 0 ? `${hours}:${mm}:${ss}` : `${mm}:${ss}`;
}

function resetState() {
	status = "loading";
	playing = false;
	currentTime = 0;
	duration = 0;
	rateIndex = 1;
	draftSeek = null;
}

function play(audio: HTMLAudioElement) {
	const requestedSrc = audio.getAttribute("src");
	void audio.play().catch((error: unknown) => {
		// Rapid pause / source switch rejects play() with AbortError, and a
		// blocked autoplay with NotAllowedError — neither is a media failure.
		// Real load errors surface via the error event below.
		if (
			error instanceof DOMException &&
			(error.name === "AbortError" || error.name === "NotAllowedError")
		)
			return;
		// Ignore rejections from a stale request (source already switched).
		if (audioEl !== audio || audio.getAttribute("src") !== requestedSrc) {
			return;
		}
		status = "error";
	});
}

function togglePlay() {
	const audio = audioEl;
	if (!audio || status !== "ready") return;
	if (audio.paused) play(audio);
	else audio.pause();
}

function applyVolume(value: number) {
	const audio = audioEl;
	if (!audio) return;
	// Keep the last non-zero level so unmuting restores the previous
	// volume even when the slider was dragged down to zero.
	if (value > 0) lastVolume = value;
	if (value <= 0) {
		audio.muted = true;
		muted = true;
	} else {
		audio.volume = value / 100;
		audio.muted = false;
		muted = false;
	}
}

function toggleMute() {
	const audio = audioEl;
	if (!audio) return;
	if (muted) {
		audio.muted = false;
		muted = false;
		const value = lastVolume > 0 ? lastVolume : 100;
		volume = value;
		audio.volume = value / 100;
	} else {
		audio.muted = true;
		muted = true;
	}
}

function commitSeek() {
	const audio = audioEl;
	if (draftSeek !== null && audio && Number.isFinite(audio.duration)) {
		audio.currentTime = Math.min(draftSeek, audio.duration);
	}
	draftSeek = null;
}

function cycleRate() {
	rateIndex = (rateIndex + 1) % PLAYBACK_RATES.length;
	if (audioEl) audioEl.playbackRate = PLAYBACK_RATES[rateIndex];
}

// Tracks the source this player was last initialized for. Svelte updates the
// DOM before this effect runs, so the element attribute can't be used to
// detect a source change — compare against the previous prop value instead.
let previousSrc: string | null = null;

$effect(() => {
	const audio = audioEl;
	const source = src;
	if (!audio) return;
	if (previousSrc === source) return;

	previousSrc = source;
	if (audio.getAttribute("src") !== source) {
		audio.setAttribute("src", source);
	}
	resetState();

	// Fast local sources (data: URIs, caches) can finish loading before our
	// event handlers are attached. Synchronize state directly instead of
	// re-loading, which would re-request the media.
	if (audio.error) {
		status = "error";
	} else if (audio.readyState >= 1) {
		duration = Number.isFinite(audio.duration) ? audio.duration : 0;
		audio.playbackRate = currentRate;
		status = "ready";
	}
});

onDestroy(() => {
	audioEl?.pause();
});

// Re-runs only on readiness or `autoplay` flips, so a manual pause sticks.
$effect(() => {
	const audio = audioEl;
	if (!audio || status !== "ready") return;
	if (autoplay) play(audio);
	else audio.pause();
});
</script>

<div class="audio-player" role="group" aria-label={title ?? "Audio player"}>
	<audio
		bind:this={audioEl}
		{src}
		preload="metadata"
		hidden
		onloadedmetadata={() => {
			if (!audioEl) return;
			duration = Number.isFinite(audioEl.duration) ? audioEl.duration : 0;
			audioEl.playbackRate = currentRate;
			status = "ready";
		}}
		ondurationchange={() => {
			if (audioEl && Number.isFinite(audioEl.duration)) {
				duration = audioEl.duration;
			}
		}}
		ontimeupdate={() => {
			if (audioEl) currentTime = audioEl.currentTime;
		}}
		onplay={() => (playing = true)}
		onpause={() => (playing = false)}
		onended={() => {
			playing = false;
			currentTime = 0;
		}}
		onerror={() => {
			status = "error";
		}}
	></audio>
	{#if status === "error"}
		<div class="audio-error-icon" aria-hidden="true">
			<TriangleAlert class="h-4 w-4" />
		</div>
		<div class="audio-error-body">
			<div class="audio-title">Audio unavailable</div>
			<div class="audio-error-hint">{m.audio_playback_failed({}, { locale })}</div>
		</div>
		{#if downloadUrl}
			<a
				class="audio-icon-btn"
				href={downloadUrl}
				download={downloadName ?? title ?? "audio"}
				title={m.download({}, { locale })}
				aria-label={m.audio_download({}, { locale })}
			>
				<Download class="h-4 w-4" />
			</a>
		{/if}
	{:else}
		<button
			type="button"
			class="audio-play"
			onclick={togglePlay}
			disabled={status !== "ready"}
			aria-label={playing ? "Pause" : "Play"}
			title={playing ? "Pause" : "Play"}
		>
			{#if status === "loading"}
				<span class="audio-spinner"><LoaderCircle class="h-5 w-5" /></span>
			{:else if playing}
				<Pause class="h-5 w-5 fill-current" />
			{:else}
				<Play class="h-5 w-5 fill-current" />
			{/if}
		</button>
		<div class="audio-body">
			<div class="audio-top">
				<span class="audio-title">{title ?? "Audio"}</span>
				{#if subtitle}
					<span class="audio-subtitle">{subtitle}</span>
				{/if}
				<div class="audio-top-spacer"></div>
				<button
					type="button"
					class="audio-rate"
					onclick={cycleRate}
					title={m.audio_playback_speed({}, { locale })}
					aria-label={`Playback speed ${currentRate}x`}
				>
					{currentRate}x
				</button>
				{#if downloadUrl}
					<a
						class="audio-icon-btn"
						href={downloadUrl}
						download={downloadName ?? title ?? "audio"}
						title={m.download({}, { locale })}
						aria-label={m.audio_download({}, { locale })}
					>
						<Download class="h-4 w-4" />
					</a>
				{/if}
			</div>
			<div class="audio-bottom">
				<input
					class="audio-progress"
					type="range"
					min={0}
					max={seekMax}
					step={0.1}
					value={seekValue}
					disabled={status !== "ready"}
					aria-label="Seek"
					style={`--seek-percent: ${seekPercent}%`}
					oninput={(event) => {
						draftSeek = Number(event.currentTarget.value);
					}}
					onchange={commitSeek}
				/>
				<span class="audio-time">
					{formatTime(seekValue)}
					<span class="audio-time-divider">/</span>
					{formatTime(duration)}
				</span>
			</div>
			<div class="audio-extra">
				<button
					type="button"
					class="audio-icon-btn"
					onclick={toggleMute}
					aria-label={muted ? "Unmute" : "Mute"}
					title={muted ? "Unmute" : "Mute"}
				>
					{#if muted || volume <= 0}
						<VolumeX class="h-4 w-4" />
					{:else}
						<Volume2 class="h-4 w-4" />
					{/if}
				</button>
				<input
					class="audio-progress audio-volume"
					type="range"
					min={0}
					max={100}
					step={1}
					value={muted ? 0 : volume}
					disabled={status !== "ready"}
					aria-label="Volume"
					style={`--seek-percent: ${muted ? 0 : volume}%`}
					oninput={(event) => {
						const value = Number(event.currentTarget.value);
						volume = value;
						applyVolume(value);
					}}
				/>
			</div>
		</div>
	{/if}
</div>

<style>
	.audio-player {
		display: flex;
		align-items: center;
		gap: 0.75rem;
		width: 100%;
		padding: 0.75rem 0.875rem;
		border: 1px solid var(--border-subtle);
		border-radius: 0.75rem;
		background: var(--bg-surface-muted, var(--bg-surface));
		color: var(--text-primary);
	}

	.audio-play {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		flex-shrink: 0;
		width: 2.25rem;
		height: 2.25rem;
		border: none;
		border-radius: 9999px;
		background: var(--brand);
		color: var(--brand-contrast-fg);
		cursor: pointer;
		transition:
			opacity 0.15s ease,
			transform 0.15s ease;
	}

	.audio-play:hover:not(:disabled) {
		opacity: 0.9;
		transform: scale(1.04);
	}

	.audio-play:active:not(:disabled) {
		transform: scale(0.96);
	}

	.audio-play:disabled {
		opacity: 0.55;
		cursor: default;
	}

	.audio-spinner {
		display: inline-flex;
		animation: audio-spin 0.9s linear infinite;
	}

	@keyframes audio-spin {
		to {
			transform: rotate(360deg);
		}
	}

	.audio-body {
		display: flex;
		flex: 1;
		min-width: 0;
		flex-direction: column;
		gap: 0.45rem;
	}

	.audio-top {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		min-width: 0;
	}

	.audio-title {
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		font-size: 0.8125rem;
		font-weight: 600;
	}

	.audio-subtitle {
		flex-shrink: 0;
		color: var(--text-tertiary);
		font-size: 0.75rem;
		font-variant-numeric: tabular-nums;
	}

	.audio-top-spacer {
		flex: 1;
	}

	.audio-rate {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		flex-shrink: 0;
		min-width: 2.25rem;
		height: 1.5rem;
		padding: 0 0.375rem;
		border: 1px solid var(--border-subtle);
		border-radius: 0.375rem;
		background: transparent;
		color: var(--text-tertiary);
		font-size: 0.6875rem;
		font-variant-numeric: tabular-nums;
		cursor: pointer;
		transition:
			color 0.15s ease,
			border-color 0.15s ease;
	}

	.audio-rate:hover {
		color: var(--text-primary);
		border-color: var(--text-tertiary);
	}

	.audio-icon-btn {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		flex-shrink: 0;
		width: 1.75rem;
		height: 1.75rem;
		border-radius: 0.375rem;
		color: var(--text-tertiary);
		transition:
			color 0.15s ease,
			background-color 0.15s ease;
	}

	.audio-icon-btn:hover {
		color: var(--text-primary);
		background: var(--bg-surface-hover);
	}

	.audio-bottom {
		display: flex;
		align-items: center;
		gap: 0.625rem;
		min-width: 0;
	}

	.audio-progress {
		flex: 1;
		min-width: 0;
		height: 0.375rem;
		margin: 0;
		-webkit-appearance: none;
		appearance: none;
		border-radius: 9999px;
		background:
			linear-gradient(
				to right,
				var(--brand) 0%,
				var(--brand) var(--seek-percent, 0%),
				var(--border-subtle) var(--seek-percent, 0%),
				var(--border-subtle) 100%
			);
		cursor: pointer;
	}

	.audio-progress::-webkit-slider-thumb {
		-webkit-appearance: none;
		appearance: none;
		width: 0.75rem;
		height: 0.75rem;
		border: none;
		border-radius: 9999px;
		background: var(--brand);
		box-shadow: 0 0 0 2px var(--bg-surface-muted, var(--bg-surface));
		transition: transform 0.12s ease;
	}

	.audio-progress::-webkit-slider-thumb:hover {
		transform: scale(1.15);
	}

	.audio-progress::-moz-range-thumb {
		width: 0.75rem;
		height: 0.75rem;
		border: none;
		border-radius: 9999px;
		background: var(--brand);
		box-shadow: 0 0 0 2px var(--bg-surface-muted, var(--bg-surface));
	}

	.audio-progress:disabled {
		opacity: 0.5;
		cursor: default;
	}

	.audio-time {
		flex-shrink: 0;
		color: var(--text-tertiary);
		font-size: 0.6875rem;
		font-variant-numeric: tabular-nums;
		white-space: nowrap;
	}

	.audio-time-divider {
		margin-inline: 0.25rem;
		opacity: 0.6;
	}

	.audio-extra {
		display: flex;
		align-items: center;
		gap: 0.375rem;
		min-width: 0;
	}

	.audio-extra .audio-icon-btn {
		width: 1.5rem;
		height: 1.5rem;
	}

	.audio-volume {
		flex: 0 1 8rem;
		min-width: 3rem;
		background:
			linear-gradient(
				to right,
				var(--text-tertiary) 0%,
				var(--text-tertiary) var(--seek-percent, 0%),
				var(--border-subtle) var(--seek-percent, 0%),
				var(--border-subtle) 100%
			);
	}

	.audio-volume::-webkit-slider-thumb {
		width: 0.625rem;
		height: 0.625rem;
		background: var(--text-tertiary);
	}

	.audio-volume::-moz-range-thumb {
		width: 0.625rem;
		height: 0.625rem;
		background: var(--text-tertiary);
	}

	.audio-error-icon {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		flex-shrink: 0;
		width: 2.25rem;
		height: 2.25rem;
		border-radius: 9999px;
		background: color-mix(in srgb, var(--error-400) 14%, transparent);
		color: var(--error-400);
	}

	.audio-error-body {
		display: flex;
		flex: 1;
		min-width: 0;
		flex-direction: column;
		gap: 0.125rem;
	}

	.audio-error-hint {
		color: var(--text-tertiary);
		font-size: 0.75rem;
	}
</style>
