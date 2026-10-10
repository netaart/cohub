<script lang="ts">
import { Check, Copy, Gift, Loader2, RefreshCw, Share2 } from "lucide-svelte";
import ListRowText from "$lib/components/list-page/ListRowText.svelte";
import { LIST_ROW_AVATAR } from "$lib/components/list-page/list-row";
import UserAvatar from "$lib/components/UserAvatar.svelte";
import * as account from "$lib/features/settings/account-data";
import { onSettingsPageActive } from "$lib/features/settings/page-context.svelte";
import { formatCurrency, formatDate } from "$lib/i18n/format";
import { getLocale } from "$lib/i18n/locale.svelte";
import { m } from "$lib/paraglide/messages.js";
import { sdk } from "$lib/sdk";
import { canShare, share } from "$lib/share";

const locale = $derived(getLocale());

const dashboard = $derived(account.referrals.data);
const loadError = $derived(
	dashboard
		? ""
		: account.referrals.errorMessage(m.referral_load_failed({}, { locale })),
);
let copied = $state(false);
let copyError = $state("");
let rotating = $state(false);
let rotateError = $state("");
let copiedTimer: ReturnType<typeof setTimeout> | null = null;

const referralUrl = $derived(
	dashboard && typeof window !== "undefined"
		? `${window.location.origin}/referrals/${dashboard.code}`
		: "",
);
const inviteeAmount = $derived(
	dashboard
		? formatCurrency(dashboard.reward.inviteeUsd, "USD", {
				locale,
				minimumFractionDigits: 2,
				maximumFractionDigits: 2,
			})
		: "",
);
const inviterAmount = $derived(
	dashboard
		? formatCurrency(dashboard.reward.inviterUsd, "USD", {
				locale,
				minimumFractionDigits: 2,
				maximumFractionDigits: 2,
			})
		: "",
);

onSettingsPageActive(() => void account.referrals.load());

async function copyLink() {
	if (!referralUrl) return;
	copyError = "";
	try {
		await navigator.clipboard.writeText(referralUrl);
		copied = true;
		if (copiedTimer) clearTimeout(copiedTimer);
		copiedTimer = setTimeout(() => {
			copied = false;
		}, 2000);
	} catch {
		copyError = m.referral_copy_error({}, { locale });
	}
}

async function shareLink() {
	if (!dashboard || !referralUrl) return;
	if (!canShare()) {
		await copyLink();
		return;
	}
	try {
		await share({
			title: m.referral_try_title({}, { locale }),
			text: m.referral_share_text({ amount: inviteeAmount }, { locale }),
			url: referralUrl,
		});
	} catch {
		copyError = m.referral_share_error({}, { locale });
	}
}

async function rotateLink() {
	if (rotating || !confirm(m.referral_rotate_confirm({}, { locale }))) return;
	rotating = true;
	rotateError = "";
	try {
		const { code } = await sdk.referrals.rotateCode();
		account.referrals.update((current) => ({ ...current, code }));
	} catch (error) {
		rotateError =
			error instanceof Error
				? error.message
				: m.referral_rotate_failed({}, { locale });
	} finally {
		rotating = false;
	}
}
</script>

