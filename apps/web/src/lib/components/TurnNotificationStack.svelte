<script lang="ts">
import { BellOff, ExternalLink, X } from "lucide-svelte";
import SpaceAvatar from "$lib/components/SpaceAvatar.svelte";
import { swipeDismiss } from "$lib/gestures/swipe-dismiss";
import { getLocale } from "$lib/i18n/locale.svelte";
import { m } from "$lib/paraglide/messages.js";
import { settingsSectionHref } from "$lib/settings-nav";
import {
	getTurnNotificationHref,
	getTurnNotificationMeta,
	getTurnNotificationSpaceTitle,
	type TurnNotification,
	turnNotifications,
} from "$lib/stores/turn-notifications.svelte";

const locale = $derived(getLocale());

function statusTone(status: string) {
	if (status === "completed") return "bg-success-soft";
	if (status === "failed") return "bg-error-soft";
	if (status === "interrupted" || status === "cancelled")
		return "bg-warning-soft";
	return "bg-text-tertiary";
}

function openCurrent(notification: TurnNotification) {
	turnNotifications.openCurrentTab(notification);
}

function openNew(event: MouseEvent, notification: TurnNotification) {
	event.stopPropagation();
	turnNotifications.openNewTab(notification);
}

function dismiss(event: MouseEvent, id: string) {
	event.stopPropagation();
	turnNotifications.dismiss(id);
}

function muteLabel(notification: TurnNotification) {
	switch (turnNotifications.muteKind(notification)) {
		case "task":
			return m.notif_mute_task({}, { locale });
		case "scheduled":
			return m.notif_mute_scheduled({}, { locale });
		case "hook":
			return m.notif_mute_hook({}, { locale });
		case "background":
			return m.notif_mute_background({}, { locale });
		default:
			return null;
	}
}

function mute(event: MouseEvent, id: string) {
	event.stopPropagation();
	void turnNotifications.mute(id);
}

function undoMute(event: MouseEvent, id: string) {
	event.stopPropagation();
	void turnNotifications.undoMute(id);
}

function handlePointerPause(event: PointerEvent, id: string, paused: boolean) {
	if (event.pointerType !== "mouse") return;
	turnNotifications.setInteractionPaused(id, paused);
}

function handleCardKeydown(
	event: KeyboardEvent,
	notification: TurnNotification,
) {
	// Nested buttons and links keep their own Enter / Space activation.
	if (event.target !== event.currentTarget) return;
	if (event.key !== "Enter" && event.key !== " ") return;
	event.preventDefault();
	openCurrent(notification);
}
</script>

