<script lang="ts">
import {
	buildSpaceInvitePath,
	buildSpacePath,
	HttpError,
	type InvitationDetail,
	type SpaceRole,
} from "@neta-art/cohub";
import { ArrowRight, Loader2 } from "lucide-svelte";
import { onMount } from "svelte";
import { ensureAuth } from "#lib/auth.ts";
import SpaceAvatar from "#lib/components/SpaceAvatar.svelte";
import Spinner from "#lib/components/Spinner.svelte";
import UserAvatar from "#lib/components/UserAvatar.svelte";
import {
	formatInviteExpiry,
	spaceRoleLabel,
} from "#lib/features/invitations/invitation-format.ts";
import SpaceGuestApp from "#lib/features/invitations/SpaceGuestApp.svelte";
import { getLocale } from "#lib/i18n/locale.svelte.ts";
import type { Locale } from "#lib/i18n/locale.ts";
import { m } from "#lib/paraglide/messages.js";
import { sdk } from "#lib/sdk.ts";
import { authStore } from "#lib/stores/auth.svelte.ts";
import { goto } from "$app/navigation";

const props: { token: string } = $props();
const token = $derived(props.token);
const locale: Locale = $derived(getLocale());

const ROLE_RANK: Record<SpaceRole, number> = { guest: 1, builder: 2, host: 3 };
const ACCEPT_INTENT_KEY = "cohub:invite-accept";
const ACCEPT_INTENT_TTL_MS = 10 * 60 * 1000;

let detail = $state<InvitationDetail | null>(null);
let loadState = $state<"loading" | "ready" | "unavailable" | "error">(
	"loading",
);
let loadError = $state("");
let joining = $state(false);
let joinError = $state("");
let guestAppFailed = $state(false);

const invitePath = $derived(
	detail
		? buildSpaceInvitePath({ ...detail, inviteCode: detail.token })
		: `/invite/${encodeURIComponent(token)}`,
);
const spacePath = $derived(detail ? buildSpacePath(detail) : "/");
const isMember = $derived(
	Boolean(
		detail?.viewerRole &&
			ROLE_RANK[detail.viewerRole] >= ROLE_RANK[detail.role],
	),
);

async function load() {
	loadState = "loading";
	try {
		const [next] = await Promise.all([
			sdk.invite.get(token),
			authStore.ensureLoaded(),
		]);
		detail = next;
		loadState = "ready";
		if (window.location.pathname !== invitePath)
			void goto(invitePath, { shallow: true, replace: true });
		if (takeAcceptIntent() && authStore.isAuthenticated && !isMember) {
			void accept();
		}
	} catch (error) {
		if (error instanceof HttpError && error.status === 410) {
			loadState = "unavailable";
			return;
		}
		loadState = "error";
		loadError = error instanceof Error ? error.message : "";
	}
}

async function accept() {
	if (joining || !detail) return;
	joinError = "";
	if (!authStore.isAuthenticated) {
		writeAcceptIntent();
		await ensureAuth({ redirectPath: invitePath });
		return;
	}
	joining = true;
	try {
		const result = await sdk.invite.accept(detail.token);
		await goto(buildSpacePath(result));
	} catch (error) {
		if (error instanceof HttpError && error.status === 410) {
			loadState = "unavailable";
		} else {
			joinError =
				error instanceof Error && error.message
					? error.message
					: m.invite_failed_join({}, { locale });
		}
	} finally {
		joining = false;
	}
}

function writeAcceptIntent() {
	try {
		sessionStorage.setItem(
			ACCEPT_INTENT_KEY,
			JSON.stringify({ token, at: Date.now() }),
		);
	} catch {}
}

function takeAcceptIntent(): boolean {
	try {
		const raw = sessionStorage.getItem(ACCEPT_INTENT_KEY);
		sessionStorage.removeItem(ACCEPT_INTENT_KEY);
		const intent = raw ? JSON.parse(raw) : null;
		return (
			intent?.token === token && Date.now() - intent.at < ACCEPT_INTENT_TTL_MS
		);
	} catch {
		return false;
	}
}

onMount(() => {
	void load();
});
</script>

<svelte:head><title>{detail ? m.invite_title({ space: detail.spaceName }, { locale }) : m.invite_seo_title({}, { locale })}</title></svelte:head>

