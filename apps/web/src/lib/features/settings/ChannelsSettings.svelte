<script lang="ts">
import type { Channel } from "@neta-art/cohub";
import {
	MessageCircle,
	MessageSquare,
	MonitorPlay,
	Plus,
	Trash2,
	Webhook,
} from "lucide-svelte";
import { page } from "$app/state";
import { ensureAuth } from "$lib/auth";
import {
	channelHealthClass,
	channelHealthDetail,
	channelHealthLabel,
	channelHealthMessage,
} from "$lib/channel-health";
import * as account from "$lib/features/settings/account-data";
import {
	onSettingsPageActive,
	settingsPageActive,
} from "$lib/features/settings/page-context.svelte";
import { getLocale } from "$lib/i18n/locale.svelte";
import { m } from "$lib/paraglide/messages.js";
import { sdk } from "$lib/sdk";
import { buildSpaceLandingRoute } from "$lib/space-routes";

const REFRESH_MS = 15_000;

const active = settingsPageActive();
const locale = $derived(getLocale());
const newChannelHref = $derived.by(() => {
	const target = new URL("/settings/channels/new", page.url);
	const from = page.url.searchParams.get("from");
	if (from) target.searchParams.set("from", from);
	return target.pathname + target.search;
});

const channels = $derived(account.channels.data ?? []);
const loadError = $derived(
	account.channels.data
		? ""
		: account.channels.errorMessage(m.channels_load_failed({}, { locale })),
);

const providerIcons: Record<string, typeof MessageSquare> = {
	discord: MessageSquare,
	feishu: Webhook,
	wechat: MessageCircle,
	web: MonitorPlay,
};

const providerDotColor: Record<string, string> = {
	discord: "bg-provider-discord",
	feishu: "bg-provider-feishu",
	wechat: "bg-provider-wechat",
	web: "bg-status-running",
};

async function refresh(options?: { force?: boolean }) {
	if (await ensureAuth()) await account.channels.load(options);
}

onSettingsPageActive(() => void refresh());

$effect(() => {
	if (!active()) return;
	const timer = setInterval(() => void refresh({ force: true }), REFRESH_MS);
	return () => clearInterval(timer);
});

async function handleDelete(channel: Channel) {
	if (channel.boundSpace) {
		alert(m.channels_unbind_alert({}, { locale }));
		return;
	}
	if (!confirm(m.channels_delete_confirm({}, { locale }))) return;
	try {
		await sdk.channels.delete(channel.id);
		await account.channels.load({ force: true });
	} catch (error) {
		alert(
			error instanceof Error
				? error.message
				: m.channels_delete_failed({}, { locale }),
		);
	}
}
</script>

