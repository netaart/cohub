<script lang="ts">
import type { DeviceRuntimeInstance } from "@cohub/protocol/host-bridge";
import { harnessLabel } from "@cohub/protocol/runtime";
import {
	type DisplayList,
	HttpError,
	type SpacePresenceUser,
} from "@neta-art/cohub";
import { Monitor, RefreshCw, Settings2, X } from "lucide-svelte";
import { tick, untrack } from "svelte";
import { goto } from "$app/navigation";
import { floatNear, portal } from "$lib/actions/portal";
import HarnessIcon from "$lib/components/composer/HarnessIcon.svelte";
import DeviceFolderPicker from "$lib/components/DeviceFolderPicker.svelte";
import HostPermissionNotice from "$lib/components/HostPermissionNotice.svelte";
import {
	canFloatDeviceDisplay,
	deviceDisplayStatus,
	floatDeviceDisplay,
	openDeviceControlSettings,
	pairPhoneControl,
	setupPhoneControl,
	shareDeviceDisplay,
	stopDeviceDisplay,
} from "$lib/device-display.svelte";
import {
	type DeviceRuntimeRefusal,
	deviceRuntimeInstances,
	isDeviceRuntimeRunning,
	startDeviceRuntime,
	stopDeviceRuntime,
	takeDeviceConnectIssue,
} from "$lib/device-runtime.svelte";
import { hostPlatform } from "$lib/host-bridge";
import { getLocale } from "$lib/i18n/locale.svelte";
import { m } from "$lib/paraglide/messages.js";
import { formatTimeAgo } from "$lib/resource-kit/time";
import { sdk } from "$lib/sdk";
import { buildSpaceSettingsRoute } from "$lib/space-routes";
import {
	cachedRuntimeStatus,
	cachedRuntimeStatusFetchedAt,
	refreshRuntimeStatus,
	runtimeStatusVerified,
	watchRuntimeStatus,
} from "../runtime-status.svelte";
import {
	freshWatcher,
	harnessModelCounts,
	runtimeTone,
} from "../runtime-status-view";
import DisplayViewers from "./DisplayViewers.svelte";

const RUNTIME_CLIENT_NAMES: Record<string, string> = {
	cli: "cohub",
	android: "Android",
};

// Cloud sandbox displays stay hidden until they ship; flip to restore the entry.
const CLOUD_DISPLAY_ENTRY = false;

const {
	spaceId,
	canManage = false,
	canView = false,
	canControl = false,
	people = [],
	onOpenDisplay,
}: {
	spaceId: string;
	canManage?: boolean;
	canView?: boolean;
	canControl?: boolean;
	people?: SpacePresenceUser[];
	onOpenDisplay?: (displayId: string) => void;
} = $props();
const locale = $derived(getLocale());
const status = $derived(cachedRuntimeStatus(spaceId));
let open = $state(false);
let now = $state(Date.now());
let refreshing = $state(false);
let lastErrorAt = $state<number | null>(null);
let trigger = $state<HTMLButtonElement | null>(null);
let panel = $state<HTMLDivElement | null>(null);
const tone = $derived(
	runtimeStatusVerified(spaceId) ? runtimeTone(status, now) : "unknown",
);
const fetchedAt = $derived(cachedRuntimeStatusFetchedAt(spaceId));
const failed = $derived(
	lastErrorAt !== null && (fetchedAt ?? 0) <= lastErrorAt,
);
const watcher = $derived(freshWatcher(status, now));
const label = $derived(
	tone === "online"
		? m.runtime_ready({}, { locale })
		: tone === "attention"
			? m.runtime_degraded({}, { locale })
			: tone === "unknown"
				? m.runtime_watcher_unknown({}, { locale })
				: m.runtime_offline({}, { locale }),
);
const counts = $derived(harnessModelCounts(status));
const clientLabel = $derived(
	status?.client
		? `${RUNTIME_CLIENT_NAMES[status.client.name] ?? status.client.name} ${status.client.version}`
		: m.runtime_client_outdated({}, { locale }),
);
const watcherLabel = $derived(
	watcher?.state === "running"
		? m.runtime_watcher_running({}, { locale })
		: watcher?.state === "degraded"
			? m.runtime_watcher_degraded({}, { locale })
			: watcher?.state === "unavailable"
				? m.runtime_watcher_unavailable({}, { locale })
				: m.runtime_watcher_unknown({}, { locale }),
);
const bridgeLabel = $derived(
	status?.workspace?.online && tone !== "unknown"
		? m.runtime_online({}, { locale })
		: status?.workspace
			? m.runtime_offline({}, { locale })
			: m.runtime_watcher_unknown({}, { locale }),
);

