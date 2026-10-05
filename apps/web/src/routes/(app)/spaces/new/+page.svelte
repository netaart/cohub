<script lang="ts">
import {
	getDefaultSpaceModsForEnv,
	normalizeCohubRuntimeEnv,
} from "@cohub/protocol";
import type { DeviceFolderListing } from "@cohub/protocol/host-bridge";
import {
	type Channel,
	type ChannelConfig,
	type CreateSpaceModInput,
	type DiscordChannelConfig,
	HttpError,
	type SpaceChannelBindingInput,
	type SpaceEnvInput,
} from "@neta-art/cohub";
import { ArrowLeft, Loader2, PackagePlus, Plus } from "lucide-svelte";
import { onMount } from "svelte";
import { goto } from "$app/navigation";
import { page } from "$app/state";
import { PUBLIC_COHUB_ENV } from "$env/static/public";
import { ensureAuth } from "$lib/auth";
import CenteredLoading from "$lib/components/CenteredLoading.svelte";
import ChannelModelPicker from "$lib/components/ChannelModelPicker.svelte";
import DeviceFolderPicker from "$lib/components/DeviceFolderPicker.svelte";
import {
	deviceFolderName,
	deviceRuntimeInstances,
	deviceRuntimeSupported,
	isDeviceRuntimeRunning,
	startDeviceRuntime,
} from "$lib/device-runtime.svelte";
import { getLocale } from "$lib/i18n/locale.svelte";
import { isComposingKeyboardEvent } from "$lib/keyboard";
import { m } from "$lib/paraglide/messages.js";
import { sdk } from "$lib/sdk";
import { buildSpaceLandingRoute } from "$lib/space-routes";
import { billingConversion } from "$lib/stores/billing-conversion.svelte";

const locale = $derived(getLocale());

import { cacheSpaceRecordSoon } from "$lib/stores/space-record-cache";

const currentPath = $derived(page.url.pathname);
const currentSearch = $derived(page.url.search);

let channels = $state<Channel[]>([]);
let isLoading = $state(true);
let isSubmitting = $state(false);
let loadError = $state("");
let submitError = $state("");

let name = $state("");
let slug = $state("");
let description = $state("");
let selectedChannelIds = $state<string[]>([]);
let extraEnv = $state<SpaceEnvInput[]>([]);
let channelConfigById = $state<Record<string, ChannelConfig>>({});
const initialCheckpointId =
	page.url.searchParams.get("checkpointId")?.trim() ?? "";
let selectedBootstrapType = $state<"blank" | "git_repo" | "checkpoint">(
	initialCheckpointId ? "checkpoint" : "blank",
);
let deviceSupported = $state(false);
let placement = $state<"cloud" | "device">("cloud");
let folder = $state<DeviceFolderListing | null>(null);
let pickingFolder = $state(false);
const linkedSpaceId = $derived(folder?.spaceId ?? null);
const linkedRunning = $derived(
	isDeviceRuntimeRunning(
		deviceRuntimeInstances()?.find((item) => item.spaceId === linkedSpaceId),
	),
);
const deviceReady = $derived(
	placement === "cloud" || (folder !== null && !linkedRunning),
);

function selectFolder(next: DeviceFolderListing) {
	pickingFolder = false;
	folder = next;
	if (!name.trim()) name = deviceFolderName(next);
}

async function openLinkedSpace() {
	if (!folder?.spaceId) return;
	if (!linkedRunning)
		await startDeviceRuntime(folder.spaceId, folder.path).catch(() => null);
	await goto(buildSpaceLandingRoute(folder.spaceId));
}
let gitRepoUrl = $state("");
let gitRepoRef = $state("");
let gitToken = $state("");
let checkpointId = $state(initialCheckpointId);
let mods = $state<CreateSpaceModInput[]>(
	getDefaultSpaceModsForEnv(normalizeCohubRuntimeEnv(PUBLIC_COHUB_ENV)),
);
let modSpaceId = $state("");
let modName = $state("");
let modMountSlug = $state("");
let modError = $state("");

const getDefaultChannelConfig = (channel: Channel): ChannelConfig => {
	if (channel.provider === "discord") {
		return {
			inbound: { requireMentionInGuild: false },
			outbound: { showThinking: true, showToolCalls: true },
		};
	}
	return {};
};

