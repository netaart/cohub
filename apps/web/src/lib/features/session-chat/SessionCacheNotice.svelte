<script lang="ts">
import type { ColdResendEstimate } from "@neta-art/cohub";
import { Shrink, TimerOff, X } from "lucide-svelte";
import { formatTokenCount, formatUsageCost } from "#lib/format-usage.ts";
import { getLocale } from "#lib/i18n/locale.svelte.ts";
import { m } from "#lib/paraglide/messages.js";

let {
	coldResend,
	compactFirst,
	oncompactfirst,
	ondismiss,
}: {
	coldResend: ColdResendEstimate | null;
	compactFirst: boolean;
	oncompactfirst: (value: boolean) => void;
	ondismiss: () => void;
} = $props();

const locale = $derived(getLocale());
const actionClass =
	"shrink-0 rounded px-1.5 py-0.5 text-text-secondary transition-colors hover:bg-bg-hover hover:text-text-primary";
</script>

{#if compactFirst || coldResend}
	<div class="chat-gutter-x">
		<div
			class="mx-auto flex max-w-[var(--chat-content-max-width)] items-center gap-2 pb-1 text-[12px] text-text-tertiary"
			role="status"
		>
			{#if compactFirst}
				<Shrink class="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
				<span class="line-clamp-2 min-w-0 flex-1">{m.session_cache_compact_queued({}, { locale })}</span>
				<button type="button" class={actionClass} onclick={() => oncompactfirst(false)}>
					{m.common_undo({}, { locale })}
				</button>
			{:else if coldResend}
				<TimerOff class="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
				<span class="line-clamp-2 min-w-0 flex-1">
					{m.session_cache_cold(
						{
							tokens: formatTokenCount(coldResend.contextTokens),
							cost: formatUsageCost(coldResend.costUsd, locale),
						},
						{ locale },
					)}
				</span>
				<button type="button" class={actionClass} onclick={() => oncompactfirst(true)}>
					{m.session_cache_compact_first({}, { locale })}
				</button>
				<button
					type="button"
					class="shrink-0 rounded p-0.5 text-text-placeholder transition-colors hover:bg-bg-hover hover:text-text-secondary"
					aria-label={m.common_close({}, { locale })}
					onclick={ondismiss}
				>
					<X class="h-3.5 w-3.5" aria-hidden="true" />
				</button>
			{/if}
		</div>
	</div>
{/if}