const deviceInstances = $derived(deviceRuntimeInstances());
const device = $derived(
	deviceInstances?.find((item) => item.spaceId === spaceId) ?? null,
);
const serving = $derived(isDeviceRuntimeRunning(device));
let deviceBusy = $state(false);
let deviceHint = $state<string | null>(null);
let confirmingStop = $state(false);
let connectFailed = $state(false);
const devicePermission = $derived(
	connectFailed ||
		device?.error === "folder_denied" ||
		device?.error === "storage_denied"
		? ("files" as const)
		: null,
);
let pickingFolder = $state(false);
const displays = $derived(
	tone !== "unknown" && status?.workspace?.online
		? (status.displays ?? [])
		: [],
);
const screen = $derived(serving ? deviceDisplayStatus() : null);
const sharingHere = $derived(screen?.sharedWith === spaceId);
const floats = $derived(screen !== null && canFloatDeviceDisplay());
const phoneControl = $derived(screen?.phoneControl ?? null);
const phoneReady = $derived(!phoneControl || phoneControl.stage === "ready");
const phoneControlLabel = $derived.by(() => {
	switch (phoneControl?.stage) {
		case "ready":
			return m.runtime_phone_control_ready({}, { locale });
		case "developer":
			return m.runtime_phone_control_developer({}, { locale });
		case "pairing":
			return m.runtime_phone_control_pairing({}, { locale });
		case "code":
			return m.runtime_phone_control_code({}, { locale });
		case "starting":
			return m.runtime_phone_control_starting({}, { locale });
		case "stopped":
			return m.runtime_phone_control_stopped({}, { locale });
		default:
			return m.runtime_phone_control_off({}, { locale });
	}
});
const canSetupPhone = $derived(
	phoneControl !== null && !["starting", "ready"].includes(phoneControl.stage),
);
const PHONE_STEPS = ["developer", "pairing", "code"] as const;
const phoneStep = $derived(
	PHONE_STEPS.indexOf(phoneControl?.stage as (typeof PHONE_STEPS)[number]),
);
const phoneCodeInput = $derived(
	phoneControl?.stage === "code" && phoneControl.codeInput === true,
);
const phoneSteps = $derived.by(() => {
	if (phoneStep < 0) return null;
	const text = {
		developer: m.runtime_phone_control_step_developer({}, { locale }),
		pairing: m.runtime_phone_control_step_pairing({}, { locale }),
		code: phoneCodeInput
			? m.runtime_phone_control_step_code_here({}, { locale })
			: m.runtime_phone_control_step_code({}, { locale }),
	};
	return PHONE_STEPS.map((id, index) => ({
		id,
		text: text[id],
		done: index < phoneStep,
		current: index === phoneStep,
	}));
});
const phoneError = $derived.by(() => {
	switch (phoneControl?.error) {
		case "notifications_off":
			return m.runtime_phone_control_error_notifications_off({}, { locale });
		case "pairing_timed_out":
			return m.runtime_phone_control_error_pairing_timed_out({}, { locale });
		case "wireless_debugging_off":
			return m.runtime_phone_control_error_wireless_debugging_off(
				{},
				{ locale },
			);
		case "wireless_debugging_unreachable":
			return m.runtime_phone_control_error_wireless_debugging_unreachable(
				{},
				{ locale },
			);
		case "helper_did_not_start":
			return m.runtime_phone_control_error_helper_did_not_start({}, { locale });
		case "helper_stopped":
			return m.runtime_phone_control_error_helper_stopped({}, { locale });
		case "unpaired":
			return m.runtime_phone_control_error_unpaired({}, { locale });
		case "pairing_wrong":
			return m.runtime_phone_control_error_pairing_wrong({}, { locale });
		case "pairing_closed":
			return m.runtime_phone_control_error_pairing_closed({}, { locale });
		case "local_network_off":
			return m.runtime_phone_control_error_local_network_off({}, { locale });
		case "wifi_off":
			return m.runtime_phone_control_error_wifi_off({}, { locale });
		default:
			return null;
	}
});
const screenLabel = $derived(
	sharingHere
		? screen?.control
			? m.runtime_display_sharing_control({}, { locale })
			: m.runtime_display_sharing({}, { locale })
		: m.runtime_display_not_shared({}, { locale }),
);

async function updateScreen(action: () => Promise<unknown>) {
	if (deviceBusy) return;
	deviceBusy = true;
	deviceHint = null;
	try {
		const outcome = await action();
		if (outcome === "declined")
			deviceHint = m.runtime_display_declined({}, { locale });
		else if (outcome === "failed")
			deviceHint = m.runtime_display_failed({}, { locale });
		void refresh();
	} catch {
		deviceHint = m.runtime_display_failed({}, { locale });
	} finally {
		deviceBusy = false;
	}
}

let pairingCode = $state("");
let pairingInput = $state<HTMLInputElement | null>(null);

function typePairingCode(event: Event & { currentTarget: HTMLInputElement }) {
	pairingCode = event.currentTarget.value.replace(/\D/g, "").slice(0, 6);
	event.currentTarget.value = pairingCode;
	if (pairingCode.length === 6) void submitPairingCode();
}

async function submitPairingCode() {
	const code = pairingCode;
	if (code.length !== 6 || deviceBusy) return;
	await updateScreen(() => pairPhoneControl(code));
	pairingCode = "";
	pairingInput?.focus();
}