async function loadPage() {
	if (!(await ensureAuth({ redirectPath: `${currentPath}${currentSearch}` })))
		return;
	isLoading = true;
	loadError = "";

	try {
		const [channelsData, supported] = await Promise.all([
			sdk.channels.list(),
			deviceRuntimeSupported(),
		]);
		deviceSupported = supported;
		channels = channelsData;
		channelConfigById = Object.fromEntries(
			channelsData.map((ch) => [ch.id, getDefaultChannelConfig(ch)]),
		);
	} catch (error) {
		loadError =
			error instanceof Error ? error.message : "Failed to load form data";
	} finally {
		isLoading = false;
	}
}

onMount(() => {
	void loadPage();
});

function toggleChannel(channelId: string, checked: boolean) {
	if (checked) {
		if (!selectedChannelIds.includes(channelId)) {
			selectedChannelIds = [...selectedChannelIds, channelId];
		}
		return;
	}
	selectedChannelIds = selectedChannelIds.filter((id) => id !== channelId);
}

function addEnvRow() {
	extraEnv = [...extraEnv, { name: "", value: "" }];
}

function removeEnvRow(index: number) {
	extraEnv = extraEnv.filter((_, idx) => idx !== index);
}

function updateEnvName(index: number, value: string) {
	extraEnv = extraEnv.map((item, idx) =>
		idx === index ? { ...item, name: value } : item,
	);
}

function updateEnvValue(index: number, value: string) {
	extraEnv = extraEnv.map((item, idx) =>
		idx === index ? { ...item, value: value } : item,
	);
}

function setChannelModel(
	channelId: string,
	model: { provider: string; id: string } | null,
) {
	channelConfigById = {
		...channelConfigById,
		[channelId]: {
			...(channelConfigById[channelId] ?? {}),
			model,
		},
	};
}

function updateDiscordConfig(
	channelId: string,
	updater: (config: DiscordChannelConfig) => DiscordChannelConfig,
) {
	channelConfigById = {
		...channelConfigById,
		[channelId]: updater(
			(channelConfigById[channelId] ?? {}) as DiscordChannelConfig,
		),
	};
}

function getModDisplayName(mod: CreateSpaceModInput): string {
	return mod.name?.trim() || mod.modSpaceId;
}

function getModMountPath(mod: CreateSpaceModInput): string {
	const slug = mod.mountSlug?.trim();
	return slug ? `/mods/${slug}` : "/mods/<auto>";
}

function addMod() {
	const target = modSpaceId.trim();
	if (!target) return;
	modError = "";
	if (mods.some((mod) => mod.modSpaceId === target)) {
		modError = "Mod space is already mounted";
		return;
	}
	mods = [
		...mods,
		{
			modSpaceId: target,
			name: modName.trim() || null,
			mountSlug: modMountSlug.trim() || null,
			enabled: true,
		},
	];
	modSpaceId = "";
	modName = "";
	modMountSlug = "";
}

function toggleMod(modSpaceId: string) {
	mods = mods.map((mod) =>
		mod.modSpaceId === modSpaceId
			? { ...mod, enabled: !(mod.enabled ?? true) }
			: mod,
	);
}

function updateModMountSlug(modSpaceId: string, mountSlug: string) {
	mods = mods.map((mod) =>
		mod.modSpaceId === modSpaceId
			? { ...mod, mountSlug: mountSlug.trim() || null }
			: mod,
	);
}

function removeMod(modSpaceId: string) {
	mods = mods.filter((mod) => mod.modSpaceId !== modSpaceId);
}

