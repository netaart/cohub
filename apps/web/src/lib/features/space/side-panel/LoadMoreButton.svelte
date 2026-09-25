<script lang="ts">
import { Loader2 } from "lucide-svelte";
import { getLocale } from "$lib/i18n/locale.svelte";
import { m } from "$lib/paraglide/messages.js";
import type { GenerationFeed } from "./generation-feed.svelte";
import LoadError from "./LoadError.svelte";

const { feed }: { feed: GenerationFeed } = $props();
const locale = $derived(getLocale());
</script>

{#if feed.loadMoreFailed}
	<div class="mt-2">
		<LoadError message={m.generation_load_failed({}, { locale })} onRetry={() => void feed.loadMore()} />
	</div>
{:else if feed.pageInfo.hasMore && feed.pageInfo.nextCursor}
	<button
		type="button"
		class="mt-2 flex w-full items-center justify-center gap-1.5 rounded-[6px] px-1.5 py-1.5 text-[11px] text-text-placeholder transition-colors hover:bg-bg-hover hover:text-text-secondary disabled:cursor-not-allowed disabled:opacity-60"
		disabled={feed.loadingMore}
		onclick={() => void feed.loadMore()}
	>
		{#if feed.loadingMore}
			<Loader2 class="h-3 w-3 animate-spin" />
			{m.common_loading({}, { locale })}
		{:else}
			{m.sidebar_show_more({}, { locale })}
		{/if}
	</button>
{/if}