// A cloud sandbox reports its virtual screen live, only while the panel is
// open, so a sleeping sandbox is never woken for it.
type VirtualPanel =
	| { kind: "loading" | "offline" | "outdated" | "failed" }
	| { kind: "ready"; list: DisplayList };
let virtualPanel = $state<VirtualPanel>({ kind: "loading" });
let virtualBusy = $state(false);

function virtualProblem(error: unknown): VirtualPanel {
	if (error instanceof HttpError && error.code === "sandbox_offline")
		return { kind: "offline" };
	if (error instanceof HttpError && error.code === "display_unsupported")
		return { kind: "outdated" };
	return { kind: "failed" };
}

async function loadVirtual() {
	try {
		const list = await sdk.space(spaceId).displays.list();
		virtualPanel = list.virtual
			? { kind: "ready", list }
			: { kind: "outdated" };
	} catch (error) {
		virtualPanel = virtualProblem(error);
	}
}

async function setVirtual(running: boolean) {
	if (virtualBusy) return;
	virtualBusy = true;
	try {
		const displays = sdk.space(spaceId).displays;
		const list = running
			? await displays.startVirtual()
			: await displays.stopVirtual();
		virtualPanel = { kind: "ready", list };
	} catch (error) {
		virtualPanel = virtualProblem(error);
	} finally {
		virtualBusy = false;
	}
}

async function showVirtual() {
	virtualPanel = { kind: "loading" };
	open = true;
	void loadVirtual();
	await tick();
	panel?.focus();
}

function openDisplay(displayId: string) {
	close();
	onOpenDisplay?.(displayId);
}

async function floatDisplay(displayId: string) {
	close();
	if (!(await floatDeviceDisplay({ spaceId, display: displayId })))
		onOpenDisplay?.(displayId);
}

const deviceLabel = $derived(
	device ? describeDevice(device) : m.runtime_not_connected({}, { locale }),
);

function describeDevice(current: DeviceRuntimeInstance) {
	if (current.state === "ready") return m.runtime_online({}, { locale });
	if (current.state === "connecting")
		return m.runtime_device_connecting({}, { locale });
	if (current.state === "error") return deviceErrorLabel(current.error);
	return m.runtime_not_connected({}, { locale });
}

function deviceErrorLabel(code: string | null) {
	if (code === "elevated") return m.runtime_device_elevated({}, { locale });
	if (code === "offline") return m.runtime_device_offline({}, { locale });
	if (code === "folder_denied")
		return m.runtime_device_folder_denied({}, { locale });
	if (code === "storage_denied")
		return m.runtime_device_storage_denied({}, { locale });
	if (code === "signed_out") return m.runtime_device_signed_out({}, { locale });
	if (code === "forbidden") return m.runtime_device_forbidden({}, { locale });
	if (code === "conflict") return m.runtime_device_conflict({}, { locale });
	return m.runtime_device_failed({}, { locale });
}

function refusalLabel(refusal: DeviceRuntimeRefusal | "declined" | "failed") {
	if (refusal === "declined")
		return hostPlatform() === "android"
			? m.runtime_device_access_required({}, { locale })
			: null;
	if (refusal === "failed")
		return device?.state === "error"
			? null
			: m.runtime_device_failed({}, { locale });
	if (refusal === "folder_denied")
		return m.runtime_device_folder_denied({}, { locale });
	if (refusal === "folder_in_use")
		return m.runtime_device_folder_in_use({}, { locale });
	if (refusal === "space_in_use")
		return m.runtime_device_space_in_use({}, { locale });
	return m.runtime_device_folder_unavailable({}, { locale });
}

async function updateDevice(
	action: () => Promise<DeviceRuntimeRefusal | "declined" | null>,
) {
	if (deviceBusy) return;
	deviceBusy = true;
	deviceHint = null;
	connectFailed = false;
	try {
		const refusal = await action();
		if (refusal) showIssue(refusal);
		void refresh();
	} catch {
		deviceHint = m.runtime_device_failed({}, { locale });
	} finally {
		deviceBusy = false;
	}
}

function showIssue(issue: DeviceRuntimeRefusal | "declined" | "failed") {
	deviceHint = refusalLabel(issue);
	connectFailed = issue === "folder_denied";
}

async function disconnect(force = false) {
	if (deviceBusy) return;
	deviceBusy = true;
	deviceHint = null;
	try {
		const refused = await stopDeviceRuntime(spaceId, force);
		confirmingStop = refused === "unconfirmed_work";
		void refresh();
	} catch {
		deviceHint = m.runtime_device_disconnect_failed({}, { locale });
	} finally {
		deviceBusy = false;
	}
}

let issueChecked = false;
$effect(() => {
	if (issueChecked || status?.kind !== "local") return;
	issueChecked = true;
	const issue = takeDeviceConnectIssue(spaceId);
	if (!issue) return;
	showIssue(issue);
	void show();
});

