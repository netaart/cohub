<script lang="ts">
/** One Turn's fan-out to other Sessions, rendered inside the process card. */
import { ArrowUpRight } from "lucide-svelte";
import RelatedSessionLink from "$lib/components/RelatedSessionLink.svelte";
import type { SentSession } from "$lib/sent-turns";

const { sessions }: { sessions: readonly SentSession[] } = $props();
</script>

{#if sessions.length > 0}
	<div
		class="ml-[3px] border-l border-border-subtle/70 py-1 pl-[21px] pr-2 max-sm:pl-3 max-sm:pr-1"
	>
		<div class="space-y-0.5">
			{#each sessions as session (`${session.spaceId}:${session.sessionId}`)}
				<RelatedSessionLink
					ref={session}
					class="group flex min-h-7 w-full items-center gap-2 rounded-md py-1 pr-1 text-left transition-colors duration-150 [&[href]]:hover:bg-bg-hover/50"
				>
					{#snippet children({ label, status })}
						<span class="h-1.5 w-1.5 shrink-0 rounded-full bg-brand/70"></span>
						{#if status === "loading"}
							<span
								class="h-3 w-32 max-w-[60%] rounded-[3px] bg-bg-surface"
								aria-hidden="true"
							></span>
						{:else}
							<span
								class="min-w-0 truncate text-[13px] {status === 'unavailable'
									? 'text-text-placeholder'
									: 'text-text-secondary'}"
							>
								{label}
							</span>
						{/if}
						{#if session.count > 1}
							<span class="shrink-0 text-[12px] tabular-nums text-text-placeholder"
								>×{session.count}</span
							>
						{/if}
						{#if status !== "unavailable"}
							<ArrowUpRight
								class="ml-auto h-3.5 w-3.5 shrink-0 text-text-placeholder opacity-0 transition-opacity group-hover:opacity-100"
							/>
						{/if}
					{/snippet}
				</RelatedSessionLink>
			{/each}
		</div>
	</div>
{/if}
