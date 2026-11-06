<script lang="ts">
import { onDestroy, untrack } from "svelte";
import { splitStreamingText } from "$lib/streaming-text";

type Props = {
	text: string;
	active?: boolean;
	tone?: "default" | "muted";
};

const { text, active = true, tone = "default" }: Props = $props();

// Matches the streaming markdown commit cadence instead of every patch.
const REVEAL_INTERVAL_MS = 80;

let previousText = "";
let stableText = $state("");
let tailText = $state("");
let tailKey = $state(0);
let shownAt = 0;
let timer: ReturnType<typeof setTimeout> | null = null;

function show(currentText: string) {
	const next = splitStreamingText(previousText, currentText, active);
	if (next.tailText && next.tailText !== tailText) tailKey += 1;
	stableText = next.stableText;
	tailText = next.tailText;
	previousText = currentText;
	shownAt = performance.now();
}

$effect(() => {
	const currentText = text;
	const settled = !active;
	if (settled && timer) {
		clearTimeout(timer);
		timer = null;
	}
	if (timer) return;
	const wait = settled ? 0 : REVEAL_INTERVAL_MS - (performance.now() - shownAt);
	if (wait <= 0) {
		untrack(() => show(currentText));
		return;
	}
	timer = setTimeout(() => {
		timer = null;
		show(text);
	}, wait);
});

onDestroy(() => {
	if (timer) clearTimeout(timer);
});
</script>

<span
	class="streaming-words"
	class:streaming-words-muted={tone === 'muted'}
	aria-live="off"
>
	{stableText}
	{#if tailText}
		{#key tailKey}
			<span class="streaming-tail" class:streaming-tail-muted={tone === 'muted'}
				>{tailText}</span
			>
		{/key}
	{/if}
	{#if active}
		<span class="streaming-caret" aria-hidden="true"></span>
	{/if}
</span>
