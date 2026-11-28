<script lang="ts">
import {
	NOTIFICATION_CATEGORIES,
	NOTIFICATION_CHANNELS,
	type NotificationCategory,
	type NotificationChannel,
	type NotificationConfig,
	type NotificationPreferences,
} from "@neta-art/cohub";
import { Loader2 } from "lucide-svelte";
import ToggleSwitch from "#lib/components/ToggleSwitch.svelte";
import { onSettingsPageActive } from "#lib/features/settings/page-context.svelte.ts";
import { getLocale } from "#lib/i18n/locale.svelte.ts";
import { devicePush } from "#lib/notifications/push.svelte.ts";
import { m } from "#lib/paraglide/messages.js";
import { sdk } from "#lib/sdk.ts";
import { authStore } from "#lib/stores/auth.svelte.ts";
import { replaceState } from "$app/navigation";
import { page } from "$app/state";

const PREFS_KEY = "cohub:notification-preferences";

const locale = $derived(getLocale());
let preferences = $state<NotificationPreferences | null>(
	readCachedPreferences(),
);
let config = $state<NotificationConfig | null>(null);
let notice = $state<{ tone: "ok" | "error"; text: string } | null>(null);
let deviceBusy = $state(false);

const email = $derived(authStore.email);
const emailEnabled = $derived(Boolean(config?.email && email));

function readCachedPreferences(): NotificationPreferences | null {
	try {
		const cached = JSON.parse(
			localStorage.getItem(`${PREFS_KEY}:${authStore.userUuid}`) ?? "null",
		);
		return cached?.categories ? cached : null;
	} catch {
		return null;
	}
}

function cachePreferences(value: NotificationPreferences) {
	preferences = value;
	try {
		localStorage.setItem(
			`${PREFS_KEY}:${authStore.userUuid}`,
			JSON.stringify(value),
		);
	} catch {}
}

async function load() {
	const [loaded, deployment] = await Promise.all([
		sdk.notifications.preferences().catch(() => null),
		sdk.notifications.config().catch(() => null),
		devicePush.start(),
	]);
	if (loaded) cachePreferences(loaded);
	config = deployment;
}

async function unsubscribeFromLink(token: string) {
	const url = new URL(page.url.href);
	url.searchParams.delete("unsubscribe");
	replaceState(url, page.state);
	try {
		await sdk.notifications.unsubscribe(token);
		notice = { tone: "ok", text: m.notif_unsubscribed({}, { locale }) };
	} catch {
		notice = {
			tone: "error",
			text: m.notif_unsubscribe_failed({}, { locale }),
		};
	}
}

onSettingsPageActive(() => {
	const token = page.url.searchParams.get("unsubscribe");
	void (token ? unsubscribeFromLink(token) : Promise.resolve()).then(load);
});

async function change(
	category: NotificationCategory,
	channel: NotificationChannel,
	enabled: boolean,
) {
	if (!preferences) return;
	const previous = preferences;
	preferences = {
		categories: {
			...previous.categories,
			[category]: { ...previous.categories[category], [channel]: enabled },
		},
	};
	try {
		cachePreferences(
			await sdk.notifications.updatePreferences({
				categories: { [category]: { [channel]: enabled } },
			}),
		);
		if (channel === "push" && enabled && devicePush.mode === "off")
			void devicePush.enable();
	} catch {
		preferences = previous;
		notice = { tone: "error", text: m.notif_save_failed({}, { locale }) };
	}
}

async function toggleDevice() {
	deviceBusy = true;
	try {
		if (devicePush.mode === "push") await devicePush.disable();
		else await devicePush.enable();
	} catch {
		notice = { tone: "error", text: m.notif_save_failed({}, { locale }) };
	} finally {
		deviceBusy = false;
	}
}

function categoryLabel(category: NotificationCategory) {
	switch (category) {
		case "mention":
			return [
				m.notif_category_mention({}, { locale }),
				m.notif_category_mention_hint({}, { locale }),
			];
		case "activity":
			return [
				m.notif_category_activity({}, { locale }),
				m.notif_category_activity_hint({}, { locale }),
			];
		case "system":
			return [
				m.notif_category_system({}, { locale }),
				m.notif_category_system_hint({}, { locale }),
			];
	}
}

