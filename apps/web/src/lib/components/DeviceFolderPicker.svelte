<script lang="ts">
import type { DeviceFolderListing } from "@cohub/protocol/host-bridge";
import { ChevronRight, CornerLeftUp, Folder, Loader2 } from "lucide-svelte";
import { untrack } from "svelte";
import Dialog from "$lib/components/Dialog.svelte";
import { browseDeviceFolder } from "$lib/device-runtime.svelte";
import { getLocale } from "$lib/i18n/locale.svelte";
import { m } from "$lib/paraglide/messages.js";

const {
	open,
	onClose,
	onSelect,
}: {
	open: boolean;
	onClose: () => void;
	onSelect: (folder: DeviceFolderListing) => void;
} = $props();

const locale = $derived(getLocale());
let listing = $state<DeviceFolderListing | null>(null);
let loading = $state(false);
let failure = $state<string | null>(null);
let request = 0;

async function load(path?: string) {
	const current = ++request;
	loading = true;
	failure = null;
	try {
		const next = await browseDeviceFolder(path);
		if (current !== request) return;
		if (next) listing = next;
		else failure = m.runtime_device_access_required({}, { locale });
	} catch {
		if (current !== request) return;
		if (path) return void load();
		failure = m.runtime_device_failed({}, { locale });
	} finally {
		if (current === request) loading = false;
	}
}

$effect(() => {
	if (open) untrack(() => void load(listing?.path));
});

const activeVolume = $derived(
	listing?.volumes.find(
		(volume) =>
			listing?.path === volume.path ||
			listing?.path.startsWith(`${volume.path}/`),
	)?.path,
);
</script>

<Dialog {open} {onClose} title={m.runtime_device_choose_folder({}, { locale })} maxWidth="440px">
	<div class="folder-picker">
		{#if listing && listing.volumes.length > 1}
			<div class="volumes" role="tablist">
				{#each listing.volumes as volume (volume.path)}
					<button type="button" role="tab" aria-selected={activeVolume === volume.path} class="volume" onclick={() => void load(volume.path)}>{volume.label}</button>
				{/each}
			</div>
		{/if}
		{#if listing}
			<div class="current">
				<span class="current-label">{listing.label}</span>
				{#if listing.spaceId}<span class="linked">{m.runtime_folder_linked({}, { locale })}</span>{/if}
				{#if loading}<Loader2 class="h-3.5 w-3.5 shrink-0 animate-spin text-text-tertiary motion-reduce:animate-none" aria-hidden="true" />{/if}
			</div>
		{/if}
		{#if failure}
			<div class="failure">
				<p>{failure}</p>
				<button type="button" class="retry" onclick={() => void load(listing?.path)}>{m.runtime_refresh({}, { locale })}</button>
			</div>
		{:else if listing}
			<ul class="folders" aria-busy={loading}>
				{#if listing.parent}
					{@const parent = listing.parent}
					<li><button type="button" class="folder" onclick={() => void load(parent)}><CornerLeftUp class="h-4 w-4 shrink-0" aria-hidden="true" /><span class="name">{m.runtime_folder_parent({}, { locale })}</span></button></li>
				{/if}
				{#each listing.folders as folder (folder.path)}
					<li><button type="button" class="folder" onclick={() => void load(folder.path)}><Folder class="h-4 w-4 shrink-0" aria-hidden="true" /><span class="name">{folder.name}</span><ChevronRight class="h-4 w-4 shrink-0 text-text-placeholder" aria-hidden="true" /></button></li>
				{:else}
					<li class="empty">{m.runtime_folder_empty({}, { locale })}</li>
				{/each}
			</ul>
		{:else}
			<div class="loading"><Loader2 class="h-4 w-4 animate-spin motion-reduce:animate-none" aria-hidden="true" /></div>
		{/if}
	</div>
	{#snippet footer()}
		<div class="footer">
			<button type="button" class="use" disabled={!listing || loading || !!failure} onclick={() => listing && onSelect(listing)}>{m.runtime_folder_use({}, { locale })}</button>
		</div>
	{/snippet}
</Dialog>

<style>
.folder-picker { display: flex; flex-direction: column; min-height: 240px; }
.volumes { display: flex; gap: 4px; padding: 8px 12px 0; overflow-x: auto; }
.volume { flex: 0 0 auto; height: 28px; padding: 0 10px; border-radius: 6px; color: var(--text-tertiary); font-size: 12px; }
.volume[aria-selected="true"] { background: var(--bg-hover); color: var(--text-primary); }
.current { display: flex; align-items: center; gap: 8px; padding: 10px 16px 6px; min-width: 0; }
.current-label { min-width: 0; overflow-wrap: anywhere; color: var(--text-primary); font-size: 13px; font-weight: 500; }
.linked { flex: 0 0 auto; padding: 1px 6px; border-radius: 4px; background: var(--bg-hover); color: var(--text-tertiary); font-size: 11px; }
.folders { margin: 0; padding: 0 8px 8px; list-style: none; }
.folders[aria-busy="true"] { opacity: .6; }
.folder { display: flex; width: 100%; min-height: 40px; align-items: center; gap: 10px; padding: 0 8px; border-radius: 6px; color: var(--text-secondary); font-size: 13px; text-align: left; }
.folder:hover { background: var(--bg-hover); color: var(--text-primary); }
.name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.empty { padding: 12px 8px; color: var(--text-placeholder); font-size: 13px; }
.loading { display: flex; flex: 1; align-items: center; justify-content: center; color: var(--text-tertiary); }
.failure { display: grid; gap: 10px; padding: 16px; color: var(--text-secondary); font-size: 13px; line-height: 1.6; }
.failure p { margin: 0; }
.retry { justify-self: start; height: 32px; padding: 0 12px; border-radius: 6px; box-shadow: inset 0 0 0 1px var(--border-subtle); color: var(--text-secondary); font-size: 12px; }
.footer { display: flex; justify-content: flex-end; padding: 10px 12px; border-top: 1px solid var(--border-subtle); }
.use { min-height: 36px; padding: 0 14px; border-radius: 6px; background: var(--brand); color: var(--brand-contrast-fg); font-size: 13px; font-weight: 500; }
.use:hover { background: var(--brand-hover); }
.use:disabled { opacity: .5; cursor: default; }
.volume:focus-visible, .folder:focus-visible, .retry:focus-visible, .use:focus-visible { outline: 2px solid var(--brand); outline-offset: 2px; }
@media (max-width: 640px) {
	.folder, .use { min-height: 44px; }
	.use { width: 100%; }
}
</style>