<div class="flex-1 px-4 py-6 sm:px-6 sm:py-7">
	<section class="max-w-2xl">
		<header class="border-b border-border-subtle pb-5">
			<h1 class="text-[18px] font-semibold tracking-tight text-text-primary">{m.page_title_referrals({}, { locale })}</h1>
			<p class="mt-1 max-w-xl text-[13px] leading-5 text-text-tertiary">{m.referral_share_subtitle({}, { locale })}</p>
		</header>

		{#if account.referrals.loading}
			<div class="flex h-44 items-center justify-center text-text-tertiary"><Loader2 class="h-4 w-4 animate-spin" /><span class="ml-2 text-[12px]">{m.referral_loading({}, { locale })}</span></div>
		{:else if loadError || !dashboard}
			<div class="py-8">
				<p class="text-[13px] text-error-soft">{loadError || m.referral_load_failed({}, { locale })}</p>
				<button type="button" class="mt-3 inline-flex h-8 items-center gap-1.5 rounded-[5px] px-2.5 text-[12px] text-text-tertiary hover:bg-bg-hover hover:text-text-secondary disabled:opacity-50" disabled={account.referrals.refreshing} onclick={() => void account.referrals.load({ force: true })}><RefreshCw class="h-3.5 w-3.5 {account.referrals.refreshing ? 'animate-spin' : ''}" />{m.referral_retry({}, { locale })}</button>
			</div>
		{:else}
			<div class="py-6">
				<div class="flex items-start gap-3">
					<div class="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-[6px] bg-brand-muted text-brand"><Gift class="h-4 w-4" /></div>
					<div>
						<h2 class="text-[16px] font-semibold tracking-tight text-text-primary">{m.referral_give_get({ inviteeAmount, inviterAmount }, { locale })}</h2>
						<p class="mt-1 max-w-lg text-[12px] leading-5 text-text-tertiary">{m.referral_both_credits({}, { locale })}</p>
					</div>
				</div>

				<div class="mt-5 flex flex-col gap-2 sm:flex-row">
					<div class="flex h-9 min-w-0 flex-1 items-center rounded-[5px] border border-border-subtle bg-bg-input px-2.5"><code class="min-w-0 flex-1 truncate text-[12px] text-text-secondary">{referralUrl}</code></div>
					<div class="flex gap-2">
						<button type="button" class="inline-flex h-9 flex-1 items-center justify-center gap-1.5 rounded-[5px] bg-brand px-3 text-[12px] font-medium text-brand-contrast-fg hover:bg-brand-hover sm:flex-none" onclick={() => void copyLink()}>{#if copied}<Check class="h-3.5 w-3.5" />{m.referral_copied({}, { locale })}{:else}<Copy class="h-3.5 w-3.5" />{m.referral_copy_link({}, { locale })}{/if}</button>
						<button type="button" class="inline-flex h-9 flex-1 items-center justify-center gap-1.5 rounded-[5px] border border-border-subtle px-3 text-[12px] text-text-secondary hover:bg-bg-hover sm:flex-none" onclick={() => void shareLink()}><Share2 class="h-3.5 w-3.5" />{m.referral_share({}, { locale })}</button>
					</div>
				</div>
				{#if copyError}<p class="mt-2 text-[11px] text-error-soft">{copyError}</p>{/if}

				<div class="mt-6 flex gap-8 border-y border-border-subtle py-4">
					<div><div class="font-mono text-[17px] font-semibold text-text-primary">{dashboard.summary.rewarded}</div><div class="mt-0.5 text-[11px] text-text-tertiary">{m.referral_successful({}, { locale })}</div></div>
					<div><div class="font-mono text-[17px] font-semibold text-text-primary">{formatCurrency(dashboard.summary.earnedUsd, "USD", { locale, minimumFractionDigits: 2, maximumFractionDigits: 2 })}</div><div class="mt-0.5 text-[11px] text-text-tertiary">{m.referral_credits_earned({}, { locale })}</div></div>
				</div>
			</div>

			<section>
				<div class="flex items-center justify-between pb-3">
					<h2 class="text-[13px] font-medium text-text-primary">{m.page_title_referrals({}, { locale })} <span class="font-normal text-text-tertiary">· {dashboard.summary.total}</span></h2>
					<button type="button" disabled={rotating} class="inline-flex h-8 items-center gap-1.5 rounded-[5px] px-2 text-[11px] text-text-tertiary hover:bg-bg-hover hover:text-text-secondary disabled:opacity-50" onclick={() => void rotateLink()}>{#if rotating}<Loader2 class="h-3 w-3 animate-spin" />{:else}<RefreshCw class="h-3 w-3" />{/if}{m.referral_replace_link({}, { locale })}</button>
				</div>
				{#if rotateError}<p class="mb-3 text-[12px] text-error-soft">{rotateError}</p>{/if}
				{#if dashboard.items.length === 0}
					<div class="border-t border-border-subtle py-8 text-center"><p class="text-[12px] text-text-tertiary">{m.referral_no_referrals({}, { locale })}</p><p class="mt-1 text-[11px] text-text-placeholder">{m.referral_share_to_start({}, { locale })}</p></div>
				{:else}
					<div class="divide-y divide-border-subtle border-y border-border-subtle">
						{#each dashboard.items as item (item.id)}
							{@const name = item.profile?.displayName || m.referral_c_user({}, { locale })}
							<div data-density="compact" class="flex h-[var(--list-row-height)] items-center gap-[var(--list-row-gap)]">
								<UserAvatar {name} avatarUrl={item.profile?.avatarUrl} seed={item.profile?.userUuid} size={LIST_ROW_AVATAR.compact} />
								<ListRowText title={name} tooltip={name}>
									{#snippet subtitle()}{item.profile?.username ? `@${item.profile.username} · ` : ""}{m.referral_joined({ date: formatDate(item.claimedAt, locale) }, { locale })}{/snippet}
								</ListRowText>
								<span class="shrink-0 text-[11px] {item.status === 'rewarded' ? 'text-status-running' : 'text-text-tertiary'}">{item.status === "rewarded" ? m.referral_rewarded({}, { locale }) : item.status === "qualified" ? m.referral_processing({}, { locale }) : m.referral_pending({}, { locale })}</span>
							</div>
						{/each}
					</div>
				{/if}
				<p class="mt-4 text-[10px] leading-4 text-text-placeholder">{m.referral_footnote({}, { locale })}</p>
			</section>
		{/if}
	</section>
</div>