function chooseFolder() {
	close();
	pickingFolder = true;
}

function ageLabel(at: number) {
	return formatTimeAgo(at, now, locale);
}
async function refresh(force = true) {
	if (refreshing) return;
	refreshing = true;
	try {
		await refreshRuntimeStatus(spaceId, { force });
	} catch {
		lastErrorAt = Date.now();
	} finally {
		refreshing = false;
		now = Date.now();
	}
}
async function show() {
	open = true;
	void refresh();
	await tick();
	panel?.focus();
}
function close() {
	open = false;
	confirmingStop = false;
	trigger?.focus();
}
function onKeyDown(event: KeyboardEvent) {
	if (event.key === "Escape") {
		event.preventDefault();
		close();
	}
	if (event.key !== "Tab") return;
	const items = Array.from(
		panel?.querySelectorAll<HTMLElement>("button:not(:disabled), a[href]") ??
			[],
	);
	const first = items[0],
		last = items.at(-1);
	if (
		event.shiftKey &&
		(document.activeElement === first || document.activeElement === panel)
	) {
		event.preventDefault();
		last?.focus();
	} else if (!event.shiftKey && document.activeElement === last) {
		event.preventDefault();
		first?.focus();
	}
}
$effect(() => {
	const target = spaceId;
	open = false;
	lastErrorAt = null;
	const update = () => {
		now = Date.now();
		if (document.visibilityState === "visible")
			void refreshRuntimeStatus(target).catch(() => {
				lastErrorAt = Date.now();
			});
	};
	untrack(update);
	const timer = setInterval(update, 15_000);
	const unwatch = watchRuntimeStatus(target);
	window.addEventListener("focus", update);
	document.addEventListener("visibilitychange", update);
	return () => {
		clearInterval(timer);
		unwatch();
		window.removeEventListener("focus", update);
		document.removeEventListener("visibilitychange", update);
	};
});
</script>

