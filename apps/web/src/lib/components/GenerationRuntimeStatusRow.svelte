<script lang="ts" module>
const pageLoadedAt = Date.now();
</script>

<script lang="ts">
import { clock } from "#lib/clock.svelte.ts";
import StatusGlyph from "#lib/components/StatusGlyph.svelte";
import { formatElapsedMs } from "#lib/format-duration.ts";
import { getLocale } from "#lib/i18n/locale.svelte.ts";
import { m } from "#lib/paraglide/messages.js";

type Props = {
	label?: string | null;
	model?: string | null;
	since?: number | null;
	compact?: boolean;
};

const QUIET_MS = 10_000;

const {
	label: labelInput = null,
	model = null,
	since = null,
	compact = false,
}: Props = $props();
const locale = $derived(getLocale());
const label = $derived(
	labelInput?.trim() ||
		(model?.trim()
			? m.runtime_waiting_model_name({ model: model.trim() }, { locale })
			: m.runtime_waiting_model({}, { locale })),
);
const quietMs = $derived(
	since == null ? 0 : clock.now - Math.max(since, pageLoadedAt),
);
</script>

<div class={`inline-flex items-center gap-1.5 px-[var(--chat-msg-inset)] ${compact ? 'py-1' : 'py-1.5'} text-[12px] leading-none text-text-tertiary`}>
	<StatusGlyph tone="activity" motion="active" soft class="[--status-glyph-size:6px]" />
	<span class="truncate tabular-nums">{label}</span>
	{#if quietMs >= QUIET_MS}
		<span class="shrink-0 tabular-nums">{formatElapsedMs(quietMs, locale)}</span>
	{/if}
</div>
