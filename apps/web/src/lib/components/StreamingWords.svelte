<script lang="ts">
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

$effect(() => {
	const currentText = text;
	const next = splitStreamingText(previousText, currentText, active);
	const tailChanged = next.tailText !== tailText;

	stableText = next.stableText;
	tailText = next.tailText;
	if (tailChanged && next.tailText) tailKey += 1;

	previousText = currentText;
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
