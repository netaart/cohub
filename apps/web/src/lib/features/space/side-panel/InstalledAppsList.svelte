<script lang="ts">
import {
	type InstalledApp,
	type SpaceInstalledApps,
	setInstalledAppEnabled,
} from "@cohub/protocol";
import { PackageOpen, Trash2 } from "lucide-svelte";
import { onMount } from "svelte";
import { avatarInitials } from "$lib/avatar-initials";
import Avatar from "$lib/components/Avatar.svelte";
import ToggleSwitch from "$lib/components/ToggleSwitch.svelte";
import {
	cacheInstalledApps,
	type InstalledAppsFile,
	readInstalledApps,
	writeInstalledApps,
} from "$lib/features/app/app-center";
import { INSTALLED_APPS_CHANGED_EVENT } from "$lib/features/app/app-realtime";
import { getLocale } from "$lib/i18n/locale.svelte";
import { m } from "$lib/paraglide/messages.js";
import LoadError from "./LoadError.svelte";
import SidePanelRow from "./SidePanelRow.svelte";
import SidePanelRowAction from "./SidePanelRowAction.svelte";
import SidePanelSection from "./SidePanelSection.svelte";

type Props = {
	spaceId: string;
	canWrite: boolean;
	draggable: boolean;
	touchDraggable: boolean;
	collapsed: boolean;
	onToggle: () => void;
	onOpenMarketplace: () => void;
	onOpenInstalled: (app: InstalledApp) => void;
};

let {
	spaceId,
	canWrite,
	draggable,
	touchDraggable,
	collapsed,
	onToggle,
	onOpenMarketplace,
	onOpenInstalled,
}: Props = $props();

const locale = $derived(getLocale());
let installedFile = $state<InstalledAppsFile | null>(null);
let loading = $state(false);
let error = $state("");
let mutationId = $state<string | null>(null);
let requestToken = 0;
let mutationToken = 0;
let loadedFor: string | null = null;
let stateSpaceId: string | null = null;

const installed = $derived(installedFile?.document.apps ?? []);

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
		error = m.apps_panel_load_failed({}, { locale });
		console.warn("[side-panel] failed to load installed apps", cause);
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
		error = m.apps_panel_update_failed({}, { locale });
		console.warn("[side-panel] failed to update installed apps", cause);
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
	if (
		!confirm(
			m.apps_panel_uninstall_confirm({ name: app.snapshot.name }, { locale }),
		)
	)
		return;
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

<SidePanelSection
	title={m.apps_panel_installed({}, { locale })}
	count={installed.length}
	{collapsed}
	{onToggle}
>
	{#snippet meta()}
		<button
			type="button"
			class="inline-flex h-6 items-center gap-1 rounded-[5px] px-1.5 text-[11px] text-text-tertiary transition-colors hover:bg-bg-hover hover:text-text-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/35"
			onclick={onOpenMarketplace}
		>
			<PackageOpen class="h-3.5 w-3.5" />
			{m.apps_panel_marketplace({}, { locale })}
		</button>
	{/snippet}
	{#if error}
		<div class="px-1.5 pb-1">
			<LoadError message={error} onRetry={() => void loadInstalled()} />
		</div>
	{/if}
	{#if loading && !installedFile}
		<div class="space-y-1 px-1.5 py-1" aria-hidden="true">
			{#each [1, 2] as item (item)}
				<div class="flex h-9 items-center gap-2">
					<div class="h-7 w-7 animate-pulse rounded-[8px] bg-bg-elevated"></div>
					<div class="h-2.5 w-1/2 animate-pulse rounded bg-bg-elevated"></div>
				</div>
			{/each}
		</div>
	{:else if installedFile && installed.length === 0}
		<p class="px-1.5 py-1.5 text-[12px] leading-[18px] text-text-tertiary">{m.apps_panel_installed_empty({}, { locale })}</p>
	{:else}
		<div role="list">
			{#each installed as app (app.id)}
				<SidePanelRow
					title={app.snapshot.name}
					subtitle={app.ref}
					disabled={!app.enabled}
					drag={draggable || touchDraggable
						? {
								resource: { type: "app", ref: app.ref, title: app.snapshot.name, href: app.url, appId: app.id, ...(app.snapshot.icon ? { icon: app.snapshot.icon } : {}) },
								item: { type: "app", path: "", name: app.snapshot.name, appId: app.id, appRef: app.ref, appUrl: app.url, icon: app.snapshot.icon ?? undefined },
								touch: touchDraggable,
							}
						: null}
					onOpen={() => onOpenInstalled(app)}
				>
					{#snippet leading()}
						<Avatar src={app.snapshot.icon} seed={app.ref} mark={avatarInitials(app.snapshot.name, "A")} shape="tile" size="sm" />
					{/snippet}
					{#snippet trailing()}
						<ToggleSwitch checked={app.enabled} label={app.enabled ? m.apps_panel_disable({}, { locale }) : m.apps_panel_enable({}, { locale })} disabled={!canWrite || Boolean(mutationId)} onchange={(enabled) => setEnabled(app, enabled)} />
						<SidePanelRowAction icon={Trash2} tone="danger" label={m.apps_panel_uninstall({}, { locale })} itemName={app.snapshot.name} disabled={!canWrite || Boolean(mutationId)} onclick={() => uninstall(app)} />
					{/snippet}
				</SidePanelRow>
			{/each}
		</div>
	{/if}
</SidePanelSection>
