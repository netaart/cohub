<script lang="ts">
import {
	type InstalledApp,
	type SpaceInstalledApps,
	setInstalledAppEnabled,
} from "@cohub/protocol";
import { AlertCircle, Box, Loader2, PackageOpen, Trash2 } from "lucide-svelte";
import { onMount } from "svelte";
import { setCohubResourceDragData } from "$lib/drag/cohub-resource-drag";
import { pointerDrag, pointerDragSource } from "$lib/drag/pointer-drag.svelte";
import {
	cacheInstalledApps,
	type InstalledAppsFile,
	readInstalledApps,
	writeInstalledApps,
} from "$lib/features/app/app-center";
import { INSTALLED_APPS_CHANGED_EVENT } from "$lib/features/app/app-realtime";

type Props = {
	spaceId: string;
	canWrite: boolean;
	onOpenMarketplace: () => void;
	onOpenInstalled: (app: InstalledApp) => void;
};

let { spaceId, canWrite, onOpenMarketplace, onOpenInstalled }: Props = $props();

let installedFile = $state<InstalledAppsFile | null>(null);
let loading = $state(false);
let error = $state("");
let mutationId = $state<string | null>(null);
let requestToken = 0;
let mutationToken = 0;
let loadedFor: string | null = null;
let stateSpaceId: string | null = null;

const installed = $derived(installedFile?.document.apps ?? []);

function errorMessage(cause: unknown) {
	return cause instanceof Error
		? cause.message
		: "Failed to load installed Apps.";
}

async function loadInstalled() {
	const requestSpaceId = spaceId;
	const token = ++requestToken;
	loading = true;
	error = "";
	try {
		const nextFile = await readInstalledApps(requestSpaceId, {
			refresh: loadedFor === requestSpaceId,
		});
		if (spaceId !== requestSpaceId || requestToken !== token) return;
		installedFile = nextFile;
		loadedFor = requestSpaceId;
	} catch (cause) {
		if (spaceId !== requestSpaceId || requestToken !== token) return;
		error = errorMessage(cause);
	} finally {
		if (spaceId === requestSpaceId && requestToken === token) loading = false;
	}
}

async function persist(
	key: string,
	update: (document: SpaceInstalledApps) => SpaceInstalledApps,
) {
	if (!installedFile || mutationId || !canWrite) return false;
	const requestSpaceId = spaceId;
	const token = ++mutationToken;
	const previous = installedFile;
	const next = update(previous.document);
	mutationId = key;
	error = "";
	installedFile = { ...previous, document: next };
	try {
		const revision = await writeInstalledApps(
			requestSpaceId,
			next,
			previous.revision,
		);
		if (spaceId !== requestSpaceId || mutationToken !== token) return false;
		installedFile = { document: next, revision };
		cacheInstalledApps(requestSpaceId, installedFile);
		return true;
	} catch (cause) {
		if (spaceId !== requestSpaceId || mutationToken !== token) return false;
		installedFile = previous;
		error = `${cause instanceof Error ? cause.message : "Failed to update installed Apps."} Refresh before trying again.`;
		return false;
	} finally {
		if (spaceId === requestSpaceId && mutationToken === token)
			mutationId = null;
	}
}

function setEnabled(app: InstalledApp, enabled: boolean) {
	void persist(`toggle:${app.id}`, (document) =>
		setInstalledAppEnabled(document, app.id, enabled),
	);
}

function uninstall(app: InstalledApp) {
	if (!confirm(`Uninstall ${app.snapshot.name}?`)) return;
	void persist(`remove:${app.id}`, (document) => ({
		...document,
		apps: document.apps.filter((item) => item.id !== app.id),
	}));
}

$effect(() => {
	if (stateSpaceId === spaceId) return;
	stateSpaceId = spaceId;
	mutationToken += 1;
	mutationId = null;
	installedFile = null;
	loadedFor = null;
	void loadInstalled();
});

onMount(() => {
	let refreshTimer: ReturnType<typeof setTimeout> | null = null;
	const onInstalledAppsChanged = (event: Event) => {
		const detail = (event as CustomEvent<{ spaceId?: string }>).detail;
		if (detail?.spaceId !== spaceId || loadedFor !== spaceId) return;
		if (refreshTimer) clearTimeout(refreshTimer);
		refreshTimer = setTimeout(() => {
			refreshTimer = null;
			void loadInstalled();
		}, 150);
	};
	window.addEventListener(INSTALLED_APPS_CHANGED_EVENT, onInstalledAppsChanged);
	return () => {
		if (refreshTimer) clearTimeout(refreshTimer);
		window.removeEventListener(
			INSTALLED_APPS_CHANGED_EVENT,
			onInstalledAppsChanged,
		);
	};
});
</script>

