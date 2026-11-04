<script lang="ts">
import type { BillingCatalogProduct, SpaceWalletActivityPage } from "@neta-art/cohub";
import { ArrowLeft, ChevronLeft, ChevronRight, Loader2, RefreshCw } from "lucide-svelte";
import { onMount, untrack } from "svelte";
import { getCacheUserKey } from "$lib/cache/keys";
import { AccountResource } from "$lib/features/settings/account-resource.svelte";
import { formatCurrency, formatDateTime } from "$lib/i18n/format";
import { getLocale } from "$lib/i18n/locale.svelte";
import { m } from "$lib/paraglide/messages.js";
import { sdk } from "$lib/sdk";
import { includedBalanceUsd } from "./product";

const { spaceId }: { spaceId: string } = $props();
const locale = $derived(getLocale());
const api = untrack(() => sdk.space(spaceId).wallet);
const balance = untrack(() => new AccountResource(`space-wallet:${spaceId}`, () => api.get()));
const activity = untrack(() => new AccountResource(`space-wallet-activity:${spaceId}`, () => api.activities()));
const catalog = untrack(() => new AccountResource(`space-wallet-catalog:${spaceId}`, () => api.catalog()));
const space = untrack(() => new AccountResource(`space-wallet-name:${spaceId}`, () => sdk.space(spaceId).get()));
let buying = $state<string | null>(null);
let checkoutError = $state(false);
let confirmation = $state<"pending" | "settled" | "failed" | null>(null);
let returnedOrderId = $state<string | null>(null);
let confirming = $state(false);
let page = $state(1);
let laterActivity = $state<SpaceWalletActivityPage | null>(null);
let paging = $state(false);
let pagingError = $state(false);
let disposed = false;
const activities = $derived(page === 1 ? activity.data : laterActivity);
const canRecharge = $derived(catalog.data?.supported && catalog.data.paymentAvailable && balance.data?.usable !== false);
const checkoutPrefix = () => `cohub:wallet-checkout:${getCacheUserKey()}:${spaceId}:`;
const money = (amount: number, maximumFractionDigits = 2) => formatCurrency(amount, "USD", { locale, maximumFractionDigits });
const kinds = $derived({
  grant: m.wallet_activity_recharge({}, { locale }), usage: m.wallet_activity_usage({}, { locale }),
  reversal: m.wallet_activity_reversal({}, { locale }),
  refund: m.wallet_activity_refund({}, { locale }), expire: m.billing_expired({}, { locale }),
  revoke: m.wallet_activity_revoke({}, { locale }), adjust: m.wallet_activity_adjust({}, { locale }),
});

async function refresh() {
  if (!balance.refreshing) void balance.load({ force: true });
  if (!activity.refreshing) void activity.load({ force: true });
}

async function changePage(next: number) {
  if (paging) return;
  if (next === 1) { page = 1; return; }
  paging = true;
  pagingError = false;
  try { laterActivity = await api.activities(next); page = next; }
  catch { pagingError = true; }
  finally { paging = false; }
}

async function buy(product: BillingCatalogProduct) {
  if (buying || !canRecharge) return;
  buying = product.key;
  checkoutError = false;
  const key = `${checkoutPrefix()}${product.key}`;
  try {
    let id = sessionStorage.getItem(key);
    if (id) {
      const previous = await api.confirmOrder(id).catch(() => null);
      if (previous && (previous.settled || !previous.pending)) id = null;
    }
    id ??= crypto.randomUUID();
    sessionStorage.setItem(key, id);
    const { checkout } = await api.createOrder({ id, productKey: product.key });
    if (!checkout.checkoutUsable || !checkout.checkoutUrl) {
      if (checkout.orderId) sessionStorage.removeItem(key);
      throw new Error("Checkout unavailable");
    }
    const url = new URL(checkout.checkoutUrl);
    if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("Invalid checkout URL");
    window.location.assign(url.toString());
  } catch { checkoutError = true; void refresh(); }
  finally { buying = null; }
}

