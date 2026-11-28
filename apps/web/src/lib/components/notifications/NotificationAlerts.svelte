<script lang="ts">
import { ExternalLink, X } from "lucide-svelte";
import { untrack } from "svelte";
import NotificationAvatar from "#lib/components/notifications/NotificationAvatar.svelte";
import { swipeDismiss } from "#lib/gestures/swipe-dismiss.ts";
import { syncHostBadge } from "#lib/host-bridge.ts";
import { getLocale } from "#lib/i18n/locale.svelte.ts";
import {
	type NotificationToast,
	notificationAlerts,
	syncNotificationLocale,
} from "#lib/notifications/alerts.svelte.ts";
import { notificationCopy, notificationHref } from "#lib/notifications/copy.ts";
import { m } from "#lib/paraglide/messages.js";
import { authStore } from "#lib/stores/auth.svelte.ts";
import { page } from "$app/state";

const locale = $derived(getLocale());
const toasts = $derived(notificationAlerts.toasts);

$effect(() => syncHostBadge(toasts.length));

$effect(() => {
	if (authStore.isAuthenticated) syncNotificationLocale(locale);
});

$effect(() => {
	void page.url.pathname;
	if (notificationAlerts.attended)
		untrack(() => notificationAlerts.readViewedSession());
});

function openNew(event: MouseEvent, toast: NotificationToast) {
	event.preventDefault();
	event.stopPropagation();
	notificationAlerts.open(toast, { newTab: true });
}

function dismiss(event: MouseEvent, id: string) {
	event.stopPropagation();
	notificationAlerts.dismiss(id);
}

function pause(event: PointerEvent, id: string, paused: boolean) {
	if (event.pointerType === "mouse") notificationAlerts.pause(id, paused);
}

function keydown(event: KeyboardEvent, toast: NotificationToast) {
	if (event.key !== "Enter" && event.key !== " ") return;
	event.preventDefault();
	notificationAlerts.open(toast);
}
</script>

{#if toasts.length > 0 || notificationAlerts.showPrompt}
	<div class="notification-region pointer-events-none fixed inset-x-3 top-[calc(0.75rem+env(safe-area-inset-top,0px))] z-[var(--z-workspace-toast)] flex flex-col gap-2 sm:inset-x-auto sm:right-4 sm:top-auto sm:bottom-4 sm:w-[360px] sm:max-w-[calc(100vw-2rem)]">
		{#each toasts as toast (toast.record.id)}
			{@const copy = notificationCopy(toast.record, locale)}
			<div
				role="button"
				tabindex="0"
				class="notification-toast toast-surface pointer-events-auto flex gap-2.5 text-left"
				data-drawer-swipe-ignore
				use:swipeDismiss={{ onDismiss: () => notificationAlerts.dismiss(toast.record.id) }}
				onclick={() => notificationAlerts.open(toast)}
				onkeydown={(event) => keydown(event, toast)}
				onpointerenter={(event) => pause(event, toast.record.id, true)}
				onpointerleave={(event) => pause(event, toast.record.id, false)}
				onfocus={() => notificationAlerts.pause(toast.record.id, true)}
				onblur={() => notificationAlerts.pause(toast.record.id, false)}
			>
				<NotificationAvatar record={toast.record} size="sm" />
				<div class="min-w-0 flex-1">
					<div class="truncate text-[12px] font-medium leading-5 text-text-primary">{copy.title}</div>
					{#if copy.body}<p class="line-clamp-2 text-[12px] leading-[1.45] text-text-secondary">{copy.body}</p>{/if}
				</div>
				<a class="hidden h-6 w-6 shrink-0 items-center justify-center rounded-[5px] text-text-tertiary transition-colors hover:bg-bg-hover hover:text-text-primary sm:inline-flex" href={notificationHref(toast.record)} target="_blank" rel="noreferrer" title={m.notif_open_new_tab({}, { locale })} onclick={(event) => openNew(event, toast)}>
					<ExternalLink class="h-3.5 w-3.5" />
				</a>
				<button type="button" class="h-6 w-6 shrink-0 rounded-[5px] text-text-tertiary transition-colors hover:bg-bg-hover hover:text-text-primary" title={m.notif_dismiss({}, { locale })} aria-label={m.notif_dismiss({}, { locale })} onclick={(event) => dismiss(event, toast.record.id)}>
					<X class="mx-auto h-3.5 w-3.5" />
				</button>
			</div>
		{/each}

		{#if notificationAlerts.showPrompt}
			<div class="push-prompt pointer-events-auto">
				<span class="min-w-0 flex-1 truncate">{m.notif_enable_prompt({}, { locale })}</span>
				<button type="button" onclick={() => void notificationAlerts.enablePush()}>{m.notif_enable({}, { locale })}</button>
				<button type="button" onclick={() => notificationAlerts.dismissPrompt()}>{m.notif_not_now({}, { locale })}</button>
			</div>
		{/if}
	</div>
{/if}

<style>
	.notification-toast {
		padding: 8px 8px 8px 10px;
		touch-action: pan-y;
		transition:
			border-color 140ms ease,
			transform 140ms ease;
	}

	.notification-toast:hover,
	.notification-toast:focus-visible {
		border-color: var(--border-strong);
		outline: none;
	}

	.notification-toast:active {
		transform: translateY(1px);
	}

	.push-prompt {
		display: flex;
		align-items: center;
		gap: 6px;
		align-self: stretch;
		border: 1px solid var(--border-subtle);
		border-radius: 7px;
		background: var(--bg-surface);
		padding: 6px 8px;
		font-size: 11px;
		line-height: 1.2;
		color: var(--text-secondary);
	}

	.push-prompt button {
		flex-shrink: 0;
		border-radius: 5px;
		padding: 3px 6px;
		color: var(--text-tertiary);
		transition:
			background-color 120ms ease,
			color 120ms ease;
	}

	.push-prompt button:first-of-type {
		color: var(--text-primary);
	}

	.push-prompt button:hover {
		background: var(--bg-hover);
		color: var(--text-primary);
	}

	@media (prefers-reduced-motion: no-preference) {
		.notification-region {
			animation: notification-enter 140ms ease-out;
		}
	}

	@keyframes notification-enter {
		from {
			opacity: 0;
			transform: translateY(6px);
		}
		to {
			opacity: 1;
			transform: translateY(0);
		}
	}

	@media (max-width: 639px) {
		.notification-toast {
			box-shadow: 0 6px 18px rgb(0 0 0 / 0.08);
		}
	}
</style>
