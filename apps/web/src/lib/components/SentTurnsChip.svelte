<script lang="ts">
/** Fan-out summary for the collapsed process card; the row itself expands. */
import { getLocale } from "$lib/i18n/locale.svelte";
import { m } from "$lib/paraglide/messages.js";

const { count }: { count: number } = $props();

const locale = $derived(getLocale());

const label = $derived(
	count === 1
		? m.sent_count_one({ count }, { locale })
		: m.sent_count_many({ count }, { locale }),
);
</script>

<span class="inline-flex shrink-0 items-center gap-1.5">
	<span class="h-1.5 w-1.5 shrink-0 rounded-full bg-brand/70"></span>
	<span class="text-brand/80">{label}</span>
</span>