const channelLabel = (channel: NotificationChannel) =>
	channel === "push"
		? m.notif_channel_push({}, { locale })
		: m.notif_channel_email({}, { locale });

const deviceText = $derived.by(() => {
	switch (devicePush.mode) {
		case "push":
		case "local":
			return m.notif_device_on({}, { locale });
		case "blocked":
			return m.notif_device_blocked({}, { locale });
		case "unsupported":
			return m.notif_device_unavailable({}, { locale });
		default:
			return m.notif_device_off({}, { locale });
	}
});
</script>

<div class="flex-1 px-6 py-7">
	<section class="max-w-2xl">
		<div class="border-b border-border-subtle pb-5">
			<h1 class="text-[18px] font-semibold tracking-tight text-text-primary">{m.page_title_notifications({}, { locale })}</h1>
			<p class="mt-1 max-w-xl text-[13px] leading-5 text-text-tertiary">{m.notif_settings_intro({}, { locale })}</p>
		</div>

		{#if notice}
			<div class="mt-5 rounded-md border p-3 text-[12px] {notice.tone === 'ok' ? 'border-border-subtle bg-bg-surface text-text-secondary' : 'border-error-soft/30 bg-error-bg text-error-soft'}" role="status">{notice.text}</div>
		{/if}

		<section class="border-b border-border-subtle py-6">
			<div class="flex items-center gap-3">
				<span class="min-w-0 flex-1">
					<span class="block text-[13px] font-medium text-text-primary">{m.notif_device_heading({}, { locale })}</span>
					<span class="mt-0.5 block text-[12px] leading-5 text-text-tertiary">{deviceText}</span>
				</span>
				{#if devicePush.mode === "off" || devicePush.mode === "push"}
					<button type="button" class="flex h-8 shrink-0 items-center gap-1.5 rounded-[6px] px-3 text-[12px] transition-colors disabled:opacity-60 {devicePush.mode === 'push' ? 'text-text-tertiary hover:bg-bg-hover hover:text-text-secondary' : 'bg-brand text-brand-contrast-fg hover:bg-brand-hover'}" disabled={deviceBusy} onclick={toggleDevice}>
						{#if deviceBusy}<Loader2 class="h-3.5 w-3.5 animate-spin" />{/if}
						{devicePush.mode === "push" ? m.notif_device_disable({}, { locale }) : m.notif_device_enable({}, { locale })}
					</button>
				{/if}
			</div>
		</section>

		<section class="py-6">
			<div class="grid grid-cols-[1fr_auto_auto] items-center gap-x-4">
				<span></span>
				{#each NOTIFICATION_CHANNELS as channel (channel)}
					<span class="w-12 text-center text-[11px] text-text-tertiary">{channelLabel(channel)}</span>
				{/each}
				{#each NOTIFICATION_CATEGORIES as category (category)}
					{@const [title, hint] = categoryLabel(category)}
					<span class="min-w-0 py-3">
						<span class="block text-[13px] text-text-primary">{title}</span>
						<span class="block text-[12px] leading-5 text-text-tertiary">{hint}</span>
					</span>
					{#each NOTIFICATION_CHANNELS as channel (channel)}
						{@const unavailable = channel === "email" && !emailEnabled}
						<span class="flex w-12 justify-center">
							<ToggleSwitch
								checked={Boolean(preferences?.categories[category][channel]) && !unavailable}
								label={`${title} · ${channelLabel(channel)}`}
								disabled={!preferences || unavailable}
								onchange={(enabled) => void change(category, channel, enabled)}
							/>
						</span>
					{/each}
				{/each}
			</div>
			{#if config && !config.email}
				<p class="mt-4 text-[12px] text-text-tertiary">{m.notif_email_unavailable({}, { locale })}</p>
			{:else if config && !email}
				<p class="mt-4 text-[12px] text-text-tertiary">{m.notif_email_missing({}, { locale })}</p>
			{/if}
		</section>
	</section>
</div>
