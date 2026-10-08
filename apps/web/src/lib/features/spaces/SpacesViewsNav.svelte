<script lang="ts">
import { goto } from "$app/navigation";
import { page } from "$app/state";
import {
	SPACES_FILTERS,
	type SpacesFilter,
} from "$lib/features/spaces/spaces-filter";
import { spacesInbox } from "$lib/features/spaces/spaces-inbox.svelte";
import {
	SPACES_FILTER_ICONS,
	spacesFilterLabel,
} from "$lib/features/spaces/spaces-views";
import { getLocale } from "$lib/i18n/locale.svelte";
import { requestListScrollTop } from "$lib/layout/list-scroll-top";
import { m } from "$lib/paraglide/messages.js";

const { variant }: { variant: "list" | "rail" } = $props();

const SPACES_PATH = "/spaces";

const locale = $derived(getLocale());
const onList = $derived(page.url.pathname === SPACES_PATH);

function open(event: MouseEvent, filter: SpacesFilter) {
	if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0)
		return;
	event.preventDefault();
	if (!onList) {
		spacesInbox.filter = filter;
		void goto(SPACES_PATH);
	} else if (spacesInbox.filter === filter) requestListScrollTop();
	else spacesInbox.filter = filter;
}
</script>

<nav
	class={variant === "rail"
		? "mt-2 flex w-full flex-1 flex-col items-center gap-1"
		: "scrollbar-quiet min-h-0 flex-1 space-y-[2px] overflow-y-auto px-1.5 py-2"}
	aria-label={m.spaces_title({}, { locale })}
>
	{#each SPACES_FILTERS as filter (filter)}
		{@const Icon = SPACES_FILTER_ICONS[filter]}
		{@const label = spacesFilterLabel(filter, locale)}
		{@const current = onList && spacesInbox.filter === filter}
		{#if variant === "rail"}
			<a
				href={SPACES_PATH}
				class="flex h-8 w-8 items-center justify-center rounded-[6px] transition-colors duration-100 {current ? 'bg-bg-active text-text-primary' : 'text-text-tertiary hover:bg-bg-hover hover:text-text-secondary'}"
				aria-label={label}
				aria-current={current ? "page" : undefined}
				title={label}
				onclick={(event) => open(event, filter)}
			>
				<Icon class="h-4 w-4" />
			</a>
		{:else}
			<a
				href={SPACES_PATH}
				class="flex items-center gap-2.5 rounded-[5px] px-1.5 py-2 text-[13px] transition-colors duration-100 {current ? 'bg-bg-active font-medium text-text-primary' : 'text-text-tertiary hover:bg-bg-hover hover:text-text-secondary'}"
				aria-current={current ? "page" : undefined}
				onclick={(event) => open(event, filter)}
			>
				<Icon class="h-[15px] w-[15px] shrink-0" />
				<span class="truncate">{label}</span>
			</a>
		{/if}
	{/each}
</nav>
