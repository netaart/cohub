<script lang="ts">
import type { CodexQuestionReply } from "$lib/messages/codex-question-reply";

const { replies }: { replies: CodexQuestionReply[] } = $props();
</script>

<div class="min-w-0 space-y-3">
	{#each replies as reply}
		<div class="min-w-0">
			<details class="group min-w-0">
				<summary class="cursor-pointer truncate rounded-sm text-sm text-text-secondary group-open:whitespace-pre-wrap group-open:break-words group-open:[overflow-wrap:anywhere] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-brand">
					{reply.question}
				</summary>
			</details>
			<p class="mt-1 whitespace-pre-wrap break-words [overflow-wrap:anywhere]">{reply.answer}</p>
		</div>
	{/each}
</div>
