<script lang="ts">
import {
	type HostBridgeCapability,
	type HostPermissions,
} from "@cohub/protocol/host-bridge";
import { onMount } from "svelte";
import ToggleSwitch from "$lib/components/ToggleSwitch.svelte";
import {
	callHost,
	hostPlatform,
	readyHost,
	supportsHostCapability,
} from "$lib/host-bridge";
import {
	hostPermissions,
	openHostPermissionSettings,
	requestHostPermission,
} from "$lib/host-permissions.svelte";
import { getLocale } from "$lib/i18n/locale.svelte";
import { m } from "$lib/paraglide/messages.js";

const locale = $derived(getLocale());
const permissions = $derived(hostPermissions());
const LISTED = [
	"files",
	"microphone",
	"camera",
	"notifications",
	"background",
] as const satisfies readonly (keyof HostPermissions)[];
const rows = $derived(
	LISTED.flatMap((kind) => {
		const state = permissions?.[kind];
		return state ? [{ kind, state }] : [];
	}),
);

const SETTINGS = [
	{ capability: "runtime.keepAwake", method: "runtime.keepAwake" },
	{ capability: "app.launchAtLogin", method: "app.launchAtLogin" },
	{ capability: "app.globalShortcut", method: "app.globalShortcut" },
] as const satisfies readonly {
	capability: HostBridgeCapability;
	method: string;
}[];
type Setting = (typeof SETTINGS)[number]["method"];

let values = $state<Partial<Record<Setting, boolean>>>({});

onMount(async () => {
	if (!(await readyHost())) return;
	for (const { capability, method } of SETTINGS) {
		if (!supportsHostCapability(capability)) continue;
		void callHost(method, {}).then(
			(value) => (values[method] = value),
			() => undefined,
		);
	}
});

async function change(method: Setting, enabled: boolean) {
	const previous = values[method];
	values[method] = enabled;
	try {
		values[method] = await callHost(method, { enabled });
	} catch {
		values[method] = previous;
	}
}

function permissionLabel(kind: (typeof LISTED)[number]) {
	switch (kind) {
		case "files":
			return m.permission_files({}, { locale });
		case "microphone":
			return m.permission_microphone({}, { locale });
		case "camera":
			return m.permission_camera({}, { locale });
		case "notifications":
			return m.permission_notifications({}, { locale });
		case "background":
			return m.permission_background({}, { locale });
	}
}

function settingLabel(method: Setting) {
	if (method === "runtime.keepAwake")
		return [
			m.device_keep_awake({}, { locale }),
			m.device_keep_awake_hint({}, { locale }),
		];
	if (method === "app.launchAtLogin")
		return [
			m.device_launch_at_login({}, { locale }),
			m.device_launch_at_login_hint({}, { locale }),
		];
	const shortcut = hostPlatform() === "macos" ? "⌃⌥Space" : "Ctrl+Alt+Space";
	return [
		m.device_global_shortcut({}, { locale }),
		m.device_global_shortcut_hint({ shortcut }, { locale }),
	];
}
</script>

{#if rows.length > 0 || Object.keys(values).length > 0}
	<div class="mt-6 border-t border-border-subtle pt-6">
		<h3 class="text-[13px] font-medium text-text-primary">{m.device_settings({}, { locale })}</h3>
		<div class="mt-3 flex flex-col">
			{#each SETTINGS as { method } (method)}
				{@const value = values[method]}
				{#if value !== undefined}
					{@const [label, hint] = settingLabel(method)}
					<div class="flex min-h-11 items-center gap-3 py-1.5">
						<span class="min-w-0 flex-1"><span class="block text-[12px] text-text-primary">{label}</span><span class="block text-[11px] leading-4 text-text-tertiary">{hint}</span></span>
						<ToggleSwitch checked={value} {label} onchange={(enabled) => void change(method, enabled)} />
					</div>
				{/if}
			{/each}
			{#each rows as { kind, state } (kind)}
				<div class="flex min-h-11 items-center gap-3 py-1.5">
					<span class="min-w-0 flex-1 text-[12px] text-text-primary">{permissionLabel(kind)}</span>
					{#if state === "granted"}
						<span class="text-[11px] text-text-tertiary">{m.permission_allowed({}, { locale })}</span>
					{:else if state === "prompt"}
						<button type="button" class="rounded-[5px] px-2 py-1 text-[11px] text-brand transition-colors hover:bg-bg-hover" onclick={() => void requestHostPermission(kind)}>{m.permission_allow({}, { locale })}</button>
					{:else}
						<button type="button" class="rounded-[5px] px-2 py-1 text-[11px] text-brand transition-colors hover:bg-bg-hover" onclick={() => void openHostPermissionSettings(kind)}>{m.permission_open_settings({}, { locale })}</button>
					{/if}
				</div>
			{/each}
		</div>
	</div>
{/if}
