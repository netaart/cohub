<script lang="ts">
import { SPACE_WALLET_UPDATED_EVENT } from "@cohub/protocol";
import type { SpaceWalletActivity } from "@neta-art/cohub";
import { ArrowLeft, Check, Link, Loader2, RefreshCw } from "lucide-svelte";
import { onMount, untrack } from "svelte";
import { inScrollView } from "$lib/actions/in-scroll-view";
import { userProfilesRepo } from "$lib/cache/repositories/user-profiles-repo";
import ToggleSwitch from "$lib/components/ToggleSwitch.svelte";
import UserIdentity from "$lib/components/UserIdentity.svelte";
import { subscribeSpaceChannel } from "$lib/features/session-chat/space-channel";
import { AccountResource } from "$lib/features/settings/account-resource.svelte";
import { formatCurrency, formatDateTime } from "$lib/i18n/format";
import { getLocale } from "$lib/i18n/locale.svelte";
import { m } from "$lib/paraglide/messages.js";
import { sdk } from "$lib/sdk";
import { buildSpaceRootRoute } from "$lib/space-routes";
import { cacheSpaceRecordSoon } from "$lib/stores/space-record-cache";
import { ActivityFeed } from "./activity-feed.svelte";
import { formatBalance } from "./format";
import SpaceFundPanel from "./SpaceFundPanel.svelte";
import { fundLink } from "./space-fund";

const { spaceId }: { spaceId: string } = $props();
const locale = $derived(getLocale());
const api = untrack(() => sdk.space(spaceId).wallet);
const balance = untrack(
	() => new AccountResource(`space-wallet:${spaceId}`, () => api.get()),
);
const activity = untrack(
	() =>
		new ActivityFeed<SpaceWalletActivity>(
			`space-wallet-activity:${spaceId}`,
			(cursor) => api.activities(cursor),
		),
);
const space = untrack(
	() =>
		new AccountResource(`space-wallet-space:${spaceId}`, () =>
			sdk.space(spaceId).get(),
		),
);
let nearEnd = $state(false);
let profilesVersion = $state(0);
let savingFunding = $state(false);
let fundingError = $state(false);
let copied = $state(false);
const canEdit = $derived(
	space.data?.access?.permissions.includes("space.edit") === true,
);
const publicFunding = $derived(
	space.data?.publicProfile?.fundingEnabled === true,
);
const money = (amount: number, maximumFractionDigits = 2) =>
	formatCurrency(amount, "USD", { locale, maximumFractionDigits });
const kinds = $derived({
	grant: m.wallet_activity_recharge({}, { locale }),
	usage: m.wallet_activity_usage({}, { locale }),
	reversal: m.wallet_activity_reversal({}, { locale }),
	refund: m.wallet_activity_refund({}, { locale }),
	expire: m.billing_expired({}, { locale }),
	revoke: m.wallet_activity_revoke({}, { locale }),
	adjust: m.wallet_activity_adjust({}, { locale }),
});

function actor(userUuid: string) {
	void profilesVersion;
	return userProfilesRepo.getSync(userUuid);
}

function refresh() {
	if (!balance.refreshing) void balance.load({ force: true });
	void activity.refresh();
}

async function setPublicFunding(enabled: boolean) {
	if (savingFunding) return;
	savingFunding = true;
	fundingError = false;
	try {
		const { space: next } = await sdk
			.space(spaceId)
			.profile({ fundingEnabled: enabled });
		space.update(() => next);
		cacheSpaceRecordSoon(next);
	} catch {
		fundingError = true;
	} finally {
		savingFunding = false;
	}
}

async function copyLink() {
	await navigator.clipboard.writeText(fundLink(spaceId)).catch(() => undefined);
	copied = true;
	setTimeout(() => (copied = false), 1_600);
}

$effect(() => {
	if (
		nearEnd &&
		activity.hasMore &&
		!activity.loadingMore &&
		!activity.moreFailed
	)
		void activity.loadMore();
});

$effect(() => {
	const ids = activity.items.flatMap((item) =>
		item.actorUserId ? [item.actorUserId] : [],
	);
	if (ids.length) void userProfilesRepo.hydrate(ids);
});

onMount(() => {
	void balance.load();
	void activity.load();
	void space.load();
	const stopProfiles = userProfilesRepo.subscribe(() => profilesVersion++);
	const stopEvents = subscribeSpaceChannel(spaceId, (event) => {
		if (event.type === SPACE_WALLET_UPDATED_EVENT) refresh();
	});
	const onVisible = () => {
		if (document.visibilityState === "visible") refresh();
	};
	window.addEventListener("focus", refresh);
	document.addEventListener("visibilitychange", onVisible);
	const interval = setInterval(onVisible, 30_000);
	return () => {
		stopProfiles();
		stopEvents();
		clearInterval(interval);
		window.removeEventListener("focus", refresh);
		document.removeEventListener("visibilitychange", onVisible);
	};
});
</script>

<svelte:head><title>{m.wallet_title({}, { locale })} — Cohub</title></svelte:head>