<div class="flex-1 px-4 py-5 sm:p-6">
  <section class="max-w-2xl">
    <div class="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
      <div class="min-w-0">
        <h1 class="text-[18px] font-semibold text-text-primary tracking-tight">{m.page_title_channels({}, { locale })}</h1>
        <p class="mt-1 text-[13px] text-text-tertiary">
          {m.channels_description({}, { locale })}
        </p>
      </div>
      <a
        href={newChannelHref}
        class="inline-flex min-h-10 items-center justify-center gap-1.5 rounded-[5px] border border-brand-border bg-brand-muted px-3 py-2 text-[12px] font-medium text-brand transition-colors hover:bg-brand-muted-hover focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand/50 sm:min-h-8 sm:px-2.5 sm:py-1.5"
      >
        <Plus class="w-3.5 h-3.5" />
        {m.channels_add({}, { locale })}
      </a>
    </div>

    {#if account.channels.loading}
      <div class="mt-5 space-y-2 sm:mt-6" aria-hidden="true">
        <div class="h-14 rounded-md bg-bg-hover-strong"></div>
        <div class="h-14 rounded-md bg-bg-hover-strong"></div>
        <div class="h-14 rounded-md bg-bg-hover-strong"></div>
      </div>
    {:else if loadError}
      <div class="mt-6 rounded-md border border-error-soft/30 bg-error-bg p-3 text-[12px] font-mono text-error-soft break-all">{loadError}</div>
    {:else if channels.length === 0}
      <div class="flex flex-col items-center justify-center py-14 text-center sm:py-16">
        <div class="w-11 h-11 rounded-md bg-bg-surface border border-border-subtle flex items-center justify-center mb-3">
          <Webhook class="w-5 h-5 text-text-placeholder" />
        </div>
        <p class="text-[14px] text-text-tertiary">{m.channels_no_channels({}, { locale })}</p>
        <p class="text-[12px] text-text-placeholder mt-1">{m.channels_empty_hint({}, { locale })}</p>
      </div>
    {:else}
      <div class="mt-5 overflow-hidden rounded-md border border-border-subtle sm:mt-6 max-lg:border-0 max-lg:overflow-visible">
        <div class="hidden lg:grid lg:grid-cols-[auto_1fr_auto_1fr_auto] lg:gap-3 lg:px-3 lg:py-2 bg-bg-header-alt text-[10px] font-medium uppercase tracking-[0.08em] text-text-placeholder border-b border-border-subtle">
          <span></span>
          <span>{m.channels_col_channel({}, { locale })}</span>
          <span>{m.channels_col_status({}, { locale })}</span>
          <span>{m.channels_col_bound_space({}, { locale })}</span>
          <span></span>
        </div>
        <div class="space-y-2 lg:space-y-0 lg:divide-y lg:divide-border-subtle">
        {#each channels as channel (channel.id)}
          {@const Icon = providerIcons[channel.provider] || Webhook}
          {@const dotColor = providerDotColor[channel.provider] || providerDotColor.web}
          <div class="rounded-md border border-border-subtle bg-bg-surface transition-colors duration-100 hover:bg-bg-hover lg:rounded-none lg:border-0 lg:bg-transparent">
            <div class="hidden lg:grid lg:grid-cols-[auto_1fr_auto_1fr_auto] lg:gap-3 lg:px-3 lg:py-2.5">
              <div class="w-7 h-7 rounded-[5px] bg-bg-surface border border-border-subtle flex items-center justify-center shrink-0 mt-0.5">
                <div class="w-2 h-2 rounded-full {dotColor} mr-0.5"></div>
                <Icon class="w-3.5 h-3.5 text-text-tertiary" />
              </div>
              <div class="min-w-0">
                <div class="text-[13px] font-medium text-text-primary truncate">{channel.name}</div>
                <div class="text-[10px] uppercase tracking-wider text-text-tertiary">{channel.provider}</div>
              </div>
              <div class="flex min-w-0 flex-col justify-center gap-1 pt-0.5">
                <span class={`inline-flex w-fit items-center rounded-full px-1.5 py-0.5 text-[10px] font-medium ring-1 ${channelHealthClass(channel.health?.state ?? (channel.boundSpace ? "connecting" : null))}`}>
                  {channelHealthLabel(channel.health, { bound: Boolean(channel.boundSpace) }, locale)}
                </span>
                {#if channelHealthMessage(channel.health)}
                  <span class="truncate text-[11px] text-error-soft" title={channelHealthDetail(channel.health) ?? channelHealthMessage(channel.health) ?? undefined}>
                    {channelHealthMessage(channel.health)}
                  </span>
                {/if}
              </div>
              <div class="flex items-center gap-1.5 pt-0.5 min-w-0">
                {#if channel.boundSpace}
                  <a href={buildSpaceLandingRoute(channel.boundSpace.id)} class="text-[12px] text-text-secondary hover:text-text-primary truncate font-mono transition-colors">
                    {channel.boundSpace.title || channel.boundSpace.id.slice(0, 8)}
                  </a>
                {:else}
                  <span class="text-[12px] text-text-placeholder">{m.channels_not_bound({}, { locale })}</span>
                {/if}
              </div>
              <div class="flex items-center justify-end pt-0.5 shrink-0">
                <button
                  onclick={() => handleDelete(channel)}
                  disabled={Boolean(channel.boundSpace)}
                  class="p-2 rounded-[4px] text-text-tertiary hover:text-error-soft hover:bg-error-bg transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand/50 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-text-tertiary"
                  title={channel.boundSpace ? m.channels_unbind_title({}, { locale }) : m.channels_delete_title({}, { locale })}
                >
                  <Trash2 class="w-4 h-4" />
                </button>
              </div>
            </div>

            <div class="lg:hidden p-3.5">
              <div class="flex items-start gap-3">
                <div class="flex h-10 w-10 shrink-0 items-center justify-center rounded-[6px] border border-border-subtle bg-bg-primary">
                  <div class="mr-0.5 h-2 w-2 rounded-full {dotColor}"></div>
                  <Icon class="h-4 w-4 text-text-tertiary" />
                </div>
                <div class="min-w-0 flex-1">
                  <div class="flex min-w-0 items-start justify-between gap-3">
                    <div class="min-w-0">
                      <div class="truncate text-[14px] font-medium text-text-primary">{channel.name}</div>
                      <div class="mt-0.5 text-[10px] uppercase tracking-wider text-text-tertiary">{channel.provider}</div>
                    </div>
                    <button
                      onclick={() => handleDelete(channel)}
                      disabled={Boolean(channel.boundSpace)}
                      class="flex h-10 w-10 shrink-0 items-center justify-center rounded-[5px] text-text-tertiary transition-colors hover:bg-error-bg hover:text-error-soft focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand/50 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-text-tertiary"
                      title={channel.boundSpace ? m.channels_unbind_title({}, { locale }) : m.channels_delete_title({}, { locale })}
                      aria-label={channel.boundSpace ? m.channels_unbind_title({}, { locale }) : m.channels_delete_title({}, { locale })}
                    >
                      <Trash2 class="h-4 w-4" />
                    </button>
                  </div>
                  <div class="mt-3 flex min-w-0 flex-col gap-1.5">
                    <div class="flex flex-wrap items-center gap-2">
                      <span class={`inline-flex items-center rounded-full px-1.5 py-0.5 text-[11px] font-medium ring-1 ${channelHealthClass(channel.health?.state ?? (channel.boundSpace ? "connecting" : null))}`}>
                        {channelHealthLabel(channel.health, { bound: Boolean(channel.boundSpace) }, locale)}
                      </span>
                      {#if channel.boundSpace}
                        <a href={buildSpaceLandingRoute(channel.boundSpace.id)} class="min-w-0 max-w-full truncate text-[12px] font-mono text-text-secondary transition-colors hover:text-text-primary">
                          {channel.boundSpace.title || channel.boundSpace.id.slice(0, 8)}
                        </a>
                      {:else}
                        <span class="text-[12px] text-text-placeholder">{m.channels_not_bound({}, { locale })}</span>
                      {/if}
                    </div>
                    {#if channelHealthMessage(channel.health)}
                      <p class="text-[12px] leading-4 text-error-soft break-words" title={channelHealthDetail(channel.health) ?? undefined}>
                        {channelHealthMessage(channel.health)}
                      </p>
                    {/if}
                  </div>
                </div>
              </div>
            </div>
          </div>
        {/each}
        </div>
      </div>
    {/if}
  </section>
</div>
