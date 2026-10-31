<script lang="ts">
import { untrack } from "svelte";
import { getLocale } from "$lib/i18n/locale.svelte";
import { m } from "$lib/paraglide/messages.js";
import { mountScoreStaff, type ScoreStaff } from "$lib/score-editor/score-staff";
import { scorePlayPosition, scoreViewState } from "$lib/score-editor/score-viewer";

type Props = {
	/** The `.abc` text, as the generation or file holds it. */
	score: string;
	/** Draws the cursor from this audio; omit for a score with no audio. */
	audio?: HTMLAudioElement | null;
	/** Which song this is, for the accessible name. */
	title?: string | null;
	class?: string;
};

let { score, audio = null, title = null, class: className = "" }: Props =
	$props();

const locale = $derived(getLocale());
const view = $derived(scoreViewState(score));
const language = $derived<"en" | "zh">(locale === "zh-CN" ? "zh" : "en");
const label = $derived(
	title ? m.score_item_named({ title }, { locale }) : m.score_item({}, { locale }),
);

let host = $state<HTMLDivElement | null>(null);
let part = $state<ScoreStaff | null>(null);
let status = $state<"idle" | "loading" | "ready" | "failed">("idle");

$effect(() => {
	const el = host;
	const current = view;
	const lang = language;
	let cancelled = false;

	untrack(() => part)?.destroy();
	part = null;
	if (!el || current.kind === "empty") {
		status = "idle";
		return;
	}

	status = "loading";
	void mountScoreStaff(el, current.text, lang)
		.then((next) => {
			if (cancelled) {
				next.destroy();
				return;
			}
			part = next;
			status = "ready";
		})
		.catch((error: unknown) => {
			if (cancelled) return;
			status = "failed";
			console.warn("[score] failed to mount the staff view", error);
		});

	return () => {
		cancelled = true;
		untrack(() => part)?.destroy();
		part = null;
		el?.replaceChildren();
	};
});

/** Follows the audio's current time, including seek and pause; rAF keeps a playing cursor smooth. */
$effect(() => {
	const staff = part;
	const element = audio;
	if (!staff) return;
	if (!element) {
		staff.setPlayPosition(null);
		return;
	}

	let frame = 0;
	const draw = () => staff.setPlayPosition(scorePlayPosition(element.currentTime));
	const loop = () => {
		draw();
		frame = requestAnimationFrame(loop);
	};
	const start = () => {
		if (frame) return;
		draw();
		frame = requestAnimationFrame(loop);
	};
	const stop = () => {
		if (frame) cancelAnimationFrame(frame);
		frame = 0;
		draw();
	};

	const timed = ["timeupdate", "seeked", "loadedmetadata", "durationchange"] as const;
	for (const name of timed) element.addEventListener(name, draw);
	element.addEventListener("play", start);
	element.addEventListener("playing", start);
	element.addEventListener("pause", stop);
	element.addEventListener("ended", stop);
	element.addEventListener("emptied", stop);
	draw();
	if (!element.paused) start();

	return () => {
		if (frame) cancelAnimationFrame(frame);
		for (const name of timed) element.removeEventListener(name, draw);
		element.removeEventListener("play", start);
		element.removeEventListener("playing", start);
		element.removeEventListener("pause", stop);
		element.removeEventListener("ended", stop);
		element.removeEventListener("emptied", stop);
	};
});
</script>

{#if view.kind === "score"}
	<div
		class="score-staff {className}"
		class:score-staff--loading={status === "loading"}
		role="group"
		aria-label={label}
		aria-busy={status === "loading"}
	>
		<div class="score-staff-host" bind:this={host}></div>
		{#if status === "loading"}
			<span class="score-staff-note">{m.score_view_loading({}, { locale })}</span>
		{:else if status === "failed"}
			<span class="score-staff-note">{m.score_view_failed({}, { locale })}</span>
		{/if}
	</div>
{/if}

<style>
	.score-staff {
		position: relative;
		min-width: 0;
		min-height: 96px;
		background: var(--bg-elevated);
		color: var(--text-primary);
		/* Map the package's public theme variables onto the app's tokens. */
		--sce-color-bg: var(--bg-elevated);
		--sce-color-text: var(--text-primary);
		--sce-color-surface: var(--bg-surface);
		--sce-color-muted: var(--text-tertiary);
		--sce-color-line: var(--border-subtle);
		--sce-color-line-strong: var(--text-tertiary);
		--sce-color-accent: var(--brand);
		--sce-color-note: var(--text-primary);
		--sce-font-family: var(--font-sans);
	}

	.score-staff-host {
		min-width: 0;
	}

	.score-staff-note {
		position: absolute;
		inset: 0;
		display: flex;
		align-items: center;
		justify-content: center;
		padding: 12px;
		color: var(--text-tertiary);
		font-size: 12px;
	}

	.score-staff--loading .score-staff-host {
		opacity: 0;
	}
</style>
