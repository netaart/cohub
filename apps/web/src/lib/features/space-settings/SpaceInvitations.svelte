<script lang="ts">
import {
	buildSpaceInvitePath,
	type SpaceInvitation,
	type SpaceRole,
} from "@neta-art/cohub";
import { Check, Copy, Link, Loader2, Trash2, X } from "lucide-svelte";
import { onDestroy } from "svelte";
import { copyTextToClipboard } from "#lib/clipboard.ts";
import Sheet from "#lib/components/Sheet.svelte";
import {
	formatInviteExpiry,
	spaceRoleLabel,
} from "#lib/features/invitations/invitation-format.ts";
import { getLocale } from "#lib/i18n/locale.svelte.ts";
import { m } from "#lib/paraglide/messages.js";
import { sdk } from "#lib/sdk.ts";

let {
	spaceId,
	ownerUsername,
	spaceSlug,
	createOpen = $bindable(false),
}: {
	spaceId: string;
	ownerUsername: string | null;
	spaceSlug: string | null;
	createOpen?: boolean;
} = $props();

const locale = $derived(getLocale());
const PAGE_SIZE = 50;
const MAX_USES = 10_000;
const TTL_DAYS = [1, 7, 14, 30] as const;
const FIELD =
	"h-9 w-full rounded-[5px] border border-border-subtle bg-bg-input px-2.5 text-[13px] text-text-primary focus:border-brand/40 focus:outline-none";

let items = $state<SpaceInvitation[]>([]);
let nextCursor = $state<string | null>(null);
let showInactive = $state(false);
let loading = $state(false);
let listError = $state("");
let notice = $state("");
let copiedToken = $state<string | null>(null);

let role = $state<SpaceRole>("builder");
let ttlDays = $state(7);
let maxUses = $state<number | null>(0);
let creating = $state(false);
let createError = $state("");

let noticeTimer: ReturnType<typeof setTimeout> | null = null;
let copiedTimer: ReturnType<typeof setTimeout> | null = null;
let loadVersion = 0;

const activeCount = $derived(
	items.filter((item) => item.status === "active").length,
);

onDestroy(() => {
	if (noticeTimer) clearTimeout(noticeTimer);
	if (copiedTimer) clearTimeout(copiedTimer);
});

$effect(() => {
	void spaceId;
	void showInactive;
	void load();
});

$effect(() => {
	if (role === "host" && ttlDays === 0) ttlDays = 30;
});

async function load(cursor: string | null = null) {
	const version = ++loadVersion;
	loading = true;
	listError = "";
	try {
		const page = await sdk.space(spaceId).invitations.list({
			status: showInactive ? "all" : "active",
			limit: PAGE_SIZE,
			cursor,
		});
		if (version !== loadVersion) return;
		items = cursor ? [...items, ...page.items] : page.items;
		nextCursor = page.pageInfo.nextCursor;
	} catch (err) {
		if (version !== loadVersion) return;
		listError =
			err instanceof Error && err.message
				? err.message
				: m.space_failed_invite_load({}, { locale });
	} finally {
		if (version === loadVersion) loading = false;
	}
}

function flashNotice(message: string) {
	notice = message;
	if (noticeTimer) clearTimeout(noticeTimer);
	noticeTimer = setTimeout(() => {
		notice = "";
	}, 4000);
}

async function copyLink(token: string) {
	const path = buildSpaceInvitePath({
		spaceId,
		ownerUsername,
		spaceSlug,
		inviteCode: token,
	});
	try {
		await copyTextToClipboard(`${window.location.origin}${path}`);
	} catch {
		return false;
	}
	copiedToken = token;
	if (copiedTimer) clearTimeout(copiedTimer);
	copiedTimer = setTimeout(() => {
		copiedToken = null;
	}, 2000);
	return true;
}

async function create() {
	if (creating) return;
	const uses = maxUses ?? 0;
	if (!Number.isInteger(uses) || uses < 0 || uses > MAX_USES) {
		createError = m.space_invite_max_uses_error({}, { locale });
		return;
	}
	creating = true;
	createError = "";
	try {
		const created = await sdk.space(spaceId).invitations.create({
			role,
			ttlSeconds: ttlDays === 0 ? null : ttlDays * 24 * 60 * 60,
			maxUses: uses || undefined,
		});
		items = [created, ...items.filter((item) => item.id !== created.id)];
		createOpen = false;
		flashNotice(
			(await copyLink(created.token))
				? m.space_invite_copied({}, { locale })
				: m.space_invite_created({}, { locale }),
		);
	} catch (err) {
		createError =
			err instanceof Error && err.message
				? err.message
				: m.space_failed_invite_create({}, { locale });
	} finally {
		creating = false;
	}
}