{#if turnNotifications.visibleItems.length > 0}
	<div class="turn-notification-region pointer-events-none fixed inset-x-3 top-[calc(0.75rem+env(safe-area-inset-top,0px))] z-[var(--z-workspace-toast)] flex flex-col gap-2 sm:inset-x-auto sm:right-4 sm:top-auto sm:bottom-4 sm:w-[360px] sm:max-w-[calc(100vw-2rem)]">
		{#each turnNotifications.visibleItems as notification (notification.id)}
			{@const title = getTurnNotificationSpaceTitle(notification)}
			{@const silenceLabel = muteLabel(notification)}
			<div
				role="button"
				tabindex="0"
				class="turn-notification toast-surface pointer-events-auto text-left"
				title={m.notif_open_turn({}, { locale })}
				data-drawer-swipe-ignore
				use:swipeDismiss={{
					onDismiss: () => turnNotifications.dismiss(notification.id),
				}}
				onclick={() => openCurrent(notification)}
				onkeydown={(event) => handleCardKeydown(event, notification)}
				onpointerenter={(event) =>
					handlePointerPause(event, notification.id, true)}
				onpointerleave={(event) =>
					handlePointerPause(event, notification.id, false)}
				onfocus={() => turnNotifications.setInteractionPaused(notification.id, true)}
				onblur={() => turnNotifications.setInteractionPaused(notification.id, false)}
			>
				<div class="flex min-w-0 items-center gap-2">
					<SpaceAvatar name={title} profile={notification.space?.publicProfile} seed={notification.spaceId} size="xs" />
					<div class="min-w-0 flex-1 truncate text-[12px] font-medium leading-5 text-text-primary">
						{title}
					</div>
					<span class={`h-1.5 w-1.5 shrink-0 rounded-full ${statusTone(notification.status)}`}></span>
					<div class="hidden max-w-[150px] shrink-0 truncate text-[11px] leading-5 text-text-tertiary sm:block">
						{getTurnNotificationMeta(notification, locale)}
					</div>
					{#if silenceLabel && notification.mute?.state !== "muted"}
						<button
							type="button"
							class="h-6 w-6 shrink-0 rounded-[5px] text-text-tertiary transition-colors hover:bg-bg-hover hover:text-text-primary disabled:opacity-50"
							title={silenceLabel}
							aria-label={silenceLabel}
							disabled={notification.mute?.state === "saving"}
							onclick={(event) => mute(event, notification.id)}
						>
							<BellOff class="mx-auto h-3.5 w-3.5" />
						</button>
					{/if}
					<a
						class="hidden h-6 w-6 shrink-0 items-center justify-center rounded-[5px] text-text-tertiary transition-colors hover:bg-bg-hover hover:text-text-primary sm:inline-flex"
						href={getTurnNotificationHref(notification)}
						target="_blank"
						rel="noreferrer"
						title={m.notif_open_new_tab({}, { locale })}
						onclick={(event) => openNew(event, notification)}
					>
						<ExternalLink class="h-3.5 w-3.5" />
					</a>
					<button
						type="button"
						class="h-6 w-6 shrink-0 rounded-[5px] text-text-tertiary transition-colors hover:bg-bg-hover hover:text-text-primary"
						title={m.notif_dismiss({}, { locale })}
						aria-label={m.notif_dismiss({}, { locale })}
						onclick={(event) => dismiss(event, notification.id)}
					>
						<X class="mx-auto h-3.5 w-3.5" />
					</button>
				</div>
				{#if notification.mute?.state === "muted"}
					<div class="mt-1 flex min-w-0 items-center gap-1 pl-7 text-[12px] leading-5" aria-live="polite">
						<span class="min-w-0 flex-1 truncate text-text-secondary">{m.notif_muted({}, { locale })}</span>
						<button type="button" class="shrink-0 rounded-[4px] px-1.5 text-text-primary transition-colors hover:bg-bg-hover" onclick={(event) => undoMute(event, notification.id)}>{m.notif_undo({}, { locale })}</button>
						<a class="shrink-0 rounded-[4px] px-1.5 text-text-tertiary transition-colors hover:bg-bg-hover hover:text-text-primary" href={settingsSectionHref("notifications")} onclick={(event) => { event.stopPropagation(); turnNotifications.dismiss(notification.id); }}>{m.notif_settings({}, { locale })}</a>
					</div>
				{:else}
					<div class="mt-1 flex min-w-0 items-center gap-1.5 pl-7">
						<p class="line-clamp-2 min-w-0 flex-1 text-[12px] leading-[1.45] text-text-secondary">
							{notification.userPreview || m.notif_turn_completed({}, { locale })}
						</p>
						<div class="shrink-0 text-[11px] leading-5 text-text-tertiary sm:hidden">
							{getTurnNotificationMeta(notification, locale)}
						</div>
					</div>
					{#if notification.mute?.state === "failed"}
						<p class="mt-1 pl-7 text-[11px] leading-4 text-error-soft" role="alert">{m.notif_mute_failed({}, { locale })}</p>
					{/if}
				{/if}
			</div>
		{/each}

		{#if turnNotifications.hiddenCount > 0}
			<div class="pointer-events-auto self-end rounded-[6px] border border-border-subtle bg-bg-surface px-2 py-1 text-[11px] text-text-tertiary">
				{m.notif_more({ n: turnNotifications.hiddenCount }, { locale })}
			</div>
		{/if}

		{#if turnNotifications.showDesktopPrompt}
			<div class="desktop-prompt pointer-events-auto">
				<span class="min-w-0 flex-1 truncate">{m.notif_desktop_prompt({}, { locale })}</span>
				<button type="button" onclick={() => void turnNotifications.enableDesktopNotifications()}>{m.notif_desktop_enable({}, { locale })}</button>
				<button type="button" onclick={() => turnNotifications.dismissDesktopPrompt()}>{m.notif_not_now({}, { locale })}</button>
			</div>
		{/if}
	</div>
{/if}

<style>
	.turn-notification {
		padding: 8px 8px 8px 10px;
		/* Vertical scroll stays native; horizontal drags feed swipe-to-dismiss. */
		touch-action: pan-y;
		transition:
			border-color 140ms ease,
			transform 140ms ease;
	}

	.turn-notification:hover,
	.turn-notification:focus-visible {
		border-color: var(--border-strong);
		outline: none;
	}

	.turn-notification:active {
		transform: translateY(1px);
	}

	.desktop-prompt {
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

	.desktop-prompt button {
		flex-shrink: 0;
		border-radius: 5px;
		padding: 3px 6px;
		color: var(--text-tertiary);
		transition:
			background-color 120ms ease,
			color 120ms ease;
	}

	.desktop-prompt button:first-of-type {
		color: var(--text-primary);
	}

	.desktop-prompt button:hover {
		background: var(--bg-hover);
		color: var(--text-primary);
	}

	@media (prefers-reduced-motion: no-preference) {
		.turn-notification-region {
			animation: turn-notification-enter 140ms ease-out;
		}
	}

	@keyframes turn-notification-enter {
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
		.turn-notification {
			box-shadow: 0 6px 18px rgb(0 0 0 / 0.08);
		}
	}
</style>
