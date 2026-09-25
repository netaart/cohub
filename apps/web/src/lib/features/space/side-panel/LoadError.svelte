<script lang="ts">
import { AlertCircle, RefreshCw } from "lucide-svelte";
import { getLocale } from "$lib/i18n/locale.svelte";
import { m } from "$lib/paraglide/messages.js";

const { message, onRetry }: { message: string; onRetry: () => void } = $props();
const locale = $derived(getLocale());
</script>

<div class="flex items-start gap-2 rounded-[5px] bg-error-bg px-2.5 py-2 text-[11px] leading-4 text-error-soft">
	<AlertCircle class="mt-0.5 h-3.5 w-3.5 shrink-0" />
	<span class="min-w-0 flex-1">{message}</span>
	<button type="button" class="inline-flex shrink-0 items-center gap-1 font-medium hover:underline" onclick={onRetry}>
		<RefreshCw class="h-3 w-3" />{m.common_retry({}, { locale })}
	</button>
</div>
