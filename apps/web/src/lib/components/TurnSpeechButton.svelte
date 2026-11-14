<script lang="ts">
import type { SessionTurnRecord } from "@cohub/protocol";
import { Loader2, Pause, Play, TriangleAlert, Volume2 } from "lucide-svelte";
import { untrack } from "svelte";
import { getLocale } from "$lib/i18n/locale.svelte";
import { m } from "$lib/paraglide/messages.js";
import {
	getSpeechVoice,
	turnSpeechPlayer,
	useTurnSpeech,
} from "$lib/turn-speech.svelte";

const { turn }: { turn: SessionTurnRecord } = $props();

const locale = $derived(getLocale());
const spaceId = useTurnSpeech();
const currentSpaceId = $derived(spaceId?.() ?? null);
const phase = $derived(turnSpeechPlayer.phaseOf(turn.id));
const voice = $derived(currentSpaceId ? getSpeechVoice(currentSpaceId) : null);
const speakable = $derived(
	turn.status === "completed" &&
		(turn.executionKind ?? "agent") === "agent" &&
		Boolean(turn.assistantText?.trim()),
);
const label = $derived(
	phase === "loading"
		? m.chat_read_aloud_preparing({}, { locale })
		: phase === "playing"
			? m.chat_read_aloud_pause({}, { locale })
			: phase === "paused"
				? m.chat_read_aloud_resume({}, { locale })
				: phase === "error"
					? m.chat_read_aloud_failed({}, { locale })
					: m.chat_read_aloud({}, { locale }),
);

$effect(() => {
	const latest = turn;
	untrack(() => turnSpeechPlayer.sync(latest));
});
</script>

{#if speakable && currentSpaceId && voice}
	<button
		type="button"
		class="inline-flex shrink-0 cursor-pointer items-center rounded p-1 transition-opacity hover:opacity-100 {phase === 'idle'
			? 'opacity-60'
			: phase === 'error'
				? 'text-warning-soft opacity-90'
				: 'text-brand opacity-100'}"
		onclick={(event) => {
			event.stopPropagation();
			turnSpeechPlayer.toggle(currentSpaceId, voice, turn);
		}}
		title={label}
		aria-label={label}
		aria-pressed={phase === "playing"}
	>
		{#if phase === "loading"}
			<Loader2 class="h-3.5 w-3.5 animate-spin" />
		{:else if phase === "playing"}
			<Pause class="h-3.5 w-3.5" />
		{:else if phase === "paused"}
			<Play class="h-3.5 w-3.5" />
		{:else if phase === "error"}
			<TriangleAlert class="h-3.5 w-3.5" />
		{:else}
			<Volume2 class="h-3.5 w-3.5" />
		{/if}
	</button>
{/if}
