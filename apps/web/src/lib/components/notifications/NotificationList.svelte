<script lang="ts">
import { INBOX_UNREAD_CAP } from "@neta-art/cohub";
import { BellOff, CheckCheck, Loader2, Settings } from "lucide-svelte";
import { untrack } from "svelte";
import NotificationRow from "#lib/components/notifications/NotificationRow.svelte";
import { getLocale } from "#lib/i18n/locale.svelte.ts";
import {
	INBOX_FILTERS,
	type InboxFilter,
	inbox,
} from "#lib/notifications/inbox.svelte.ts";
import { m } from "#lib/paraglide/messages.js";

const {
	variant = "page",
	onnavigate,
}: { variant?: "page" | "panel"; onnavigate?: () => void } = $props();

const locale = $derived(getLocale());
let filter = $state<InboxFilter>("all");
let now = $state(Date.now());

const view = $derived(inbox.list.view(filter));
const unread = $derived(inbox.summary.unread);

$effect(() => inbox.list.watch(filter));

$effect(() => {
	const timer = window.setInterval(() => (now = Date.now()), 60_000);
	return () => window.clearInterval(timer);
});

const LOAD_MORE_THRESHOLD_PX = 240;
let scroller = $state<HTMLElement | null>(null);

function loadMoreNearEnd() {
	if (
		scroller &&
		scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight <
			LOAD_MORE_THRESHOLD_PX
	)
		void inbox.list.loadMore(filter);
}

const rowCount = $derived(view.items.length);
$effect(() => {
	void rowCount;
	untrack(loadMoreNearEnd);
});

const label = (value: InboxFilter) =>
	value === "all"
		? m.inbox_tab_all({}, { locale })
		: m.inbox_tab_unread({}, { locale });
const countLabel = (value: number) =>
	value > INBOX_UNREAD_CAP ? `${INBOX_UNREAD_CAP}+` : String(value);

function markAllRead() {
	void inbox.markRead({ all: true });
}
</script>

<div class="flex min-h-0 flex-1 flex-col">
	<div class="flex shrink-0 items-center gap-1 border-b border-border-subtle px-2 {variant === 'panel' ? 'h-11' : 'h-10'}">
		<div class="flex min-w-0 flex-1 items-center gap-0.5" role="tablist" aria-label={m.inbox_title({}, { locale })}>
			{#each INBOX_FILTERS as value (value)}
				{@const active = value === filter}
				{@const n = value === "unread" ? unread : 0}
				<button type="button" role="tab" aria-selected={active} class="flex h-7 items-center gap-1.5 rounded-[6px] px-2 text-[12px] transition-colors duration-100 {active ? 'bg-bg-active font-medium text-text-primary' : 'text-text-tertiary hover:bg-bg-hover hover:text-text-secondary'}" onclick={() => (filter = value)}>
					{label(value)}
					{#if n > 0}<span class="rounded-full bg-brand/12 px-1.5 text-[10px] leading-4 text-brand tabular-nums">{countLabel(n)}</span>{/if}
				</button>
			{/each}
		</div>
		<button type="button" class="flex h-7 w-7 shrink-0 items-center justify-center rounded-[6px] text-text-tertiary transition-colors hover:bg-bg-hover hover:text-text-primary disabled:pointer-events-none disabled:opacity-40" disabled={unread === 0} title={m.inbox_mark_all_read({}, { locale })} aria-label={m.inbox_mark_all_read({}, { locale })} onclick={markAllRead}>
			<CheckCheck class="h-4 w-4" />
		</button>
		<a href="/settings/notifications" class="flex h-7 w-7 shrink-0 items-center justify-center rounded-[6px] text-text-tertiary transition-colors hover:bg-bg-hover hover:text-text-primary" title={m.inbox_settings({}, { locale })} aria-label={m.inbox_settings({}, { locale })} onclick={() => onnavigate?.()}>
			<Settings class="h-4 w-4" />
		</a>
	</div>

	<div class="scrollbar-quiet min-h-0 flex-1 overflow-y-auto overscroll-y-contain p-1.5" role="tabpanel" bind:this={scroller} onscroll={loadMoreNearEnd}>
		{#if view.items.length === 0 && view.loading}
			<div class="space-y-1 p-1" aria-busy="true">
				{#each [0, 1, 2, 3] as row (row)}
					<div class="flex gap-3 px-2 py-2.5">
						<span class="h-8 w-8 shrink-0 rounded-full bg-bg-surface"></span>
						<span class="flex-1 space-y-1.5 pt-0.5"><span class="block h-3 w-2/3 rounded bg-bg-surface"></span><span class="block h-3 w-1/2 rounded bg-bg-surface"></span></span>
					</div>
				{/each}
			</div>
		{:else if view.items.length === 0}
			<div class="flex flex-col items-center px-6 py-12 text-center">
				<span class="flex h-10 w-10 items-center justify-center rounded-full bg-bg-surface text-text-tertiary"><BellOff class="h-4.5 w-4.5" /></span>
				<p class="mt-3 text-[13px] font-medium text-text-primary">{view.error ? m.inbox_load_failed({}, { locale }) : m.inbox_empty({}, { locale })}</p>
				{#if !view.error}<p class="mt-1 text-[12px] text-text-tertiary">{m.inbox_empty_hint({}, { locale })}</p>{/if}
			</div>
		{:else}
			{#each view.items as item (item.id)}
				<NotificationRow {item} {now} {onnavigate} />
			{/each}
		{/if}
		{#if view.loadingMore}
			<div class="flex h-8 items-center justify-center"><Loader2 class="h-3.5 w-3.5 animate-spin text-text-tertiary" /></div>
		{/if}
	</div>
</div>
