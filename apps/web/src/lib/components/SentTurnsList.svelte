<script lang="ts">
/** One Turn's fan-out to other Sessions, rendered inside the process card. */
import { ArrowUpRight } from "lucide-svelte";
import { getLocale } from "$lib/i18n/locale.svelte";
import { m } from "$lib/paraglide/messages.js";
import type { SentTurnLink } from "$lib/sent-turns";
import { buildSpaceSessionRoute } from "$lib/space-routes";

const { links, spaceId }: { links: SentTurnLink[]; spaceId: string } = $props();

const locale = $derived(getLocale());

const shortId = (value: string) => value.slice(0, 8);
</script>

{#if links.length > 0}
	<div
		class="ml-[3px] border-l border-border-subtle/70 py-1 pl-[21px] pr-2 max-sm:pl-3 max-sm:pr-1"
	>
		<div class="space-y-0.5">
			{#each links as link (link.turnId)}
				<a
					href={buildSpaceSessionRoute(spaceId, link.sessionId)}
					class="group flex min-h-7 w-full items-center gap-2 rounded-md py-1 pr-1 text-left transition-colors duration-150 hover:bg-bg-hover/50"
					title={m.sent_open_session({}, { locale })}
				>
					<span class="h-1.5 w-1.5 shrink-0 rounded-full bg-brand/70"></span>
					<span class="min-w-0 flex-1 truncate text-[13px] text-text-secondary">
						{link.title ?? shortId(link.sessionId)}
					</span>
					<ArrowUpRight
						class="h-3.5 w-3.5 shrink-0 text-text-placeholder opacity-0 transition-opacity group-hover:opacity-100"
					/>
				</a>
			{/each}
		</div>
	</div>
{/if}