async function handleSubmit(event: SubmitEvent) {
	event.preventDefault();
	if (!name.trim() || isSubmitting || !deviceReady) return;

	submitError = "";
	isSubmitting = true;

	try {
		const channelBindings: SpaceChannelBindingInput[] = selectedChannelIds.map(
			(channelId) => ({
				channelId,
				config: channelConfigById[channelId] ?? null,
			}),
		);
		const normalizedExtraEnv: SpaceEnvInput[] = extraEnv
			.map((item) => ({ name: item.name.trim(), value: item.value }))
			.filter((item) => item.name.length > 0);

		const onDevice = placement === "device";
		const bootstrapSource =
			selectedBootstrapType === "git_repo"
				? {
						type: "git_repo" as const,
						repoUrl: gitRepoUrl.trim(),
						ref: gitRepoRef.trim() || null,
					}
				: selectedBootstrapType === "checkpoint"
					? {
							type: "checkpoint" as const,
							checkpointId: checkpointId.trim(),
						}
					: { type: "blank" as const };

		const result = await sdk.spaces.create(
			{
				name: name.trim(),
				slug: slug.trim() || null,
				description: description.trim() || undefined,
				source: "web",
				extraEnv: normalizedExtraEnv,
				channelBindings,
				mods,
				...(onDevice
					? { config: { sandbox: { provider: "local" as const } } }
					: { bootstrapSource }),
			},
			gitToken.trim() && !onDevice
				? { "X-Git-Token": gitToken.trim() }
				: undefined,
		);

		if (onDevice && folder)
			await startDeviceRuntime(result.space.id, folder.path).catch(() => null);

		cacheSpaceRecordSoon(result.space);
		window.dispatchEvent(new CustomEvent("cohub:space-created"));

		await goto(buildSpaceLandingRoute(result.space.id));
	} catch (error) {
		if (billingConversion.handleHttpError(error)) return;
		if (error instanceof HttpError) {
			submitError = error.message;
		} else {
			submitError =
				error instanceof Error ? error.message : "Failed to create space";
		}
	} finally {
		isSubmitting = false;
	}
}
</script>

