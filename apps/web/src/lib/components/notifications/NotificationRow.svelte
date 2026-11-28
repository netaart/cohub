<script lang="ts">
import type { InboxItem } from "@neta-art/cohub";
import { Check } from "lucide-svelte";
import NotificationAvatar from "#lib/components/notifications/NotificationAvatar.svelte";
import { getLocale } from "#lib/i18n/locale.svelte.ts";
import { notificationCopy, notificationHref } from "#lib/notifications/copy.ts";
import { inbox } from "#lib/notifications/inbox.svelte.ts";
import { m } from "#lib/paraglide/messages.js";
import { formatTimeAgo } from "#lib/resource-kit/time.ts";
import { goto } from "$app/navigation";

const {
	item,
	now,
	onnavigate,
}: { item: InboxItem; now: number; onnavigate?: () => void } = $props();

const locale = $derived(getLocale());
const copy = $derived(notificationCopy(item, locale));
const href = $derived(notificationHref(item));
const unread = $derived(!item.readAt);

function open(event: MouseEvent) {
	if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0)
		return;
	event.preventDefault();
	if (unread) void inbox.markRead({ ids: [item.id] });
	onnavigate?.();
	void goto(href);
}

function markRead() {
	void inbox.markRead({ ids: [item.id] });
}
</script>

{#if copy}
	<div class="group relative">
		<a {href} class="flex gap-3 rounded-[10px] px-3 py-2.5 pr-8 transition-colors duration-100 hover:bg-bg-hover focus-visible:bg-bg-hover focus-visible:outline-none" onclick={open}>
			<NotificationAvatar notice={item} />
			<span class="min-w-0 flex-1">
				<span class="flex items-baseline gap-2">
					<span class="min-w-0 flex-1 truncate text-[13px] leading-5 {unread ? 'font-medium text-text-primary' : 'text-text-secondary'}">{copy.title}</span>
					<span class="shrink-0 text-[11px] leading-5 text-text-tertiary tabular-nums">{formatTimeAgo(Date.parse(item.updatedAt), now, locale)}</span>
				</span>
				{#if copy.body}
					<span class="line-clamp-2 text-[12px] leading-[1.45] text-text-tertiary">{copy.body}</span>
				{/if}
				{#if item.count > 1}
					<span class="mt-1 inline-flex rounded-full bg-bg-surface px-1.5 text-[10px] leading-4 text-text-tertiary">{m.notif_merged_count({ n: item.count }, { locale })}</span>
				{/if}
			</span>
		</a>
		{#if unread}
			<span class="pointer-events-none absolute right-3 top-[18px] h-2 w-2 rounded-full bg-brand group-hover:opacity-0" aria-hidden="true"></span>
			<button type="button" class="absolute right-1.5 top-2.5 flex h-6 w-6 items-center justify-center rounded-[6px] text-text-tertiary opacity-0 transition-opacity hover:bg-bg-hover-strong hover:text-text-primary focus-visible:opacity-100 group-hover:opacity-100" title={m.inbox_mark_read({}, { locale })} aria-label={m.inbox_mark_read({}, { locale })} onclick={markRead}>
				<Check class="h-3.5 w-3.5" />
			</button>
		{/if}
	</div>
{/if}
