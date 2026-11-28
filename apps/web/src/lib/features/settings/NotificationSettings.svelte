<script lang="ts">
import {
	NOTIFICATION_CHANNELS,
	NOTIFICATION_KINDS,
	type NotificationChannel,
	type NotificationConfig,
	type NotificationKind,
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
const CONFIG_KEY = "cohub:notification-config";

const locale = $derived(getLocale());
const cachedPreferences = readCached<NotificationPreferences>(PREFS_KEY);
let preferences = $state<NotificationPreferences | null>(
	cachedPreferences?.kinds ? cachedPreferences : null,
);
let config = $state<NotificationConfig | null>(readCached(CONFIG_KEY));
let notice = $state<{ tone: "ok" | "error"; text: string } | null>(null);
let deviceBusy = $state(false);

const channels = $derived(
	config?.email && authStore.email
		? NOTIFICATION_CHANNELS
		: NOTIFICATION_CHANNELS.filter((channel) => channel !== "email"),
);

function readCached<T>(key: string): T | null {
	try {
		return JSON.parse(
			localStorage.getItem(`${key}:${authStore.userUuid}`) ?? "null",
		);
	} catch {
		return null;
	}
}

function writeCached(key: string, value: unknown) {
	try {
		localStorage.setItem(`${key}:${authStore.userUuid}`, JSON.stringify(value));
	} catch {}
}

function cachePreferences(value: NotificationPreferences) {
	preferences = value;
	writeCached(PREFS_KEY, value);
}

async function load() {
	const [loaded, deployment] = await Promise.all([
		sdk.notifications.preferences().catch(() => null),
		sdk.notifications.config().catch(() => null),
		devicePush.start(),
	]);
	if (loaded) cachePreferences(loaded);
	if (deployment) {
		config = deployment;
		writeCached(CONFIG_KEY, deployment);
	}
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
	kind: NotificationKind,
	channel: NotificationChannel,
	enabled: boolean,
) {
	if (!preferences) return;
	const previous = preferences;
	preferences = {
		kinds: {
			...previous.kinds,
			[kind]: { ...previous.kinds[kind], [channel]: enabled },
		},
	};
	try {
		cachePreferences(
			await sdk.notifications.updatePreferences({
				kinds: { [kind]: { [channel]: enabled } },
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

function kindLabel(kind: NotificationKind) {
	switch (kind) {
		case "mention":
			return [
				m.notif_kind_mention({}, { locale }),
				m.notif_kind_mention_hint({}, { locale }),
			];
		case "turn.finished":
			return [
				m.notif_kind_turn_finished({}, { locale }),
				m.notif_kind_turn_finished_hint({}, { locale }),
			];
	}
}

function channelLabel(channel: NotificationChannel) {
	switch (channel) {
		case "inbox":
			return m.notif_channel_inbox({}, { locale });
		case "push":
			return m.notif_channel_push({}, { locale });
		case "email":
			return m.notif_channel_email({}, { locale });
	}
}

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
			<div class="grid items-center gap-x-4" style:grid-template-columns={`1fr repeat(${channels.length}, auto)`}>
				<span></span>
				{#each channels as channel (channel)}
					<span class="w-12 text-center text-[11px] text-text-tertiary">{channelLabel(channel)}</span>
				{/each}
				{#each NOTIFICATION_KINDS as kind (kind)}
					{@const [title, hint] = kindLabel(kind)}
					<span class="min-w-0 py-3">
						<span class="block text-[13px] text-text-primary">{title}</span>
						<span class="block text-[12px] leading-5 text-text-tertiary">{hint}</span>
					</span>
					{#each channels as channel (channel)}
						<span class="flex w-12 justify-center">
							<ToggleSwitch
								checked={Boolean(preferences?.kinds[kind]?.[channel])}
								label={`${title} · ${channelLabel(channel)}`}
								disabled={!preferences}
								onchange={(enabled) => void change(kind, channel, enabled)}
							/>
						</span>
					{/each}
				{/each}
			</div>
		</section>
	</section>
</div>
