<script lang="ts">
import type { DeviceRuntimeInstance } from "@cohub/protocol/host-bridge";
import {
	type DisplayList,
	HttpError,
	type SpacePresenceUser,
} from "@neta-art/cohub";
import { Monitor, RefreshCw, Settings2, X } from "lucide-svelte";
import { tick, untrack } from "svelte";
import { goto } from "$app/navigation";
import { floatNear, portal } from "$lib/actions/portal";
import DeviceFolderPicker from "$lib/components/DeviceFolderPicker.svelte";
import {
	deviceDisplayStatus,
	openDeviceControlSettings,
	shareDeviceDisplay,
	stopDeviceDisplay,
} from "$lib/device-display.svelte";
import {
	type DeviceRuntimeRefusal,
	deviceRuntimeInstances,
	isDeviceRuntimeRunning,
	startDeviceRuntime,
	stopDeviceRuntime,
} from "$lib/device-runtime.svelte";
import { getLocale } from "$lib/i18n/locale.svelte";
import { formatTimeAgo } from "$lib/i18n/time-ago";
import { m } from "$lib/paraglide/messages.js";
import { sdk } from "$lib/sdk";
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
let pickingFolder = $state(false);
const displays = $derived(
	tone !== "unknown" && status?.workspace?.online
		? (status.displays ?? [])
		: [],
);
const screen = $derived(serving ? deviceDisplayStatus() : null);
const sharingHere = $derived(screen?.sharedWith === spaceId);
const screenLabel = $derived(
	sharingHere
		? screen?.control
			? m.runtime_display_sharing_control({}, { locale })
			: m.runtime_display_sharing({}, { locale })
		: m.runtime_not_connected({}, { locale }),
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
	if (code === "signed_out") return m.runtime_device_signed_out({}, { locale });
	if (code === "forbidden") return m.runtime_device_forbidden({}, { locale });
	if (code === "conflict") return m.runtime_device_conflict({}, { locale });
	return m.runtime_device_failed({}, { locale });
}