async function revoke(invitation: SpaceInvitation) {
	if (!window.confirm(m.space_revoke_confirm({}, { locale }))) return;
	listError = "";
	try {
		await sdk.space(spaceId).invitations.revoke(invitation.token);
		items = showInactive
			? items.map((item) =>
					item.id === invitation.id ? { ...item, status: "revoked" } : item,
				)
			: items.filter((item) => item.id !== invitation.id);
	} catch (err) {
		listError =
			err instanceof Error && err.message
				? err.message
				: m.space_failed_invite_revoke({}, { locale });
	}
}

function statusLabel(invitation: SpaceInvitation) {
	switch (invitation.status) {
		case "active":
			return formatInviteExpiry(invitation.expiresInSeconds, locale);
		case "revoked":
			return m.space_revoke({}, { locale });
		case "exhausted":
			return m.space_exhausted({}, { locale });
		case "expired":
			return m.space_invite_expired({}, { locale });
	}
}

function usesLabel(invitation: SpaceInvitation) {
	const count = invitation.useCount;
	const uses =
		count === 1
			? m.space_uses_one({ count }, { locale })
			: m.space_uses_many({ count }, { locale });
	return invitation.maxUses ? `${uses} / ${invitation.maxUses}` : uses;
}
</script>

<div class="border-t border-border-subtle py-6">
	<div class="flex items-center justify-between gap-3">
		<h2 class="text-[13px] font-medium text-text-primary">{m.space_invite_links({}, { locale })}{#if !nextCursor} <span class="font-normal text-text-tertiary">· {m.space_active({ count: activeCount }, { locale })}</span>{/if}</h2>
		<button type="button" onclick={() => (showInactive = !showInactive)} class="inline-flex h-7 items-center rounded-[5px] px-2 text-[11px] text-text-tertiary transition-colors hover:bg-bg-hover hover:text-text-secondary">{showInactive ? m.space_invite_hide_inactive({}, { locale }) : m.space_invite_show_inactive({}, { locale })}</button>
	</div>
	{#if notice}<div class="mt-3 rounded-md border border-success-soft/30 bg-success-bg px-3 py-2 text-[12px] text-success-soft">{notice}</div>{/if}
	{#if listError}<div class="mt-3 rounded-md border border-error-soft/30 bg-error-bg px-3 py-2 text-[12px] break-words text-error-soft">{listError}</div>{/if}
	{#if items.length === 0}
		{#if !loading}<p class="mt-3 text-[12px] text-text-tertiary">{m.space_no_invite_links({}, { locale })}</p>{/if}
	{:else}
		<div class="mt-3 divide-y divide-border-subtle rounded-md border border-border-subtle">
			{#each items as invitation (invitation.id)}
				{@const active = invitation.status === "active"}
				<div class="flex items-center justify-between gap-3 px-3 py-2.5" class:opacity-60={!active}>
					<div class="min-w-0 flex-1">
						<div class="flex flex-wrap items-center gap-2">
							<span class="tag">{spaceRoleLabel(invitation.role, locale)}</span>
							<span class="text-[11px] text-text-tertiary">{usesLabel(invitation)}</span>
						</div>
						<div class="mt-0.5 text-[11px] text-text-placeholder">{statusLabel(invitation)}</div>
					</div>
					{#if active}
						<div class="flex shrink-0 items-center gap-0.5">
							<button type="button" title={m.space_copy_invite({}, { locale })} aria-label={m.space_copy_invite({}, { locale })} onclick={() => void copyLink(invitation.token)} class="inline-flex h-8 w-8 items-center justify-center rounded-[5px] text-text-tertiary transition-colors hover:bg-bg-hover hover:text-text-primary">{#if copiedToken === invitation.token}<Check class="h-3.5 w-3.5 text-status-running" />{:else}<Copy class="h-3.5 w-3.5" />{/if}</button>
							<button type="button" title={m.space_revoke_invite({}, { locale })} aria-label={m.space_revoke_invite({}, { locale })} onclick={() => void revoke(invitation)} class="inline-flex h-8 w-8 items-center justify-center rounded-[5px] text-text-tertiary transition-colors hover:bg-error-bg hover:text-error-soft"><Trash2 class="h-3.5 w-3.5" /></button>
						</div>
					{/if}
				</div>
			{/each}
		</div>
		{#if nextCursor}
			<button type="button" disabled={loading} onclick={() => void load(nextCursor)} class="mt-2 inline-flex h-7 items-center gap-1.5 rounded-[5px] px-2 text-[11px] text-text-tertiary transition-colors hover:bg-bg-hover hover:text-text-secondary disabled:opacity-50">{#if loading}<Loader2 class="h-3 w-3 animate-spin" />{/if}{m.space_invite_load_more({}, { locale })}</button>
		{/if}
	{/if}
</div>

<Sheet open={createOpen} onClose={() => (createOpen = false)} maxWidth="400px">
	<div class="p-5 pb-safe">
		<div class="mb-4 flex items-start justify-between gap-3">
			<div>
				<h3 class="text-[15px] font-medium text-text-primary">{m.space_create_invite({}, { locale })}</h3>
				<p class="mt-1 text-[12px] text-text-tertiary">{m.space_access_share({}, { locale })}</p>
			</div>
			<button type="button" onclick={() => (createOpen = false)} class="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-[5px] text-text-tertiary transition-colors hover:bg-bg-hover hover:text-text-secondary" aria-label={m.space_close({}, { locale })}><X class="h-4 w-4" /></button>
		</div>
		{#if createError}<div class="mb-3 rounded-md border border-error-soft/30 bg-error-bg px-3 py-2 text-[12px] break-words text-error-soft">{createError}</div>{/if}
		<div class="space-y-3">
			<div>
				<label class="mb-1.5 block text-[12px] text-text-tertiary" for="invite-role">{m.space_role_label({}, { locale })}</label>
				<select id="invite-role" bind:value={role} class={FIELD}>
					<option value="builder">{m.space_role_builder({}, { locale })}</option>
					<option value="guest">{m.space_role_guest({}, { locale })}</option>
					<option value="host">{m.space_role_host({}, { locale })}</option>
				</select>
			</div>
			<div>
				<label class="mb-1.5 block text-[12px] text-text-tertiary" for="invite-ttl">{m.space_valid_for({}, { locale })}</label>
				<select id="invite-ttl" bind:value={ttlDays} class={FIELD}>
					{#each TTL_DAYS as days (days)}
						<option value={days}>{days === 1 ? m.space_day({ count: days }, { locale }) : m.space_days({ count: days }, { locale })}</option>
					{/each}
					<option value={0} disabled={role === "host"}>{m.space_no_expiry({}, { locale })}</option>
				</select>
				{#if role === "host"}<p class="mt-1.5 text-[11px] text-text-placeholder">{m.space_invite_host_expiry({}, { locale })}</p>{/if}
			</div>
			<div>
				<label class="mb-1.5 block text-[12px] text-text-tertiary" for="invite-max-uses">{m.space_max_uses({}, { locale })} <span class="text-text-placeholder">{m.space_max_uses_hint({}, { locale })}</span></label>
				<input id="invite-max-uses" type="number" bind:value={maxUses} min="0" max={MAX_USES} step="1" class={FIELD} />
			</div>
		</div>
		<div class="mt-5 flex justify-end gap-2">
			<button type="button" onclick={() => (createOpen = false)} class="inline-flex h-9 items-center rounded-[5px] px-3 text-[12px] text-text-tertiary transition-colors hover:bg-bg-hover hover:text-text-secondary">{m.common_cancel({}, { locale })}</button>
			<button type="button" onclick={() => void create()} disabled={creating} class="primary-key h-9 gap-1.5 px-4 text-[12px]">{#if creating}<Loader2 class="h-3.5 w-3.5 animate-spin" /> {m.space_invite_creating({}, { locale })}{:else}<Link class="h-3.5 w-3.5" /> {m.space_invite_create_link({}, { locale })}{/if}</button>
		</div>
	</div>
</Sheet>