{#snippet defaultPage()}
	<div class="flex min-h-screen items-center justify-center bg-bg-primary px-4 py-10">
		<main class="w-full max-w-[420px]">
			<a href="/" class="mb-8 inline-flex h-9 w-9 items-center justify-center rounded-[7px] bg-brand text-[12px] font-bold text-brand-contrast-fg">C</a>
			{#if loadState === "loading"}
				<div class="flex h-52 items-center justify-center text-text-tertiary"><Loader2 class="h-4 w-4 animate-spin" /><span class="ml-2 text-[12px]">{m.invite_loading({}, { locale })}</span></div>
			{:else if loadState === "unavailable"}
				<div class="border-t border-border-subtle py-8"><h1 class="text-[18px] font-semibold text-text-primary">{m.invite_unavailable_title({}, { locale })}</h1><p class="mt-2 text-[13px] leading-5 text-text-tertiary">{m.invite_unavailable_body({}, { locale })}</p></div>
			{:else if loadState === "error" || !detail}
				<div class="border-t border-border-subtle py-8">
					<h1 class="text-[18px] font-semibold text-text-primary">{m.invite_error_title({}, { locale })}</h1>
					{#if loadError}<p class="mt-2 text-[13px] leading-5 break-words text-text-tertiary">{loadError}</p>{/if}
					<button type="button" class="secondary-key mt-5 h-9 px-4 text-[12px]" onclick={() => void load()}>{m.common_retry({}, { locale })}</button>
				</div>
			{:else}
				<div class="border-t border-border-subtle pt-7">
					<div class="flex items-start gap-3">
						<SpaceAvatar name={detail.spaceName} avatarUrl={detail.spaceAvatarUrl} seed={detail.spaceId} size="lg" loading="eager" class="shrink-0" />
						<div class="min-w-0 pt-0.5">
							<h1 class="text-[22px] leading-tight font-semibold tracking-tight break-words text-text-primary">{m.invite_title({ space: detail.spaceName }, { locale })}</h1>
							<p class="mt-1.5 flex items-center gap-1.5 text-[12px] text-text-tertiary">
								<UserAvatar name={detail.inviter.displayName} avatarUrl={detail.inviter.avatarUrl} seed={detail.inviter.userUuid} size="xxs" />
								<span class="min-w-0 truncate">{m.invite_invited_by({ name: detail.inviter.displayName }, { locale })}</span>
							</p>
						</div>
					</div>
					{#if detail.spaceDescription}<p class="mt-4 line-clamp-3 text-[13px] leading-5 text-text-secondary">{detail.spaceDescription}</p>{/if}
					<div class="mt-6 space-y-1 border-y border-border-subtle py-4 text-[13px] text-text-secondary">
						<p>
							{#if isMember}
								{m.invite_member({}, { locale })}
							{:else if detail.viewerRole}
								{m.invite_role_upgrade({ current: spaceRoleLabel(detail.viewerRole, locale), role: spaceRoleLabel(detail.role, locale) }, { locale })}
							{:else}
								{m.invite_join_as({ role: spaceRoleLabel(detail.role, locale) }, { locale })}
							{/if}
						</p>
						{#if !isMember}
							<p class="text-[12px] text-text-tertiary">{detail.expiresInSeconds === null ? m.invite_never_expires({}, { locale }) : formatInviteExpiry(detail.expiresInSeconds, locale)}</p>
						{/if}
					</div>
					{#if joinError}<p class="mt-5 text-[12px] break-words text-error-soft">{joinError}</p>{/if}
					{#if isMember}
						<a href={spacePath} class="primary-key mt-6 h-10 gap-2 px-5 text-[13px]">{m.invite_open_space({}, { locale })} <ArrowRight class="h-4 w-4" /></a>
					{:else}
						<button type="button" disabled={joining} class="primary-key mt-6 h-10 gap-2 px-5 text-[13px]" onclick={() => void accept()}>{#if joining}<Spinner class="h-4 w-4" />{m.invite_joining({}, { locale })}{:else}{m.invite_accept({}, { locale })} <ArrowRight class="h-4 w-4" />{/if}</button>
					{/if}
				</div>
			{/if}
		</main>
	</div>
{/snippet}

{#if loadState === "ready" && detail?.guestAppId && !isMember && !guestAppFailed}
	<div class="flex h-dvh w-full flex-col bg-bg-primary">
		<SpaceGuestApp
			appId={detail.guestAppId}
			space={{ id: detail.spaceId, name: detail.spaceName }}
			invite={detail.token}
			onJoined={() => void goto(spacePath)}
			onUnavailable={() => (guestAppFailed = true)}
		/>
	</div>
{:else}
	{@render defaultPage()}
{/if}
