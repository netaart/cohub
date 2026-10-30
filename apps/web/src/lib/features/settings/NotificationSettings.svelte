<script lang="ts">
import type { SilenceableNotificationSource } from "@neta-art/cohub";
import { ensureAuth } from "$lib/auth";
import ToggleSwitch from "$lib/components/ToggleSwitch.svelte";
import { onSettingsPageActive } from "$lib/features/settings/page-context.svelte";
import { getLocale } from "$lib/i18n/locale.svelte";
import { m } from "$lib/paraglide/messages.js";
import { authStore } from "$lib/stores/auth.svelte";
import { notificationPreferences } from "$lib/stores/notification-preferences.svelte";

const locale = $derived(getLocale());
const success = $derived(notificationPreferences.value.success);
const rows = $derived([
	{
		source: "scheduled" as const,
		label: m.settings_notify_scheduled({}, { locale }),
	},
	{ source: "hook" as const, label: m.settings_notify_hook({}, { locale }) },
	{
		source: "background" as const,
		label: m.settings_notify_background({}, { locale }),
	},
]);
let saveError = $state("");

async function setSource(
	source: SilenceableNotificationSource,
	enabled: boolean,
) {
	saveError = "";
	try {
		await notificationPreferences.update({
			notifications: { success: { [source]: enabled } },
		});
	} catch (error) {
		console.error("[notifications] Failed to save preferences:", error);
		saveError = m.settings_notify_save_failed({}, { locale });
	}
}

onSettingsPageActive(async () => {
	if (!(await ensureAuth())) return;
	await authStore.ensureLoaded();
	await notificationPreferences
		.sync()
		.catch((error) =>
			console.error("[notifications] Failed to load preferences:", error),
		);
});
</script>

<div class="flex-1 px-6 py-7">
	<section class="max-w-2xl">
		<div class="border-b border-border-subtle pb-5">
			<h1 class="text-[18px] font-semibold tracking-tight text-text-primary">{m.page_title_notifications({}, { locale })}</h1>
			<p class="mt-1 max-w-xl text-[13px] leading-5 text-text-tertiary">{m.settings_notifications_description({}, { locale })}</p>
		</div>
		<div class="divide-y divide-border-subtle border-b border-border-subtle" aria-busy={!notificationPreferences.loaded}>
			{#each rows as row (row.source)}
				<div class="flex min-h-12 items-center justify-between gap-4 py-2">
					<span class="text-[13px] text-text-primary">{row.label}</span>
					<ToggleSwitch checked={success[row.source]} label={row.label} onchange={(enabled) => void setSource(row.source, enabled)} />
				</div>
			{/each}
		</div>
		<p class="mt-3 text-[12px] leading-5 text-text-tertiary">{m.notif_failures_always({}, { locale })}</p>
		{#if saveError}<p class="mt-3 text-[12px] text-error-soft" role="alert">{saveError}</p>{/if}
	</section>
</div>