async function confirmPayment() {
  if (!returnedOrderId || confirming) return;
  confirming = true;
  try {
    const result = await api.confirmOrder(returnedOrderId);
    if (disposed) return;
    confirmation = result.settled ? "settled" : result.pending ? "pending" : "failed";
    if (result.settled || !result.pending) {
      for (let index = sessionStorage.length - 1; index >= 0; index--) {
        const key = sessionStorage.key(index);
        if (key?.startsWith(checkoutPrefix()) && sessionStorage.getItem(key) === returnedOrderId) sessionStorage.removeItem(key);
      }
      await refresh();
    }
  } catch { if (!disposed) confirmation = "pending"; }
  finally { confirming = false; }
}

onMount(() => {
  void balance.load(); void activity.load(); void catalog.load(); void space.load();
  const url = new URL(window.location.href);
  returnedOrderId = url.searchParams.get("wallet_order");
  if (returnedOrderId) { confirmation = "pending"; void confirmPayment(); }
  const onFocus = () => { void refresh(); if (confirmation === "pending") void confirmPayment(); };
  const onVisible = () => { if (document.visibilityState === "visible") onFocus(); };
  window.addEventListener("focus", onFocus);
  document.addEventListener("visibilitychange", onVisible);
  const interval = setInterval(onVisible, 30_000);
  return () => {
    disposed = true;
    clearInterval(interval);
    window.removeEventListener("focus", onFocus);
    document.removeEventListener("visibilitychange", onVisible);
  };
});
</script>

<svelte:head><title>{m.wallet_title({}, { locale })} — Cohub</title></svelte:head>

