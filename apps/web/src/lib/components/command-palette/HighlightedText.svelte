<script lang="ts">
import type { SearchTextRange } from "@neta-art/cohub";

const {
	text,
	ranges = [],
}: {
	text: string;
	ranges?: readonly SearchTextRange[];
} = $props();

type Segment = { text: string; match: boolean };

const segments = $derived.by(() => {
	const parts: Segment[] = [];
	let cursor = 0;
	for (const [rawStart, rawEnd] of [...ranges].sort((a, b) => a[0] - b[0])) {
		const start = Math.max(cursor, rawStart);
		const end = Math.min(text.length, rawEnd);
		if (end <= start) continue;
		if (start > cursor)
			parts.push({ text: text.slice(cursor, start), match: false });
		parts.push({ text: text.slice(start, end), match: true });
		cursor = end;
	}
	if (cursor < text.length)
		parts.push({ text: text.slice(cursor), match: false });
	return parts;
});
</script>

{#each segments as segment, index (index)}{#if segment.match}<mark>{segment.text}</mark>{:else}{segment.text}{/if}{/each}

<style>
	mark {
		background: transparent;
		color: var(--brand);
	}
</style>
