<script lang="ts">
import StatusGlyph from "$lib/components/StatusGlyph.svelte";
import { getLocale } from "$lib/i18n/locale.svelte";
import { m } from "$lib/paraglide/messages.js";

type Props = {
	label?: string | null;
	model?: string | null;
	compact?: boolean;
};

const {
	label: labelInput = null,
	model = null,
	compact = false,
}: Props = $props();
const locale = $derived(getLocale());
const label = $derived(
	labelInput?.trim() ||
		(model?.trim()
			? m.runtime_waiting_model_name({ model: model.trim() }, { locale })
			: m.runtime_waiting_model({}, { locale })),
);
</script>

<div class={`inline-flex items-center gap-1.5 px-[var(--chat-msg-inset)] ${compact ? 'py-1' : 'py-1.5'} text-[12px] leading-none text-text-tertiary`}>
	<StatusGlyph tone="brand" motion="active" soft class="[--status-glyph-size:6px]" />
	<span class="truncate tabular-nums">{label}</span>
</div>
