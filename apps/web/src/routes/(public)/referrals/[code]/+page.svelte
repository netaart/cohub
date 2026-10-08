<script lang="ts">
import type { PublicReferral } from "@neta-art/cohub";
import { ArrowRight, Gift, Loader2 } from "lucide-svelte";
import { onMount } from "svelte";
import { goto } from "$app/navigation";
import { ensureAuth } from "$lib/auth";
import UserAvatar from "$lib/components/UserAvatar.svelte";
import type { Locale } from "$lib/i18n/locale";
import { getLocale } from "$lib/i18n/locale.svelte";
import { m } from "$lib/paraglide/messages.js";
import { sdk } from "$lib/sdk";
import { authStore } from "$lib/stores/auth.svelte";

const props = $props<{ params: { code: string } }>();
const code = $derived(props.params.code);
const locale: Locale = $derived(getLocale());
let referral = $state<PublicReferral | null>(null);
let loading = $state(true);
let loadError = $state("");
let action = $state<
	"idle" | "claiming" | "done" | "self" | "existing" | "error"
>("idle");
let actionError = $state("");

onMount(async () => {
	try {
		referral = await sdk.referrals.get(code);
		await authStore.ensureLoaded();
	} catch (error) {
		loadError =
			error instanceof Error
				? error.message
				: m.referral_unavailable_body({}, { locale });
	} finally {
		loading = false;
	}
});

async function claim() {
	if (action !== "idle") return;
	action = "claiming";
	try {
		if (!authStore.isAuthenticated) {
			const authenticated = await ensureAuth({
				redirectPath: `/referrals/${code}`,
			});
			if (!authenticated) {
				action = "idle";
				return;
			}
			await authStore.ensureLoaded(true);
			if (!authStore.isAuthenticated) {
				action = "idle";
				return;
			}
		}
		if (authStore.userUuid === referral?.inviter.userUuid) {
			action = "self";
			return;
		}
		await sdk.referrals.claim(code);
		action = "done";
		setTimeout(() => void goto("/"), 900);
	} catch (error) {
		const httpError = error as {
			status?: number;
			body?: { status?: unknown };
		};
		const referralStatus = httpError.body?.status;
		const message =
			error instanceof Error
				? error.message
				: m.referral_failed({}, { locale });
		if (
			httpError.status === 409 &&
			(referralStatus === "existing_user" ||
				referralStatus === "already_claimed")
		) {
			action = "existing";
		} else if (httpError.status === 409 && referralStatus === "self") {
			action = "self";
		} else {
			action = "error";
			actionError = message;
		}
	}
}
</script>

<svelte:head><title>{m.referral_seo_title({}, { locale })}</title></svelte:head>

<div class="flex min-h-screen items-center justify-center bg-bg-primary px-4 py-10">
	<main class="w-full max-w-[420px]">
		<a href="/" class="mb-8 inline-flex h-9 w-9 items-center justify-center rounded-[7px] bg-brand text-[12px] font-bold text-brand-contrast-fg">C</a>
		{#if loading}
			<div class="flex h-52 items-center justify-center text-text-tertiary"><Loader2 class="h-4 w-4 animate-spin" /><span class="ml-2 text-[12px]">{m.referral_loading({}, { locale })}</span></div>
		{:else if loadError || !referral}
			<div class="border-t border-border-subtle py-8"><h1 class="text-[18px] font-semibold text-text-primary">{m.referral_unavailable_title({}, { locale })}</h1><p class="mt-2 text-[13px] leading-5 text-text-tertiary">{m.referral_unavailable_body({}, { locale })}</p></div>
		{:else}
			<div class="border-t border-border-subtle pt-7">
				<div class="flex items-center gap-3">
					<UserAvatar name={referral.inviter.displayName} avatarUrl={referral.inviter.avatarUrl} seed={referral.inviter.userUuid} size="lg" />
					<div class="min-w-0"><p class="truncate text-[13px] font-medium text-text-primary">{referral.inviter.displayName}</p>{#if referral.inviter.username}<p class="mt-0.5 text-[11px] text-text-tertiary">@{referral.inviter.username}</p>{/if}</div>
				</div>
				<h1 class="mt-6 text-[22px] font-semibold tracking-tight text-text-primary">{m.referral_referred_you({ name: referral.inviter.displayName }, { locale })}</h1>
				<p class="mt-2 text-[13px] leading-5 text-text-tertiary">{m.referral_tagline({}, { locale })}</p>
				<div class="mt-6 flex items-center gap-2 border-y border-border-subtle py-4 text-[13px] text-text-secondary"><Gift class="h-4 w-4 text-brand" /><span>{m.referral_get_credits({ amount: `$${referral.reward.inviteeUsd}` }, { locale })}</span></div>

				{#if action === "self"}
					<div class="mt-6"><p class="text-[13px] text-text-secondary">{m.referral_self({}, { locale })}</p><a href="/settings/referrals" class="mt-3 inline-flex h-9 items-center gap-1.5 rounded-[5px] bg-brand px-4 text-[12px] font-medium text-brand-contrast-fg">{m.referral_view_referrals({}, { locale })} <ArrowRight class="h-3.5 w-3.5" /></a></div>
				{:else if action === "existing"}
					<div class="mt-6"><p class="text-[13px] text-text-secondary">{m.referral_existing({}, { locale })}</p><a href="/" class="mt-3 inline-flex h-9 items-center gap-1.5 rounded-[5px] bg-brand px-4 text-[12px] font-medium text-brand-contrast-fg">{m.referral_open_cohub({}, { locale })} <ArrowRight class="h-3.5 w-3.5" /></a></div>
				{:else if action === "done"}
					<p class="mt-6 text-[13px] text-status-running">{m.referral_applied({}, { locale })}</p>
				{:else}
					{#if actionError}<p class="mt-5 text-[12px] text-error-soft">{actionError}</p>{/if}
					<button type="button" disabled={action === "claiming"} class="mt-6 inline-flex h-10 items-center gap-2 rounded-[5px] bg-brand px-5 text-[13px] font-medium text-brand-contrast-fg hover:bg-brand-hover disabled:opacity-60" onclick={() => void claim()}>{#if action === "claiming"}<Loader2 class="h-4 w-4 animate-spin" />{m.referral_joining({}, { locale })}{:else}{m.referral_join({}, { locale })} <ArrowRight class="h-4 w-4" />{/if}</button>
				{/if}
			</div>
		{/if}
	</main>
</div>
