<script lang="ts">
import type { MessagePart } from "$lib/paraglide/runtime.js";

const {
	parts,
	strongClass = "",
}: { parts: MessagePart[]; strongClass?: string } = $props();

const segments = $derived.by(() => {
	const out: { text: string; strong: boolean }[] = [];
	let depth = 0;
	for (const part of parts) {
		if (part.type === "markup-start" && part.name === "b") depth += 1;
		else if (part.type === "markup-end" && part.name === "b")
			depth = Math.max(0, depth - 1);
		else if (part.type === "text")
			out.push({ text: part.value, strong: depth > 0 });
	}
	return out;
});
</script>

{#each segments as segment, index (index)}{#if segment.strong}<strong class={strongClass}>{segment.text}</strong>{:else}{segment.text}{/if}{/each}