<div class="flex min-h-0 flex-1 flex-col overflow-y-auto bg-bg-primary">
  <header class="flex h-11 shrink-0 items-center gap-3 border-b border-border-subtle px-4">
    <a href={buildSpaceRootRoute(spaceId)} class="inline-flex h-8 w-8 items-center justify-center rounded-md text-text-secondary hover:bg-bg-hover" aria-label={m.space_back({}, { locale })}><ArrowLeft class="h-4 w-4" /></a>
    <span class="min-w-0 truncate text-[13px] text-text-secondary">{space.data?.name ?? m.wallet_title({}, { locale })}</span>
  </header>
  <main class="mx-auto w-full max-w-3xl space-y-10 px-4 py-6 sm:px-8">
    <section aria-labelledby="wallet-heading">
      <div class="flex items-center justify-between gap-4">
        <h1 id="wallet-heading" class="text-lg font-medium text-text-primary">{m.wallet_title({}, { locale })}</h1>
        <button type="button" class="secondary-key inline-flex h-8 w-8 items-center justify-center" onclick={refresh} disabled={balance.refreshing} aria-label={m.wallet_refresh({}, { locale })}><RefreshCw class="h-3.5 w-3.5" /></button>
      </div>
      <p class="mt-2 text-[13px] leading-relaxed text-text-tertiary">{m.wallet_description({}, { locale })}</p>
      <p class="mt-4 min-h-8 font-mono text-2xl tabular-nums text-text-primary">{balance.data ? money(balance.data.balanceUsd, 4) : "—"}</p>
      {#if balance.error}<p class="mt-2 text-sm text-error" role="alert">{m.billing_load_failed({}, { locale })}</p>{/if}
    </section>

    <section aria-labelledby="wallet-fund-heading" class="space-y-4">
      <div class="flex items-center justify-between gap-4">
        <h2 id="wallet-fund-heading" class="text-sm font-medium text-text-primary">{m.wallet_fund({}, { locale })}</h2>
        <button type="button" class="inline-flex h-7 items-center gap-1.5 rounded-[5px] px-2 text-[12px] text-text-secondary hover:bg-bg-hover hover:text-text-primary" onclick={copyLink}>
          {#if copied}<Check class="h-3.5 w-3.5 text-success" />{m.wallet_fund_link_copied({}, { locale })}{:else}<Link class="h-3.5 w-3.5" />{m.wallet_fund_link_copy({}, { locale })}{/if}
        </button>
      </div>
      {#if canEdit}
        <div class="flex items-center justify-between gap-6 border-y border-border-subtle py-3">
          <div class="min-w-0">
            <p class="text-[13px] text-text-primary">{m.wallet_public_funding({}, { locale })}</p>
            <p class="mt-0.5 text-[12px] leading-5 text-text-tertiary">{m.wallet_public_funding_hint({}, { locale })}</p>
            {#if fundingError}<p class="mt-1 text-[12px] text-error-soft" role="alert">{m.billing_load_failed({}, { locale })}</p>{/if}
          </div>
          <ToggleSwitch checked={publicFunding} label={m.wallet_public_funding({}, { locale })} disabled={savingFunding} onchange={setPublicFunding} />
        </div>
      {/if}
      <SpaceFundPanel {spaceId} identity="none" onFunded={refresh} />
    </section>

    <section aria-labelledby="wallet-activity-heading">
      <h2 id="wallet-activity-heading" class="text-sm font-medium text-text-primary">{m.billing_activity_heading({}, { locale })}</h2>
      {#if activity.error}<p class="mt-3 text-sm text-error" role="alert">{m.billing_activity_load_failed({}, { locale })}</p>{/if}
      <div class="mt-3 min-h-24 divide-y divide-border-subtle">
        {#each activity.items as item (item.id)}
          {@const profile = item.actorUserId ? actor(item.actorUserId) : null}
          <div class="flex items-start justify-between gap-4 py-3">
            <div class="min-w-0">
              <p class="text-sm text-text-primary">{kinds[item.kind]}</p>
              <div class="mt-1 flex min-w-0 items-center gap-2 text-xs text-text-tertiary">
                <span class="shrink-0">{formatDateTime(item.createdAt, locale)}</span>
                {#if item.actorUserId}
                  <UserIdentity name={profile?.displayName ?? item.actorUserId.slice(0, 8)} avatarUrl={profile?.avatarUrl} username={profile?.username} seed={item.actorUserId} size="xxs" class="min-w-0" nameClass="truncate" />
                {/if}
              </div>
            </div>
            <span class="shrink-0 font-mono text-sm tabular-nums {item.amountUsd > 0 ? 'text-success-soft' : 'text-text-secondary'}">{formatBalance(item.amountUsd, locale)}</span>
          </div>
        {:else}<p class="py-5 text-sm text-text-tertiary">{activity.loading ? m.common_loading({}, { locale }) : m.billing_no_activity({}, { locale })}</p>{/each}
      </div>
      {#if activity.hasMore || activity.loadingMore}
        <div use:inScrollView={(visible) => (nearEnd = visible)} class="flex h-12 items-center justify-center text-text-tertiary">
          {#if activity.loadingMore}<Loader2 class="h-3.5 w-3.5 animate-spin" />
          {:else if activity.moreFailed}<button type="button" class="text-xs hover:text-text-secondary" onclick={() => activity.loadMore()}>{m.billing_activity_load_failed({}, { locale })} · {m.common_retry({}, { locale })}</button>{/if}
        </div>
      {/if}
    </section>
  </main>
</div>