{#if status?.kind === "local"}
	<button bind:this={trigger} type="button" class="header-action" data-tone={tone} aria-haspopup="dialog" aria-expanded={open} aria-label={`${m.runtime_title({}, { locale })} · ${label}`} title={`${m.runtime_title({}, { locale })} · ${label}`} onclick={() => open ? close() : void show()}>
		<Monitor aria-hidden="true" />
		<span class="hidden text-[13px] font-medium lg:inline">{m.runtime_local({}, { locale })}</span>
		<span class="runtime-dot" aria-hidden="true"></span>
		{#if tone === "attention" || tone === "offline"}<span class="runtime-label hidden lg:inline">{label}</span>{/if}
	</button>
	{#if open}
		<button type="button" class="runtime-backdrop" aria-hidden="true" tabindex="-1" use:portal onclick={close}></button>
		<div bind:this={panel} class="runtime-popover" data-tone={tone} role="dialog" aria-modal="true" aria-label={m.runtime_title({}, { locale })} tabindex="-1" onkeydown={onKeyDown} use:floatNear={{ getAnchor: () => trigger, placement: "bottom-end", gap: 8, width: 344, zIndex: 121 }}>
			<div class="runtime-header">
				<div><h2>{m.runtime_title({}, { locale })}</h2><p class="runtime-state"><span class="runtime-dot" aria-hidden="true"></span>{label}</p></div>
				<button type="button" class="runtime-action" aria-label={m.common_close({}, { locale })} onclick={close}><X class="h-4 w-4" /></button>
			</div>
			<div class="runtime-body">
				<dl>
					<div class="runtime-row"><dt>{m.runtime_harnesses({}, { locale })}</dt><dd>
						{#if status.capabilities?.harnesses.length}
							{#each status.capabilities.harnesses as harness}<span class="harness-line"><HarnessIcon {harness} size={14} />{harnessLabel(harness)}<span class="runtime-meta">{m.runtime_model_count({ count: counts[harness] }, { locale })}</span></span>{/each}
						{:else}—{/if}
					</dd></div>
					<div class="runtime-row"><dt>{m.runtime_connection({}, { locale })}</dt><dd>{tone === "unknown" ? m.runtime_watcher_unknown({}, { locale }) : status.online ? m.runtime_online({}, { locale }) : m.runtime_offline({}, { locale })}{#if status.online && status.kind === "local"}<span class="runtime-meta block">{clientLabel}</span>{/if}</dd></div>
					<div class="runtime-row"><dt>{m.runtime_workspace_bridge({}, { locale })}</dt><dd>{bridgeLabel}</dd></div>
					<div class="runtime-row"><dt>{m.runtime_file_watcher({}, { locale })}</dt><dd>{watcherLabel}{#if watcher}<span class="runtime-meta block">{watcher.backend} · {ageLabel(Date.parse(watcher.observedAt))}</span>{/if}</dd></div>
					{#if deviceInstances}<div class="runtime-row"><dt>{m.runtime_this_device({}, { locale })}</dt><dd class:is-failed={device?.state === "error"}>{deviceLabel}{#if device}<span class="runtime-meta block">{device.label}</span>{/if}</dd></div>{/if}
					{#if phoneControl}<div class="runtime-row"><dt>{m.runtime_phone_control({}, { locale })}</dt><dd>{phoneControlLabel}</dd></div>{/if}
					{#if screen}<div class="runtime-row"><dt>{m.runtime_this_screen({}, { locale })}</dt><dd>{screenLabel}{#if screen.sharedWith && !sharingHere}<span class="runtime-meta block">{m.runtime_display_shared_elsewhere({}, { locale })}</span>{/if}</dd></div>{/if}
				</dl>
				{#if displays.length > 0}
					<div class="runtime-displays">
						<h3>{m.runtime_displays({}, { locale })}</h3>
						{#each displays as item (item.id)}
							<div class="runtime-display">
								<span class="runtime-display-name">{item.kind === "agent" ? m.runtime_display_agent({}, { locale }) : item.name || item.id}{#if item.recording?.id}<span class="runtime-recording" title={m.runtime_display_recording({}, { locale })}><span class="sr-only">{m.runtime_display_recording({}, { locale })}</span></span>{/if}<span class="runtime-meta">{item.handover && !item.held ? m.runtime_display_needs_you({ reason: item.handover.reason }, { locale }) : item.held ? m.runtime_display_held({}, { locale }) : item.activity ? item.activity.label ? m.runtime_display_activity({ label: item.activity.label }, { locale }) : m.runtime_display_working({}, { locale }) : `${item.width}×${item.height}`}</span></span>
								<DisplayViewers viewers={item.viewers} {people} />
								{#if canView && floats && item.kind === "agent"}<button type="button" class="runtime-display-open" onclick={() => void floatDisplay(item.id)}>{m.runtime_display_float({}, { locale })}</button>{/if}
								{#if canView && onOpenDisplay}<button type="button" class="runtime-display-open" onclick={() => openDisplay(item.id)}>{m.runtime_display_open({}, { locale })}</button>{/if}
							</div>
						{/each}
					</div>
				{/if}
				{#if tone !== "online"}
					<p class="runtime-hint">{tone === "attention" ? m.runtime_degraded_hint({}, { locale }) : tone === "unknown" ? m.runtime_unknown_hint({}, { locale }) : m.runtime_disconnected_hint({}, { locale })}</p>
				{/if}
				{#if status.runtimeId}<details class="runtime-details"><summary>{m.runtime_diagnostics({}, { locale })}</summary><dl><dt>{m.runtime_id({}, { locale })}</dt><dd><code>{status.runtimeId}</code></dd>{#if phoneControl?.detail}<dt>{m.runtime_phone_control({}, { locale })}</dt><dd><code>{phoneControl.detail}</code></dd>{/if}</dl><code>cohub runtime logs --follow</code></details>{/if}
				{#if deviceInstances && canManage}
					{#if deviceHint}<div class="runtime-hint">{#if devicePermission}<HostPermissionNotice kind={devicePermission} message={deviceHint} />{:else}{deviceHint}{/if}</div>{:else if devicePermission && device?.state === "error"}<div class="runtime-hint"><HostPermissionNotice kind={devicePermission} /></div>{/if}
					{#if device?.error === "no_shell"}<p class="runtime-hint">{m.runtime_device_no_shell({}, { locale })} <a class="runtime-link" href="https://git-scm.com/download/win" target="_blank" rel="noreferrer">{m.runtime_device_install_git({}, { locale })}</a></p>{/if}
					{#if screen?.error === "screen_recording"}<div class="runtime-hint"><HostPermissionNotice kind="screen" message={m.runtime_display_needs_recording({}, { locale })} /></div>{/if}
					<div class="runtime-device-actions">
						{#if serving}
							{#if canSetupPhone}
								{#if phoneError}<div class="runtime-meta w-full">{#if phoneControl?.error === "notifications_off"}<HostPermissionNotice kind="notifications" message={phoneError} />{:else}{phoneError}{/if}</div>{/if}
								{#if phoneSteps}
									<ol class="runtime-steps w-full">
										{#each phoneSteps as step (step.id)}<li class:is-done={step.done} class:is-current={step.current} aria-current={step.current ? "step" : undefined}>{step.text}</li>{/each}
									</ol>
								{:else if !phoneError}
									<p class="runtime-meta w-full">{m.runtime_phone_control_hint({}, { locale })}</p>
								{/if}
								{#if phoneCodeInput}
									<form class="runtime-code w-full" onsubmit={(event) => { event.preventDefault(); void submitPairingCode(); }}>
										<!-- svelte-ignore a11y_autofocus -->
										<input bind:this={pairingInput} value={pairingCode} oninput={typePairingCode} readonly={deviceBusy} inputmode="numeric" autocomplete="one-time-code" maxlength="6" autofocus aria-label={m.runtime_phone_control_code_label({}, { locale })} placeholder="······" />
										<button type="submit" class="runtime-device-action" disabled={deviceBusy || pairingCode.length !== 6}>{m.runtime_phone_control_pair({}, { locale })}</button>
									</form>
								{:else}
									<button type="button" class="runtime-device-action" disabled={deviceBusy} onclick={() => void updateScreen(setupPhoneControl)}>{phoneSteps ? m.runtime_phone_control_open_settings({}, { locale }) : m.runtime_phone_control_setup({}, { locale })}</button>
								{/if}
							{/if}
							{#if screen && !screen.control && (phoneReady || sharingHere)}
								<button type="button" class="runtime-device-action" disabled={deviceBusy} onclick={() => void updateScreen(openDeviceControlSettings)}>{m.runtime_display_allow_control({}, { locale })}</button>
								{#if !phoneReady || !phoneControl}<p class="runtime-meta w-full">{hostPlatform() === "android" ? m.runtime_display_control_hint({}, { locale }) : m.runtime_display_control_hint_desktop({}, { locale })}</p>{/if}
							{/if}
							{#if screen}
								{#if sharingHere}
									<button type="button" class="runtime-device-action" data-secondary="true" disabled={deviceBusy} onclick={() => void updateScreen(stopDeviceDisplay)}>{m.runtime_display_stop({}, { locale })}</button>
								{:else if phoneReady}
									<button type="button" class="runtime-device-action" disabled={deviceBusy} onclick={() => void updateScreen(() => shareDeviceDisplay(spaceId))}>{m.runtime_display_share({}, { locale })}</button>
								{:else}
									<p class="runtime-meta w-full">{m.runtime_display_share_recording_hint({}, { locale })}</p>
									<button type="button" class="runtime-device-action" data-secondary="true" disabled={deviceBusy} onclick={() => void updateScreen(() => shareDeviceDisplay(spaceId))}>{m.runtime_display_share_recording({}, { locale })}</button>
								{/if}
							{/if}
							{#if confirmingStop}<p class="runtime-meta w-full">{m.runtime_device_unconfirmed({}, { locale })}</p>{/if}
							<button type="button" class="runtime-device-action" data-secondary="true" disabled={deviceBusy} onclick={() => void disconnect(confirmingStop)}>{confirmingStop ? m.runtime_device_disconnect_anyway({}, { locale }) : m.runtime_device_disconnect({}, { locale })}</button>
						{:else if device}
							{@const root = device.root}
							<button type="button" class="runtime-device-action" disabled={deviceBusy} onclick={() => void updateDevice(() => startDeviceRuntime(spaceId, root))}>{m.runtime_device_connect({}, { locale })}</button>
							<button type="button" class="runtime-device-action" data-secondary="true" disabled={deviceBusy} onclick={chooseFolder}>{m.runtime_device_change_folder({}, { locale })}</button>
						{:else}
							<button type="button" class="runtime-device-action" disabled={deviceBusy} onclick={chooseFolder}>{m.runtime_device_choose_folder({}, { locale })}</button>
						{/if}
					</div>
				{:else if tone === "offline" && canManage}<div class="runtime-command"><span>{m.runtime_offline_hint({}, { locale })}</span><code>cohub runtime up --space {spaceId}</code></div>{/if}
			</div>
			<div class="runtime-footer">
				<span class="runtime-meta" class:is-failed={failed}>{failed ? m.runtime_refresh_failed({}, { locale }) : fetchedAt ? m.runtime_last_updated({ time: ageLabel(fetchedAt) }, { locale }) : ""}</span>
				<div class="runtime-actions">
					<button type="button" class="runtime-action" aria-label={m.runtime_refresh({}, { locale })} title={m.runtime_refresh({}, { locale })} disabled={refreshing} onclick={() => void refresh()}><RefreshCw class={`h-4 w-4 ${refreshing ? "animate-spin motion-reduce:animate-none" : ""}`} /></button>
					{#if canManage}<button type="button" class="runtime-action" aria-label={m.runtime_manage({}, { locale })} title={m.runtime_manage({}, { locale })} onclick={() => { close(); void goto(buildSpaceSettingsRoute(spaceId)); }}><Settings2 class="h-4 w-4" /></button>{/if}
				</div>
			</div>
		</div>
	{/if}
{:else if CLOUD_DISPLAY_ENTRY && status?.kind === "cloud" && canView && onOpenDisplay}
	<button bind:this={trigger} type="button" class="header-action" aria-haspopup="dialog" aria-expanded={open} aria-label={m.virtual_display_title({}, { locale })} title={m.virtual_display_title({}, { locale })} onclick={() => open ? close() : void showVirtual()}>
		<Monitor aria-hidden="true" />
	</button>
	{#if open}
		<button type="button" class="runtime-backdrop" aria-hidden="true" tabindex="-1" use:portal onclick={close}></button>
		<div bind:this={panel} class="runtime-popover" role="dialog" aria-modal="true" aria-label={m.virtual_display_title({}, { locale })} tabindex="-1" onkeydown={onKeyDown} use:floatNear={{ getAnchor: () => trigger, placement: "bottom-end", gap: 8, width: 320, zIndex: 121 }}>
			<div class="runtime-header">
				<div><h2>{m.virtual_display_title({}, { locale })}</h2><p class="runtime-meta">{m.virtual_display_hint({}, { locale })}</p></div>
				<button type="button" class="runtime-action" aria-label={m.common_close({}, { locale })} onclick={close}><X class="h-4 w-4" /></button>
			</div>
			<div class="runtime-body">
				{#if virtualPanel.kind === "ready"}
					{#each virtualPanel.list.displays as item (item.id)}
						<div class="runtime-display">
							<span class="runtime-display-name">{item.name || item.id}<span class="runtime-meta">{item.width}×{item.height}</span></span>
							<DisplayViewers viewers={item.viewers} {people} />
							<button type="button" class="runtime-display-open" onclick={() => openDisplay(item.id)}>{m.runtime_display_open({}, { locale })}</button>
						</div>
					{/each}
					{#if canControl}
						<div class="runtime-device-actions">
							{#if virtualPanel.list.virtual === "running"}
								<button type="button" class="runtime-device-action" data-secondary="true" disabled={virtualBusy} onclick={() => void setVirtual(false)}>{m.virtual_display_stop({}, { locale })}</button>
							{:else}
								<button type="button" class="runtime-device-action" disabled={virtualBusy} onclick={() => void setVirtual(true)}>{m.virtual_display_start({}, { locale })}</button>
							{/if}
						</div>
					{/if}
				{:else if virtualPanel.kind === "loading"}
					<p class="runtime-hint">{m.display_connecting({}, { locale })}</p>
				{:else}
					<p class="runtime-hint">{virtualPanel.kind === "offline" ? m.virtual_display_offline({}, { locale }) : virtualPanel.kind === "outdated" ? m.virtual_display_outdated({}, { locale }) : m.virtual_display_failed({}, { locale })}</p>
					<div class="runtime-device-actions">
						{#if virtualPanel.kind === "failed"}
							<button type="button" class="runtime-device-action" data-secondary="true" onclick={() => void showVirtual()}>{m.display_retry({}, { locale })}</button>
						{:else}
							<button type="button" class="runtime-device-action" data-secondary="true" onclick={() => { close(); void goto(buildSpaceSettingsRoute(spaceId)); }}>{m.runtime_manage({}, { locale })}</button>
						{/if}
					</div>
				{/if}
			</div>
		</div>
	{/if}
{/if}
{#if deviceInstances}
	<DeviceFolderPicker open={pickingFolder} onClose={() => (pickingFolder = false)} onSelect={(folder) => { pickingFolder = false; void show(); void updateDevice(() => startDeviceRuntime(spaceId, folder.path)); }} />
{/if}

<style>
.runtime-steps { margin: 0; padding-left: 18px; list-style: decimal; color: var(--text-tertiary); font-size: 12px; line-height: 1.5; }
.runtime-steps li.is-current { color: var(--text-primary); }
.runtime-steps li.is-done { color: var(--text-placeholder); }
.runtime-steps li.is-done::marker { content: "✓  "; color: var(--status-running); }
.runtime-code { display: flex; gap: 8px; }
.runtime-code input { flex: 1; min-width: 0; height: 36px; padding: 0 10px; border-radius: 6px; background: var(--bg-input); box-shadow: inset 0 0 0 1px var(--border-subtle); color: var(--text-primary); font-size: 16px; font-variant-numeric: tabular-nums; letter-spacing: .3em; text-align: center; }
.runtime-code input::placeholder { color: var(--text-placeholder); }
.runtime-code input:focus-visible { outline: 2px solid var(--brand); outline-offset: 1px; }
.runtime-code .runtime-device-action { flex: 0 0 auto; padding: 0 16px; }
.runtime-link { color: var(--brand); white-space: nowrap; }
.runtime-link:hover { text-decoration: underline; }
.runtime-state { display: inline-flex; align-items: center; gap: 5px; color: var(--text-tertiary); font-size: 12px; }
.runtime-dot { width: 6px; height: 6px; flex: 0 0 auto; border-radius: 50%; background: var(--text-placeholder); }
[data-tone="online"] .runtime-dot { background: var(--status-running); }
[data-tone="attention"] .runtime-dot { background: var(--color-warning); }
[data-tone="attention"] .runtime-state, [data-tone="attention"] .runtime-label { color: var(--color-warning); }
.runtime-label { font-size: 13px; }
[data-tone="offline"] .runtime-dot { background: transparent; box-shadow: inset 0 0 0 1px var(--text-placeholder); }
.runtime-backdrop { position: fixed; inset: 0; z-index: 120; cursor: default; }
.runtime-popover { display: flex; flex-direction: column; max-width: calc(100vw - 16px); max-height: calc(100dvh - 32px); border: 1px solid var(--border-subtle); border-radius: 10px; background: var(--bg-elevated); box-shadow: 0 10px 30px color-mix(in srgb, var(--overlay-scrim-strong) 20%, transparent); overflow: hidden; }
.runtime-header { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; padding: 14px 12px 10px 16px; }
.runtime-header h2 { margin: 0 0 4px; color: var(--text-primary); font-size: 14px; font-weight: 600; }
.runtime-body { min-height: 0; padding: 0 16px 12px; overflow-y: auto; overscroll-behavior: contain; }
.runtime-row { display: grid; grid-template-columns: minmax(90px, .8fr) minmax(0, 1.2fr); gap: 12px; padding: 8px 0; font-size: 13px; }
.runtime-row dt, .runtime-details dt { color: var(--text-tertiary); }
.runtime-row dd { min-width: 0; text-align: right; color: var(--text-secondary); overflow-wrap: anywhere; }
.harness-line { display: flex; align-items: center; justify-content: flex-end; flex-wrap: wrap; gap: 6px; }
.runtime-meta { color: var(--text-tertiary); font-size: 12px; font-variant-numeric: tabular-nums; }
.runtime-hint { margin: 8px 0; color: var(--text-secondary); font-size: 13px; line-height: 1.6; }
.runtime-details { margin-top: 8px; border-top: 1px solid var(--border-subtle); padding-top: 10px; font-size: 12px; color: var(--text-tertiary); }
.runtime-details summary { cursor: pointer; }
.runtime-details dl { margin: 8px 0; }
.runtime-details dd { margin-top: 4px; }
.runtime-details code, .runtime-command code { display: block; overflow-wrap: anywhere; white-space: normal; user-select: all; color: var(--text-secondary); font-size: 12px; line-height: 1.6; }
.runtime-command { display: grid; gap: 6px; margin-top: 10px; color: var(--text-tertiary); font-size: 12px; }
.runtime-footer { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 6px 10px 6px 16px; border-top: 1px solid var(--border-subtle); }
.runtime-actions { display: flex; gap: 4px; }
.runtime-action { display: inline-flex; flex: 0 0 auto; height: 32px; width: 32px; align-items: center; justify-content: center; border-radius: 6px; color: var(--text-tertiary); cursor: pointer; }
.runtime-action:hover { background: var(--bg-hover); color: var(--text-secondary); }
.runtime-action:disabled { opacity: .5; cursor: default; }
.runtime-device-actions { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 10px; }
.runtime-displays { margin-top: 4px; border-top: 1px solid var(--border-subtle); padding-top: 10px; }
.runtime-displays h3 { margin: 0 0 4px; color: var(--text-tertiary); font-size: 12px; font-weight: 500; }
.runtime-display { display: flex; min-height: 36px; align-items: center; justify-content: space-between; gap: 12px; font-size: 13px; color: var(--text-secondary); }
.runtime-display-name { display: flex; flex: 1; min-width: 0; align-items: baseline; gap: 8px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.runtime-display-open { flex: 0 0 auto; height: 28px; padding: 0 10px; border-radius: 6px; background: var(--bg-input); box-shadow: inset 0 0 0 1px var(--border-subtle); color: var(--text-secondary); font-size: 12px; cursor: pointer; }
.runtime-display-open:hover { background: var(--bg-hover); color: var(--text-primary); }
.runtime-display-open:focus-visible { outline: 2px solid var(--brand); outline-offset: 2px; }
.runtime-device-action { display: flex; flex: 1; min-height: 36px; align-items: center; justify-content: center; border-radius: 6px; background: var(--brand); color: var(--brand-contrast-fg); font-size: 13px; font-weight: 500; cursor: pointer; }
.runtime-device-action:hover { background: var(--brand-hover); }
.runtime-device-action[data-secondary="true"] { background: var(--bg-input); color: var(--text-secondary); box-shadow: inset 0 0 0 1px var(--border-subtle); }
.runtime-device-action[data-secondary="true"]:hover { background: var(--bg-hover); color: var(--text-primary); }
.runtime-device-action:disabled { opacity: .6; cursor: default; }
.runtime-action:focus-visible, .runtime-device-action:focus-visible, summary:focus-visible { outline: 2px solid var(--brand); outline-offset: 2px; }
.runtime-popover:focus { outline: none; }
.is-failed { color: var(--color-error-soft); }
@media (max-width: 640px) {
	.runtime-popover { left: 8px !important; right: 8px !important; top: auto !important; bottom: max(8px, env(safe-area-inset-bottom)) !important; width: auto !important; max-height: calc(100dvh - 32px); }
	.runtime-backdrop { background: var(--overlay-scrim); }
	.runtime-action { width: 44px; height: 44px; }
	.runtime-device-action { min-height: 44px; }
	.runtime-code input { height: 44px; }
	.runtime-display-open { height: 36px; padding: 0 14px; }
}
	.runtime-recording {
		display: inline-block;
		width: 6px;
		height: 6px;
		margin-left: 6px;
		border-radius: 999px;
		background: var(--error-700);
		vertical-align: middle;
	}
</style>
