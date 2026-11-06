<script lang="ts">
import { onDestroy, untrack } from "svelte";
import { splitStreamingText } from "$lib/streaming-text";

type Props = {
	text: string;
	active?: boolean;
	tone?: "default" | "muted";
};

const { text, active = true, tone = "default" }: Props = $props();

let previousText = "";
let stableText = $state("");
let tailText = $state("");
let tailKey = $state(0);
let frame = 0;

function show() {
	const next = splitStreamingText(previousText, text, active);
	if (next.tailText && next.tailText !== tailText) tailKey += 1;
	stableText = next.stableText;
	tailText = next.tailText;
	previousText = text;
}

// Live text paints once per display frame; the first and the settled text paint at once.
$effect(() => {
	text;
	if (!active || !previousText) {
		cancelAnimationFrame(frame);
		frame = 0;
		untrack(show);
		return;
	}
	frame ||= requestAnimationFrame(() => {
		frame = 0;
		show();
	});
});

onDestroy(() => cancelAnimationFrame(frame));
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
