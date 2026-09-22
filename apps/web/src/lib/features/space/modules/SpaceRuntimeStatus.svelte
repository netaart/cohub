<script lang="ts">
import { Monitor, RefreshCw, Settings2, X } from "lucide-svelte";
import { tick, untrack } from "svelte";
import { goto } from "$app/navigation";
import { floatNear, portal } from "$lib/actions/portal";
import { getLocale } from "$lib/i18n/locale.svelte";
import { m } from "$lib/paraglide/messages.js";
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

const { spaceId, canManage = false }: { spaceId: string; canManage?: boolean } =
	$props();
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

function ageLabel(at: number) {
	const ms = now - at;
	if (!Number.isFinite(ms) || ms < 45_000)
		return m.time_just_now({}, { locale });
	const minutes = Math.round(ms / 60_000);
	if (minutes < 60) return m.time_ago_min({ n: minutes }, { locale });
	const hours = Math.round(minutes / 60);
	return hours < 24
		? m.time_ago_hour({ n: hours }, { locale })
		: m.time_ago_day({ n: Math.round(hours / 24) }, { locale });
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
				</dl>
				{#if tone !== "online"}
					<p class="runtime-hint">{tone === "attention" ? m.runtime_degraded_hint({}, { locale }) : tone === "unknown" ? m.runtime_unknown_hint({}, { locale }) : m.runtime_disconnected_hint({}, { locale })}</p>
				{/if}
				{#if status.runtimeId}<details class="runtime-details"><summary>{m.runtime_diagnostics({}, { locale })}</summary><dl><dt>{m.runtime_id({}, { locale })}</dt><dd><code>{status.runtimeId}</code></dd></dl><code>cohub runtime logs --follow</code></details>{/if}
				{#if tone === "offline" && canManage}<div class="runtime-command"><span>{m.runtime_offline_hint({}, { locale })}</span><code>cohub runtime up --space {spaceId}</code></div>{/if}
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
.runtime-chip:focus-visible, .runtime-action:focus-visible, summary:focus-visible { outline: 2px solid var(--brand); outline-offset: 2px; }
.runtime-popover:focus { outline: none; }
.is-failed { color: var(--color-error-soft); }
@media (max-width: 640px) {
	.runtime-location { display: none; }
	.runtime-chip { padding: 0 6px; gap: 5px; }
	.runtime-popover { left: 8px !important; right: 8px !important; top: auto !important; bottom: max(8px, env(safe-area-inset-bottom)) !important; width: auto !important; max-height: calc(100dvh - 32px); }
	.runtime-backdrop { background: var(--overlay-scrim); }
	.runtime-action { width: 44px; height: 44px; }
}
</style>
