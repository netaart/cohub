<script lang="ts">
import { getLocale } from "$lib/i18n/locale.svelte";
import { m } from "$lib/paraglide/messages.js";
import AudioPlayer from "$lib/components/AudioPlayer.svelte";
import ScoreStaffView from "$lib/components/ScoreStaffView.svelte";

type Props = {
	src: string;
	score: string;
	title?: string | null;
	/** The native element of a chat bubble, or the app's own audio player for a detail panel. */
	variant: "chat" | "panel";
	/** The audio's index and title, for the accessible name. */
	audioLabel?: string;
	/** Starts the panel player once it is ready; the lightbox uses this. */
	autoplay?: boolean;
};

let {
	src,
	score,
	title = null,
	variant,
	audioLabel = "",
	autoplay = false,
}: Props = $props();

const locale = $derived(getLocale());
let audio = $state<HTMLAudioElement | null>(null);
</script>

{#if variant === "chat"}
	<div class="flex min-w-0 flex-col gap-2">
		<audio
			bind:this={audio}
			{src}
			controls
			preload="metadata"
			class="w-full"
			aria-label={audioLabel}
		></audio>
		<ScoreStaffView {score} {audio} {title} class="rounded-lg border border-border-subtle" />
	</div>
{:else}
	<div class="flex min-w-0 flex-col gap-3">
		<AudioPlayer {src} {title} {autoplay} bind:element={audio} />
		<ScoreStaffView {score} {audio} {title} class="overflow-hidden rounded-[6px]" />
	</div>
{/if}