<div class="flex min-h-0 flex-1 flex-col overflow-y-auto bg-bg-primary">
  <header class="flex h-11 shrink-0 items-center gap-3 border-b border-border-subtle px-4">
    <a href={`/spaces/${spaceId}`} class="inline-flex h-8 w-8 items-center justify-center rounded-md text-text-secondary hover:bg-bg-hover" aria-label={m.space_back({}, { locale })}><ArrowLeft class="h-4 w-4" /></a>
    <span class="min-w-0 truncate text-[13px] text-text-secondary">{space.data?.name ?? m.wallet_title({}, { locale })}</span>
  </header>
  <main class="mx-auto w-full max-w-3xl space-y-8 px-4 py-6 sm:px-8">
    <section aria-labelledby="wallet-heading">
      <div class="flex items-center justify-between gap-4">
        <h1 id="wallet-heading" class="text-lg font-medium text-text-primary">{m.wallet_title({}, { locale })}</h1>
        <button type="button" class="secondary-key inline-flex h-8 w-8 items-center justify-center" onclick={refresh} disabled={balance.refreshing} aria-label={m.wallet_refresh({}, { locale })}><RefreshCw class="h-3.5 w-3.5" /></button>
      </div>
      <p class="mt-2 text-[13px] leading-relaxed text-text-tertiary">{m.wallet_description({}, { locale })}</p>
      <p class="mt-4 min-h-8 font-mono text-2xl tabular-nums text-text-primary">{balance.data ? money(balance.data.balanceUsd, 4) : "—"}</p>
      {#if balance.error}<p class="mt-2 text-sm text-error" role="alert">{m.billing_load_failed({}, { locale })}</p>{/if}
    </section>

    {#if confirmation}
      <div class="flex flex-wrap items-center justify-between gap-3 border-y border-border-subtle py-3 text-sm text-text-secondary" role="status">
        <span>{confirmation === "settled" ? m.purchase_return_success({}, { locale }) : confirmation === "failed" ? m.purchase_return_failed({}, { locale }) : m.wallet_payment_pending({}, { locale })}</span>
        {#if confirmation === "pending"}<button type="button" class="secondary-key px-3 py-1.5" disabled={confirming} onclick={confirmPayment}>{m.wallet_refresh({}, { locale })}</button>{/if}
      </div>
    {/if}

    <section aria-labelledby="wallet-recharge-heading">
      <h2 id="wallet-recharge-heading" class="text-sm font-medium text-text-primary">{m.purchase_cta_add_balance({}, { locale })}</h2>
      <p class="mt-1 text-xs leading-relaxed text-text-tertiary">{m.wallet_recharge_note({}, { locale })}</p>
      {#if catalog.loading}<p class="mt-4 text-sm text-text-tertiary">{m.common_loading({}, { locale })}</p>
      {:else if catalog.error}<button class="secondary-key mt-4 px-3 py-2 text-sm" onclick={() => catalog.load({ force: true })}>{m.common_retry({}, { locale })}</button>
      {:else if !canRecharge || !catalog.data?.products.length}<p class="mt-4 text-sm text-text-tertiary">{m.wallet_recharge_unavailable({}, { locale })}</p>
      {:else}
        <div class="mt-3 divide-y divide-border-subtle">
          {#each catalog.data.products as product (product.key)}
            <div class="flex items-center justify-between gap-4 py-3">
              <div class="min-w-0"><p class="truncate text-sm text-text-primary">{product.name}</p><p class="mt-1 text-xs text-text-tertiary">{m.purchase_note_balance_once({ amount: money(includedBalanceUsd(product)) }, { locale })}</p></div>
              <button type="button" class="secondary-key inline-flex min-h-10 shrink-0 items-center gap-2 px-3 text-sm tabular-nums" disabled={buying !== null} onclick={() => buy(product)}>
                {#if buying === product.key}<Loader2 class="h-3.5 w-3.5 animate-spin motion-reduce:animate-none" />{/if}
                {money(product.pricing.amountUsd)}
              </button>
            </div>
          {/each}
        </div>
      {/if}
      {#if checkoutError}<p class="mt-2 text-sm text-error" role="alert">{m.wallet_checkout_failed({}, { locale })}</p>{/if}
    </section>

    <section aria-labelledby="wallet-activity-heading">
      <h2 id="wallet-activity-heading" class="text-sm font-medium text-text-primary">{m.billing_activity_heading({}, { locale })}</h2>
      {#if activity.error || pagingError}<p class="mt-3 text-sm text-error" role="alert">{m.billing_activity_load_failed({}, { locale })}</p>{/if}
      <div class="mt-3 min-h-24 divide-y divide-border-subtle">
        {#each activities?.items ?? [] as item (item.id)}
          <div class="flex items-start justify-between gap-4 py-3">
            <div class="min-w-0"><p class="text-sm text-text-primary">{item.title || kinds[item.kind]}</p>{#if item.description}<p class="mt-1 line-clamp-2 text-xs text-text-tertiary">{item.description}</p>{/if}<p class="mt-1 text-xs text-text-tertiary">{formatDateTime(item.createdAt, locale)}</p>{#if item.actorUserId}<p class="mt-1 truncate font-mono text-xs text-text-tertiary" title={item.actorUserId}>{item.actorUserId}</p>{/if}</div>
            <span class="shrink-0 font-mono text-sm tabular-nums text-text-secondary">{money(item.amountUsd, 8)}</span>
          </div>
        {:else}<p class="py-5 text-sm text-text-tertiary">{activity.loading ? m.common_loading({}, { locale }) : m.billing_no_activity({}, { locale })}</p>{/each}
      </div>
      {#if page > 1 || activities?.hasMore}
        <div class="mt-2 flex justify-end gap-2">
          <button type="button" class="secondary-key flex h-9 w-9 items-center justify-center" disabled={page === 1 || paging} onclick={() => changePage(page - 1)} aria-label={m.billing_prev_page({}, { locale })}><ChevronLeft class="h-4 w-4" /></button>
          <button type="button" class="secondary-key flex h-9 w-9 items-center justify-center" disabled={!activities?.hasMore || paging} onclick={() => changePage(page + 1)} aria-label={m.billing_next_page({}, { locale })}><ChevronRight class="h-4 w-4" /></button>
        </div>
      {/if}
    </section>
  </main>
</div>