<div class="flex h-full min-h-0 flex-col bg-bg-primary">
	<div class="min-h-0 flex-1 overflow-y-auto px-2 py-2">
		{#if error}
			<div class="mb-2 flex items-start gap-2 rounded-[5px] bg-error-bg px-2.5 py-2 text-[11px] leading-4 text-error-soft">
				<AlertCircle class="mt-0.5 h-3.5 w-3.5 shrink-0" />
				<span>{error}</span>
			</div>
		{/if}

		{#if loading && !installedFile}
			<div class="space-y-2 px-2 py-1" aria-label="Loading Apps">
				{#each [1, 2, 3] as item (item)}
					<div class="flex h-12 items-center gap-2.5 rounded-[5px] px-2">
						<div class="h-8 w-8 animate-pulse rounded-[6px] bg-bg-elevated"></div>
						<div class="min-w-0 flex-1 space-y-1.5"><div class="h-2.5 w-2/3 animate-pulse rounded bg-bg-elevated"></div><div class="h-2 w-1/2 animate-pulse rounded bg-bg-elevated/70"></div></div>
					</div>
				{/each}
			</div>
		{:else}
			<div class="divide-y divide-border-subtle/70">
				<button type="button" class="flex w-full min-w-0 items-center gap-2.5 rounded-[5px] px-2 py-2.5 text-left transition-colors hover:bg-bg-hover" onclick={onOpenMarketplace}>
					<div class="flex h-8 w-8 shrink-0 items-center justify-center rounded-[6px] bg-brand-muted text-brand"><PackageOpen class="h-4 w-4" /></div>
					<div class="min-w-0 flex-1"><div class="truncate text-[12px] font-medium text-text-primary">Marketplace</div><div class="mt-0.5 truncate text-[10px] text-text-placeholder">Discover Apps</div></div>
				</button>

				{#each installed as app (app.id)}
					<div
						class="group flex min-w-0 items-center gap-2.5 rounded-[5px] px-2 py-2.5 transition-colors hover:bg-bg-hover"
						class:opacity-60={!app.enabled}
						class:bg-bg-hover={pointerDrag.payload?.items.some((item) => item.appId === app.id)}
						draggable={app.enabled}
						role="button"
						tabindex="-1"
						use:pointerDragSource={{
							enabled: app.enabled,
							getPayload: () => ({
								origin: "apps-sidebar",
								items: [{ type: "app", path: "", name: app.snapshot.name, appId: app.id, appRef: app.ref, appUrl: app.url, icon: app.snapshot.icon ?? undefined }],
							}),
						}}
						ondragstart={(event) => {
							if (!app.enabled) { event.preventDefault(); return; }
							setCohubResourceDragData(event.dataTransfer, {
								version: 1,
								resources: [{ type: "app", ref: app.ref, title: app.snapshot.name, href: app.url, appId: app.id, ...(app.snapshot.icon ? { icon: app.snapshot.icon } : {}) }],
								origin: { kind: "sidebar-session-list" },
							});
						}}
					>
						{#if app.snapshot.icon}<img src={app.snapshot.icon} alt="" class="h-8 w-8 shrink-0 rounded-[6px] object-cover ring-1 ring-border-subtle" />{:else}<div class="flex h-8 w-8 shrink-0 items-center justify-center rounded-[6px] bg-bg-elevated text-text-tertiary"><Box class="h-4 w-4" /></div>{/if}
						<button type="button" class="min-w-0 flex-1 text-left" disabled={!app.enabled} onclick={() => onOpenInstalled(app)}>
							<div class="truncate text-[12px] font-medium text-text-primary">{app.snapshot.name}</div>
							<div class="mt-0.5 truncate font-mono text-[10px] text-text-placeholder">{app.ref}</div>
						</button>
						<div class="flex shrink-0 items-center gap-0.5">
							<label class="inline-flex h-8 w-8 cursor-pointer items-center justify-center" title={app.enabled ? "Disable" : "Enable"}>
								<input type="checkbox" class="sr-only" checked={app.enabled} disabled={!canWrite || Boolean(mutationId)} onchange={(event) => setEnabled(app, event.currentTarget.checked)} />
								<span class="h-3.5 w-6 rounded-full p-0.5 transition-colors {app.enabled ? 'bg-brand' : 'bg-bg-elevated'}"><span class="block h-2.5 w-2.5 rounded-full bg-brand-contrast-fg transition-transform {app.enabled ? 'translate-x-2.5' : ''}"></span></span>
							</label>
							<button type="button" class="inline-flex h-8 w-8 items-center justify-center rounded-[5px] text-text-placeholder transition-colors hover:bg-bg-hover hover:text-error-soft disabled:opacity-40" title="Uninstall" aria-label={`Uninstall ${app.snapshot.name}`} disabled={!canWrite || Boolean(mutationId)} onclick={() => uninstall(app)}><Trash2 class="h-3.5 w-3.5" /></button>
						</div>
					</div>
				{/each}
			</div>
		{/if}
	</div>

	{#if !canWrite}
		<div class="border-t border-border-subtle px-3 py-2 text-[10px] text-text-placeholder">Read-only Space</div>
	{/if}
</div>
