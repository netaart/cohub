<script lang="ts">
import { ArrowUpRight } from "lucide-svelte";
import RelatedSessionLink from "$lib/components/RelatedSessionLink.svelte";
import { getLocale } from "$lib/i18n/locale.svelte";
import { m } from "$lib/paraglide/messages.js";
import { NO_SENT_SESSIONS, summarizeSentSessions } from "$lib/sent-turns";
import { useSessionRelations } from "$lib/session-relations-context";

const { turnId }: { turnId: string } = $props();

const locale = $derived(getLocale());
const relations = useSessionRelations();
const sessions = $derived(relations?.sentByTurn(turnId) ?? NO_SENT_SESSIONS);

let expanded = $state(false);
const entries = $derived(summarizeSentSessions(sessions, locale, { expanded }));

// Targets keep a quiet, persistent underline so they read as links within the
// sentence; the ×N count and unavailable Sessions stay undecorated.
const target =
	"group inline-flex min-w-0 max-w-[16em] items-center gap-1 font-medium text-text-secondary transition-colors";
const targetLabel =
	"min-w-0 truncate underline decoration-border-strong underline-offset-[3px] transition-colors group-hover:decoration-brand/50";
</script>

<!-- Gaps are explicit margins: flex layout drops whitespace-only text nodes. -->
{#if sessions.length > 0}
	<p class="flex flex-wrap items-center px-[var(--chat-msg-inset)] text-[13px] leading-6 text-text-tertiary">
		<ArrowUpRight class="mr-1.5 h-3.5 w-3.5 shrink-0 text-brand/70" aria-hidden="true" />
		<span class="mr-1.5 shrink-0">{m.sent_to_label({}, { locale })}</span>
		{#each entries as entry, index (index)}
			<span class="inline-flex min-w-0 items-center">
				{#if entry.kind === "more"}
					<button type="button" class="{target} cursor-pointer hover:text-text-primary" onclick={() => (expanded = true)}>
						<span class={targetLabel}>{m.sent_to_more({ count: entry.count }, { locale })}</span>
					</button>
				{:else}
					<RelatedSessionLink ref={entry.session} class="{target} [&[href]]:hover:text-text-primary">
						{#snippet children({ label, status })}
							{#if status === "loading"}
								<span class="h-3 w-20 rounded-[3px] bg-bg-surface" aria-hidden="true"></span>
							{:else if status === "unavailable"}
								<span class="min-w-0 truncate font-normal text-text-placeholder">{label}</span>
							{:else}
								<span class={targetLabel}>{label}</span>
							{/if}
							{#if entry.session.count > 1}
								<span class="shrink-0 font-normal tabular-nums text-text-placeholder">×{entry.session.count}</span>
							{/if}
						{/snippet}
					</RelatedSessionLink>
				{/if}
				{#if entry.separator}
					<span class="shrink-0 whitespace-pre">{entry.separator}</span>
				{/if}
			</span>
		{/each}
	</p>
{/if}