function refusalLabel(refusal: DeviceRuntimeRefusal | "declined") {
	if (refusal === "declined")
		return m.runtime_device_access_required({}, { locale });
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
	try {
		const refusal = await action();
		if (refusal) deviceHint = refusalLabel(refusal);
		void refresh();
	} catch {
		deviceHint = m.runtime_device_failed({}, { locale });
	} finally {
		deviceBusy = false;
	}
}

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
	<button bind:this={trigger} type="button" class="runtime-chip" data-tone={tone} aria-haspopup="dialog" aria-expanded={open} aria-label={`${m.runtime_title({}, { locale })} · ${label}`} title={`${m.runtime_title({}, { locale })} · ${label}`} onclick={() => open ? close() : void show()}>
		<Monitor class="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
		<span class="runtime-location">{m.runtime_local({}, { locale })}</span>
		<span class="runtime-state"><span class="runtime-dot" aria-hidden="true"></span>{label}</span>
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
							{#each status.capabilities.harnesses as harness}<span class="harness-line">{harness === "pi" ? "Pi" : "Codex"}<span class="runtime-meta">{m.runtime_model_count({ count: counts[harness] }, { locale })}</span></span>{/each}
						{:else}—{/if}
					</dd></div>
					<div class="runtime-row"><dt>{m.runtime_connection({}, { locale })}</dt><dd>{tone === "unknown" ? m.runtime_watcher_unknown({}, { locale }) : status.online ? m.runtime_online({}, { locale }) : m.runtime_offline({}, { locale })}</dd></div>
					<div class="runtime-row"><dt>{m.runtime_workspace_bridge({}, { locale })}</dt><dd>{bridgeLabel}</dd></div>
					<div class="runtime-row"><dt>{m.runtime_file_watcher({}, { locale })}</dt><dd>{watcherLabel}{#if watcher}<span class="runtime-meta block">{watcher.backend} · {ageLabel(Date.parse(watcher.observedAt))}</span>{/if}</dd></div>
					{#if deviceInstances}<div class="runtime-row"><dt>{m.runtime_this_device({}, { locale })}</dt><dd class:is-failed={device?.state === "error"}>{deviceLabel}{#if device}<span class="runtime-meta block">{device.label}</span>{/if}</dd></div>{/if}
					{#if screen}<div class="runtime-row"><dt>{m.runtime_this_screen({}, { locale })}</dt><dd>{screenLabel}{#if screen.sharedWith && !sharingHere}<span class="runtime-meta block">{m.runtime_display_shared_elsewhere({}, { locale })}</span>{/if}</dd></div>{/if}
				</dl>
				{#if displays.length > 0}
					<div class="runtime-displays">
						<h3>{m.runtime_displays({}, { locale })}</h3>
						{#each displays as item (item.id)}
							<div class="runtime-display">
								<span class="runtime-display-name">{item.name || item.id}<span class="runtime-meta">{item.width}×{item.height}</span></span>
								<DisplayViewers viewers={item.viewers} {people} />
								{#if canView && onOpenDisplay}<button type="button" class="runtime-display-open" onclick={() => openDisplay(item.id)}>{m.runtime_display_open({}, { locale })}</button>{/if}
							</div>
						{/each}
					</div>
				{/if}
				{#if tone !== "online"}
					<p class="runtime-hint">{tone === "attention" ? m.runtime_degraded_hint({}, { locale }) : tone === "unknown" ? m.runtime_unknown_hint({}, { locale }) : m.runtime_disconnected_hint({}, { locale })}</p>
				{/if}
				{#if status.runtimeId}<details class="runtime-details"><summary>{m.runtime_diagnostics({}, { locale })}</summary><dl><dt>{m.runtime_id({}, { locale })}</dt><dd><code>{status.runtimeId}</code></dd></dl><code>cohub runtime logs --follow</code></details>{/if}
				{#if deviceInstances && canManage}
					{#if deviceHint}<p class="runtime-hint">{deviceHint}</p>{/if}
					<div class="runtime-device-actions">
						{#if serving}
							{#if screen}
								{#if sharingHere}
									<button type="button" class="runtime-device-action" data-secondary="true" disabled={deviceBusy} onclick={() => void updateScreen(stopDeviceDisplay)}>{m.runtime_display_stop({}, { locale })}</button>
									{#if !screen.control}<button type="button" class="runtime-device-action" disabled={deviceBusy} onclick={() => void updateScreen(openDeviceControlSettings)}>{m.runtime_display_allow_control({}, { locale })}</button><p class="runtime-meta w-full">{m.runtime_display_control_hint({}, { locale })}</p>{/if}
								{:else}
									<button type="button" class="runtime-device-action" disabled={deviceBusy} onclick={() => void updateScreen(() => shareDeviceDisplay(spaceId))}>{m.runtime_display_share({}, { locale })}</button>
								{/if}
							{/if}
							<button type="button" class="runtime-device-action" data-secondary="true" disabled={deviceBusy} onclick={() => void updateDevice(async () => { await stopDeviceRuntime(spaceId); return null; })}>{m.runtime_device_disconnect({}, { locale })}</button>
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
					{#if canManage}<button type="button" class="runtime-action" aria-label={m.runtime_manage({}, { locale })} title={m.runtime_manage({}, { locale })} onclick={() => { close(); void goto(`/spaces/${spaceId}/settings`); }}><Settings2 class="h-4 w-4" /></button>{/if}
				</div>
			</div>
		</div>
	{/if}
{:else if status?.kind === "cloud" && canView && onOpenDisplay}
	<button bind:this={trigger} type="button" class="runtime-chip" aria-haspopup="dialog" aria-expanded={open} aria-label={m.virtual_display_title({}, { locale })} title={m.virtual_display_title({}, { locale })} onclick={() => open ? close() : void showVirtual()}>
		<Monitor class="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
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
							<button type="button" class="runtime-device-action" data-secondary="true" onclick={() => { close(); void goto(`/spaces/${spaceId}/settings`); }}>{m.runtime_manage({}, { locale })}</button>
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
.runtime-chip { display: inline-flex; flex: 0 0 auto; height: 30px; align-items: center; gap: 6px; padding: 0 8px; border: 1px solid var(--border-subtle); border-radius: 6px; color: var(--text-secondary); cursor: pointer; font-size: 12px; white-space: nowrap; }
.runtime-chip:hover, .runtime-chip[aria-expanded="true"] { background: var(--bg-hover); }
.runtime-state { display: inline-flex; align-items: center; gap: 5px; color: var(--text-tertiary); font-size: 12px; }
.runtime-dot { width: 6px; height: 6px; flex: 0 0 auto; border-radius: 50%; background: var(--text-placeholder); }
[data-tone="online"] .runtime-dot { background: var(--status-running); }
[data-tone="attention"] .runtime-dot { background: var(--color-warning); }
[data-tone="attention"] .runtime-state { color: var(--color-warning); }
[data-tone="offline"] .runtime-dot { background: transparent; box-shadow: inset 0 0 0 1px var(--text-placeholder); }
.runtime-backdrop { position: fixed; inset: 0; z-index: 120; cursor: default; }
.runtime-popover { display: flex; flex-direction: column; max-width: calc(100vw - 16px); max-height: calc(100dvh - 32px); border: 1px solid var(--border-subtle); border-radius: 10px; background: var(--bg-elevated); box-shadow: 0 10px 30px color-mix(in srgb, var(--overlay-scrim-strong) 20%, transparent); overflow: hidden; }
.runtime-header { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; padding: 14px 12px 10px 16px; }
.runtime-header h2 { margin: 0 0 4px; color: var(--text-primary); font-size: 14px; font-weight: 600; }
.runtime-body { min-height: 0; padding: 0 16px 12px; overflow-y: auto; overscroll-behavior: contain; }
.runtime-row { display: grid; grid-template-columns: minmax(90px, .8fr) minmax(0, 1.2fr); gap: 12px; padding: 8px 0; font-size: 13px; }
.runtime-row dt, .runtime-details dt { color: var(--text-tertiary); }
.runtime-row dd { min-width: 0; text-align: right; color: var(--text-secondary); overflow-wrap: anywhere; }
.harness-line { display: flex; justify-content: flex-end; flex-wrap: wrap; gap: 6px; }
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
.runtime-chip:focus-visible, .runtime-action:focus-visible, .runtime-device-action:focus-visible, summary:focus-visible { outline: 2px solid var(--brand); outline-offset: 2px; }
.runtime-popover:focus { outline: none; }
.is-failed { color: var(--color-error-soft); }
@media (max-width: 640px) {
	.runtime-location { display: none; }
	.runtime-chip { padding: 0 6px; gap: 5px; }
	.runtime-popover { left: 8px !important; right: 8px !important; top: auto !important; bottom: max(8px, env(safe-area-inset-bottom)) !important; width: auto !important; max-height: calc(100dvh - 32px); }
	.runtime-backdrop { background: var(--overlay-scrim); }
	.runtime-action { width: 44px; height: 44px; }
	.runtime-device-action { min-height: 44px; }
	.runtime-display-open { height: 36px; padding: 0 14px; }
}
</style>
