<script lang="ts">
import type { AppDevice } from "@neta-art/cohub";
import { Camera, MapPin, Mic } from "lucide-svelte";
import Dialog from "$lib/components/Dialog.svelte";
import { appDevicesLabel } from "$lib/features/app/app-devices";
import { getLocale } from "$lib/i18n/locale.svelte";
import { m } from "$lib/paraglide/messages.js";

const {
	open,
	devices,
	appName,
	onConfirm,
	onCancel,
}: {
	open: boolean;
	devices: AppDevice[];
	appName: string;
	onConfirm: () => void;
	onCancel: () => void;
} = $props();

const locale = $derived(getLocale());
</script>

<Dialog {open} onClose={onCancel} maxWidth="420px">
	{#if devices.length}
		<div class="device-panel">
			<div class="device-intro">
				<div class="device-icon">
					{#if devices.includes("camera")}
						<Camera class="h-4 w-4" />
					{/if}
					{#if devices.includes("microphone")}
						<Mic class="h-4 w-4" />
					{/if}
					{#if devices.includes("location")}
						<MapPin class="h-4 w-4" />
					{/if}
				</div>
				<div class="min-w-0">
					<div class="device-title">{m.app_devices_title({ name: appName }, { locale })}</div>
					<p class="device-copy">{m.app_devices_body({ devices: appDevicesLabel(devices, locale) }, { locale })}</p>
				</div>
			</div>
			<div class="device-actions">
				<button type="button" class="device-cancel" onclick={onCancel}>{m.common_cancel({}, { locale })}</button>
				<button type="button" class="device-confirm primary-key" onclick={onConfirm}>{m.app_devices_allow({}, { locale })}</button>
			</div>
		</div>
	{/if}
</Dialog>

<style>
	.device-panel {
		display: grid;
		gap: 18px;
		padding: 16px;
	}

	.device-intro {
		display: grid;
		grid-template-columns: 34px minmax(0, 1fr);
		gap: 12px;
		align-items: flex-start;
	}

	.device-icon {
		display: inline-flex;
		width: 34px;
		height: 34px;
		align-items: center;
		justify-content: center;
		gap: 2px;
		border-radius: 9px;
		background: var(--brand-muted);
		color: var(--brand-muted-fg);
		border: 1px solid var(--brand-border);
	}

	.device-title {
		font-size: 15px;
		font-weight: 650;
		line-height: 1.25;
		letter-spacing: -0.01em;
		color: var(--text-primary);
	}

	.device-copy {
		margin-top: 6px;
		font-size: 13px;
		line-height: 1.55;
		color: var(--text-secondary);
	}

	.device-actions {
		display: flex;
		justify-content: flex-end;
		gap: 8px;
	}

	.device-cancel,
	.device-confirm {
		display: inline-flex;
		height: 34px;
		min-width: 72px;
		align-items: center;
		justify-content: center;
		border-radius: 7px;
		padding: 0 13px;
		font-size: 12.5px;
		font-weight: 650;
		line-height: 1;
		transition: background-color 0.15s ease, border-color 0.15s ease, color 0.15s ease, transform 0.15s ease;
	}

	.device-cancel {
		border: 1px solid transparent;
		color: var(--text-secondary);
	}

	.device-cancel:hover {
		background: var(--bg-hover);
		color: var(--text-primary);
	}

	.device-cancel:focus-visible,
	.device-confirm:focus-visible {
		outline: none;
		box-shadow: 0 0 0 2px var(--bg-primary), 0 0 0 4px var(--brand-ring);
	}

	@media (max-width: 640px) {
		.device-actions {
			display: grid;
			grid-template-columns: 1fr 1fr;
		}

		.device-cancel,
		.device-confirm {
			height: 44px;
			min-width: 0;
		}
	}
</style>
