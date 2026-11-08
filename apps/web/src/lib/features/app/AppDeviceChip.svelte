<script lang="ts">
import type { AppDevice } from "@neta-art/cohub";
import { Camera, MapPin, Mic } from "lucide-svelte";
import { appDevicesLabel } from "$lib/features/app/app-devices";
import { getLocale } from "$lib/i18n/locale.svelte";
import { m } from "$lib/paraglide/messages.js";

const {
	devices,
	onTurnOff,
}: { devices: AppDevice[]; onTurnOff: (device: AppDevice) => void } = $props();

const locale = $derived(getLocale());
const ICONS = { camera: Camera, microphone: Mic, location: MapPin } as const;
const shown = $derived(
	devices.filter((device): device is keyof typeof ICONS => device in ICONS),
);

function turnOff(device: AppDevice) {
	const label = appDevicesLabel([device], locale);
	if (confirm(m.app_devices_turn_off_confirm({ devices: label }, { locale })))
		onTurnOff(device);
}
</script>

{#if shown.length > 0}
	<span
		class="inline-flex h-6 items-center rounded-full border border-border-subtle text-text-secondary"
	>
		{#each shown as device (device)}
			{@const Icon = ICONS[device]}
			{@const label = m.app_devices_active(
				{ devices: appDevicesLabel([device], locale) },
				{ locale },
			)}
			<button
				type="button"
				class="inline-flex h-full items-center px-1.5 first:pl-2 last:pr-2 transition-colors hover:bg-bg-hover hover:text-text-primary first:rounded-l-full last:rounded-r-full"
				title={label}
				aria-label={label}
				onclick={() => turnOff(device)}
			>
				<Icon class="h-3.5 w-3.5" aria-hidden="true" />
			</button>
		{/each}
	</span>
{/if}