{#if deviceSupported}
  <DeviceFolderPicker open={pickingFolder} onClose={() => (pickingFolder = false)} onSelect={selectFolder} />
{/if}

<svelte:head>
	<title>New space — Cohub</title>
</svelte:head>

<div class="flex-1 flex flex-col min-h-0 overflow-y-auto">
  <div class="h-[40px] flex items-center px-4 border-b border-border-subtle shrink-0 bg-bg-primary">
    <div class="flex items-center gap-3 min-w-0">
      <a href="/" class="text-text-tertiary hover:text-text-primary transition-colors shrink-0" onclick={(e) => { e.preventDefault(); goto("/"); }}>
        <ArrowLeft class="w-4 h-4" />
      </a>
      <div class="w-[1px] h-4 bg-border-subtle shrink-0"></div>
      <span class="text-[11px] font-medium text-text-secondary">{m.space_new_title({}, { locale })}</span>
    </div>
  </div>

  <div class="flex-1 p-4 overflow-y-auto max-w-2xl">
    {#if isLoading}
      <CenteredLoading label="Loading form…" size="compact" />
    {:else if loadError}
      <div class="rounded-md border border-error-soft/30 bg-error-bg p-3 text-[12px] font-mono text-error-soft break-all">{loadError}</div>
    {:else}
      <form onsubmit={handleSubmit} class="space-y-3">
        <div class="border border-border-subtle rounded-md bg-bg-surface p-4 space-y-3">
          <div>
            <div class="text-[10px] uppercase tracking-wider text-text-placeholder font-medium">Space</div>
            <p class="text-[13px] text-text-tertiary mt-1">Create a new space. Sandbox provisioning and content bootstrap will run independently.</p>
          </div>

          <div>
            <label class="block text-[10px] font-medium uppercase tracking-wider text-text-tertiary mb-1.5" for="space-name">Name</label>
            <input
              id="space-name"
              bind:value={name}
              type="text"
              placeholder="my-product-space"
              class="w-full px-3 py-[6px] rounded-[5px] bg-bg-input border border-border-subtle text-[13px] text-text-primary placeholder:text-text-placeholder focus:border-brand/40 focus:outline-none font-mono transition-colors"
              required
            />
          </div>

          <div>
            <label class="block text-[10px] font-medium uppercase tracking-wider text-text-tertiary mb-1.5" for="space-slug">Slug</label>
            <input
              id="space-slug"
              bind:value={slug}
              type="text"
              placeholder="optional-url-name"
              pattern={String.raw`[a-z0-9](?:[a-z0-9_-]{0,78}[a-z0-9])?`}
              class="w-full px-3 py-[6px] rounded-[5px] bg-bg-input border border-border-subtle text-[13px] text-text-primary placeholder:text-text-placeholder focus:border-brand/40 focus:outline-none font-mono transition-colors"
            />
            <p class="mt-1 text-[11px] text-text-placeholder">Optional. Lowercase letters, numbers, hyphens, or underscores.</p>
          </div>

          <div>
            <label class="block text-[10px] font-medium uppercase tracking-wider text-text-tertiary mb-1.5" for="space-description">Description</label>
            <textarea
              id="space-description"
              bind:value={description}
              rows="3"
              placeholder="Optional description"
              class="w-full px-3 py-[8px] rounded-[5px] bg-bg-input border border-border-subtle text-[13px] text-text-primary placeholder:text-text-placeholder focus:border-brand/40 focus:outline-none transition-colors resize-y"
            ></textarea>
          </div>
          {#if deviceSupported}
            <div>
              <div class="text-[10px] uppercase tracking-wider text-text-tertiary font-medium mb-1.5">{m.space_new_location({}, { locale })}</div>
              <div class="grid gap-2 grid-cols-2">
                <label class="flex items-center gap-2 rounded-[5px] border border-border-subtle bg-bg-input px-3 py-2 text-[12px] text-text-secondary">
                  <input type="radio" bind:group={placement} value="cloud" />
                  <span>{m.space_new_location_cloud({}, { locale })}</span>
                </label>
                <label class="flex items-center gap-2 rounded-[5px] border border-border-subtle bg-bg-input px-3 py-2 text-[12px] text-text-secondary">
                  <input type="radio" bind:group={placement} value="device" />
                  <span>{m.runtime_this_device({}, { locale })}</span>
                </label>
              </div>
              {#if placement === "device"}
                <p class="mt-1 text-[11px] text-text-placeholder">{m.space_new_location_device_hint({}, { locale })}</p>
              {/if}
            </div>
            {#if placement === "device"}
              <div>
                <div class="text-[10px] uppercase tracking-wider text-text-tertiary font-medium mb-1.5">{m.space_new_folder({}, { locale })}</div>
                <button type="button" class="flex w-full min-h-9 items-center justify-between gap-3 rounded-[5px] border border-border-subtle bg-bg-input px-3 py-2 text-left text-[13px] text-text-primary hover:border-border-primary transition-colors" onclick={() => (pickingFolder = true)}>
                  <span class="min-w-0 break-all font-mono">{folder?.label ?? m.runtime_device_choose_folder({}, { locale })}</span>
                  {#if folder}<span class="shrink-0 text-[12px] text-text-tertiary">{m.runtime_device_change_folder({}, { locale })}</span>{/if}
                </button>
                {#if linkedSpaceId}
                  <div class="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px]">
                    <span class={linkedRunning ? "text-error-soft" : "text-text-placeholder"}>{linkedRunning ? m.runtime_device_folder_in_use({}, { locale }) : m.space_new_folder_linked({}, { locale })}</span>
                    <button type="button" class="text-brand hover:underline" onclick={() => void openLinkedSpace()}>{m.space_new_open_linked({}, { locale })}</button>
                  </div>
                {/if}
              </div>
            {/if}
          {/if}
          {#if placement === "cloud"}
          <div class="space-y-2">
            <div>
              <div class="text-[10px] uppercase tracking-wider text-text-tertiary font-medium mb-1.5">Bootstrap Source</div>
              <div class="grid gap-2 sm:grid-cols-3">
                <label class="flex items-center gap-2 rounded-[5px] border border-border-subtle bg-bg-input px-3 py-2 text-[12px] text-text-secondary">
                  <input type="radio" bind:group={selectedBootstrapType} value="blank" />
                  <span>Blank</span>
                </label>
                <label class="flex items-center gap-2 rounded-[5px] border border-border-subtle bg-bg-input px-3 py-2 text-[12px] text-text-secondary">
                  <input type="radio" bind:group={selectedBootstrapType} value="git_repo" />
                  <span>{m.space_new_git_repo({}, { locale })}</span>
                </label>
                <label class="flex items-center gap-2 rounded-[5px] border border-border-subtle bg-bg-input px-3 py-2 text-[12px] text-text-secondary">
                  <input type="radio" bind:group={selectedBootstrapType} value="checkpoint" />
                  <span>Save</span>
                </label>
              </div>
            </div>

            {#if selectedBootstrapType === "git_repo"}
              <div class="space-y-2">
                <input
                  bind:value={gitRepoUrl}
                  type="url"
                  placeholder="https://github.com/org/repo.git"
                  class="w-full px-3 py-[6px] rounded-[5px] bg-bg-input border border-border-subtle text-[13px] text-text-primary placeholder:text-text-placeholder focus:border-brand/40 focus:outline-none font-mono transition-colors"
                  required
                />
                <input
                  bind:value={gitRepoRef}
                  type="text"
                  placeholder="Optional ref (branch / tag / commit)"
                  class="w-full px-3 py-[6px] rounded-[5px] bg-bg-input border border-border-subtle text-[13px] text-text-primary placeholder:text-text-placeholder focus:border-brand/40 focus:outline-none font-mono transition-colors"
                />
                <input
                  bind:value={gitToken}
                  type="password"
                  placeholder="Optional access token for private repos (not stored)"
                  class="w-full px-3 py-[6px] rounded-[5px] bg-bg-input border border-border-subtle text-[13px] text-text-primary placeholder:text-text-placeholder focus:border-brand/40 focus:outline-none font-mono transition-colors"
                />
              </div>
            {:else if selectedBootstrapType === "checkpoint"}
              <div class="space-y-1.5">
                <input
                  bind:value={checkpointId}
                  type="text"
                  placeholder="Save UUID"
                  class="w-full px-3 py-[6px] rounded-[5px] bg-bg-input border border-border-subtle text-[13px] text-text-primary placeholder:text-text-placeholder focus:border-brand/40 focus:outline-none font-mono transition-colors"
                  required
                />
                <p class="text-[11px] text-text-placeholder">Create an independent Space from this Save.</p>
              </div>
            {/if}
          </div>
          {/if}
        </div>

        <div class="border border-border-subtle rounded-md bg-bg-surface p-4 space-y-3">
          <div>
            <div class="flex items-center gap-2 text-[10px] uppercase tracking-wider text-text-placeholder font-medium"><PackagePlus class="h-3.5 w-3.5" /> Mounted spaces</div>
            <p class="text-[13px] text-text-tertiary mt-1">{m.space_new_mounted_readonly({ path: "/mods/<slug>" }, { locale })}</p>
          </div>

          <div class="grid gap-2 lg:grid-cols-[1fr_1fr_1fr_auto]">
            <input bind:value={modSpaceId} placeholder="Mod Space UUID" class="min-h-9 min-w-0 rounded-[6px] border border-border-subtle bg-bg-input px-3 py-2 font-mono text-[12px] text-text-primary placeholder:text-text-placeholder focus:border-brand/40 focus:outline-none" />
            <input bind:value={modName} placeholder="Display name" class="min-h-9 min-w-0 rounded-[6px] border border-border-subtle bg-bg-input px-3 py-2 text-[12px] text-text-primary placeholder:text-text-placeholder focus:border-brand/40 focus:outline-none" />
            <input bind:value={modMountSlug} placeholder="Mount slug" class="min-h-9 min-w-0 rounded-[6px] border border-border-subtle bg-bg-input px-3 py-2 font-mono text-[12px] text-text-primary placeholder:text-text-placeholder focus:border-brand/40 focus:outline-none" />
            <button type="button" onclick={addMod} disabled={!modSpaceId.trim()} class="inline-flex min-h-9 items-center justify-center gap-1.5 rounded-[6px] bg-brand px-3 py-2 text-[12px] font-medium text-brand-contrast-fg hover:bg-brand-hover disabled:opacity-50"><Plus class="h-3.5 w-3.5" /> Add</button>
          </div>
          {#if modError}<div class="rounded-[6px] border border-error-soft/30 bg-error-bg px-3 py-2 text-[12px] text-error-soft break-words">{modError}</div>{/if}

          <div class="space-y-1.5">
            {#each mods as mod (mod.modSpaceId)}
              <div class="grid gap-2 rounded-[7px] bg-bg-primary px-3 py-2 md:grid-cols-[1fr_auto]">
                <div class="min-w-0">
                  <div class="truncate text-[12px] font-medium text-text-secondary">{getModDisplayName(mod)}</div>
                  <div class="mt-0.5 break-all font-mono text-[10px] text-text-placeholder">{getModMountPath(mod)} · {mod.modSpaceId}</div>
                  <input value={mod.mountSlug ?? ""} onblur={(event) => { const slug = (event.currentTarget as HTMLInputElement).value.trim(); if (slug !== (mod.mountSlug ?? "")) updateModMountSlug(mod.modSpaceId, slug); }} onkeydown={(event) => { if (event.key === 'Enter' && !isComposingKeyboardEvent(event)) { event.preventDefault(); const slug = (event.currentTarget as HTMLInputElement).value.trim(); if (slug !== (mod.mountSlug ?? "")) updateModMountSlug(mod.modSpaceId, slug); } }} placeholder="Mount slug" class="mt-2 w-full rounded-[5px] border border-border-subtle bg-bg-input px-2 py-1.5 font-mono text-[11px] text-text-primary placeholder:text-text-placeholder focus:border-brand/40 focus:outline-none" />
                </div>
                <div class="flex items-center justify-end gap-2 md:justify-start">
                  <span class="rounded px-1.5 py-0.5 text-[10px] uppercase tracking-wider {(mod.enabled ?? true) ? 'bg-success-bg text-success-soft' : 'bg-bg-hover text-text-placeholder'}">{(mod.enabled ?? true) ? 'enabled' : 'disabled'}</span>
                  <button type="button" onclick={() => toggleMod(mod.modSpaceId)} class="text-[11px] text-text-placeholder hover:text-text-secondary">{(mod.enabled ?? true) ? 'Disable' : 'Enable'}</button>
                  <button type="button" onclick={() => removeMod(mod.modSpaceId)} class="text-[11px] text-text-placeholder hover:text-error-soft">Remove</button>
                </div>
              </div>
            {:else}
              <div class="rounded-[7px] bg-bg-primary px-3 py-2 text-[12px] text-text-tertiary">{m.space_new_no_mounted({}, { locale })}</div>
            {/each}
          </div>
        </div>

        <div class="border border-border-subtle rounded-md bg-bg-surface p-4 space-y-3">
          <div>
            <div class="text-[10px] uppercase tracking-wider text-text-placeholder font-medium">{m.space_new_env_vars({}, { locale })}</div>
            <p class="text-[13px] text-text-tertiary mt-1">Optional env vars injected into the space environment.</p>
          </div>

          {#if extraEnv.length === 0}
            <div class="text-[13px] text-text-placeholder py-1">{m.space_new_no_env({}, { locale })}</div>
          {:else}
            <div class="space-y-2">
              {#each extraEnv as envItem, index}
                <div class="flex flex-col sm:flex-row gap-2">
                  <input
                    type="text"
                    value={envItem.name}
                    placeholder="ENV_NAME"
                    oninput={(event) => updateEnvName(index, (event.currentTarget as HTMLInputElement).value)}
                    class="flex-1 px-3 py-[6px] rounded-[5px] bg-bg-input border border-border-subtle text-[13px] text-text-primary placeholder:text-text-placeholder focus:border-brand/40 focus:outline-none font-mono transition-colors"
                  />
                  <input
                    type="text"
                    value={envItem.value}
                    placeholder="value"
                    oninput={(event) => updateEnvValue(index, (event.currentTarget as HTMLInputElement).value)}
                    class="flex-1 px-3 py-[6px] rounded-[5px] bg-bg-input border border-border-subtle text-[13px] text-text-primary placeholder:text-text-placeholder focus:border-brand/40 focus:outline-none font-mono transition-colors"
                  />
                  <button type="button" class="w-full sm:w-auto px-3 py-[6px] rounded-[5px] bg-bg-input border border-border-subtle text-[12px] text-text-tertiary hover:text-error-soft hover:border-error-soft/20 transition-colors" onclick={() => removeEnvRow(index)}>
                    Remove
                  </button>
                </div>
              {/each}
            </div>
          {/if}

          <button type="button" class="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-[5px] bg-bg-input border border-border-subtle text-[12px] text-text-secondary hover:text-text-primary transition-colors" onclick={addEnvRow}>
            <Plus class="w-3.5 h-3.5" />
            Add env var
          </button>
        </div>

        <div class="border border-border-subtle rounded-md bg-bg-surface p-4 space-y-3">
          <div>
            <div class="text-[10px] uppercase tracking-wider text-text-placeholder font-medium">Channels</div>
            <p class="text-[13px] text-text-tertiary mt-1">Optional channels to bind to this space.</p>
          </div>

          {#if channels.length === 0}
            <div class="text-[13px] text-text-placeholder py-1">{m.space_new_no_channels({}, { locale })}</div>
          {:else}
            <div class="space-y-2">
              {#each channels as channel (channel.id)}
                <div class="block rounded-[6px] border border-border-subtle bg-bg-code p-3 transition-colors hover:border-border-primary">
                  <div class="flex items-start gap-3">
                    <input
                      type="checkbox"
                      checked={selectedChannelIds.includes(channel.id)}
                      onchange={(event) => toggleChannel(channel.id, (event.currentTarget as HTMLInputElement).checked)}
                      class="mt-0.5 rounded-sm bg-bg-input border-border-subtle checked:bg-brand shrink-0"
                    />
                    <div class="min-w-0 flex-1">
                      <div class="flex items-center gap-2 min-w-0">
                        <span class="text-[13px] font-medium text-text-primary truncate">{channel.name}</span>
                        <span class="text-[10px] uppercase tracking-wider text-text-tertiary shrink-0">{channel.provider}</span>
                      </div>

                      {#if selectedChannelIds.includes(channel.id)}
                        <div class="mt-3">
                          <ChannelModelPicker
                            model={channelConfigById[channel.id]?.model ?? null}
                            onSelect={(model) => setChannelModel(channel.id, model)}
                          />
                        </div>
                      {/if}

                      {#if selectedChannelIds.includes(channel.id) && channel.provider === "discord"}
                        {@const config = (channelConfigById[channel.id] ?? {}) as DiscordChannelConfig}
                        <div class="mt-3 grid grid-cols-1 sm:grid-cols-2 gap-3 border-t border-border-subtle pt-3">
                          <label class="flex items-center gap-2 text-[12px] text-text-secondary">
                            <input
                              type="checkbox"
                              checked={config.inbound?.requireMentionInGuild ?? false}
                              onchange={(event) => updateDiscordConfig(channel.id, (current) => ({
                                ...current,
                                inbound: {
                                  ...(current.inbound ?? {}),
                                  requireMentionInGuild: (event.currentTarget as HTMLInputElement).checked,
                                },
                              }))}
                              class="rounded-sm bg-bg-input border-border-subtle checked:bg-brand"
                            />
                            Require mention in guild
                          </label>
                          <label class="flex items-center gap-2 text-[12px] text-text-secondary">
                            <input
                              type="checkbox"
                              checked={config.outbound?.showThinking ?? true}
                              onchange={(event) => updateDiscordConfig(channel.id, (current) => ({
                                ...current,
                                outbound: {
                                  ...(current.outbound ?? {}),
                                  showThinking: (event.currentTarget as HTMLInputElement).checked,
                                },
                              }))}
                              class="rounded-sm bg-bg-input border-border-subtle checked:bg-brand"
                            />
                            Show thinking
                          </label>
                        </div>
                      {/if}
                    </div>
                  </div>
                </div>
              {/each}
            </div>
          {/if}
        </div>

        {#if submitError}
          <div class="rounded-md border border-error-soft/30 bg-error-bg p-3 text-[12px] font-mono text-error-soft break-all">{submitError}</div>
        {/if}

        <div class="flex items-center justify-end gap-2 pt-1">
          <button type="button" class="px-3 py-1.5 rounded-[5px] border border-border-subtle text-[13px] text-text-secondary hover:text-text-primary transition-colors" onclick={() => goto("/")}>{m.common_cancel({}, { locale })}</button>
          <button
            type="submit"
            class="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-[5px] bg-brand-muted border border-brand-border text-[13px] text-brand font-medium hover:bg-brand-muted-hover transition-colors disabled:opacity-60"
            disabled={isSubmitting || !name.trim() || !deviceReady}
          >
            {#if isSubmitting}
              <Loader2 class="w-3.5 h-3.5 animate-spin" />
              {m.space_new_creating({}, { locale })}
            {:else}
              {m.space_new_create({}, { locale })}
            {/if}
          </button>
        </div>
      </form>
    {/if}
  </div>
</div>
