<script lang="ts">
import type { SpaceAppAccessItem } from "@neta-art/cohub";
import { Loader2, Trash2 } from "lucide-svelte";
import ListRowText from "#lib/components/list-page/ListRowText.svelte";
import { getLocale } from "#lib/i18n/locale.svelte.ts";
import { m } from "#lib/paraglide/messages.js";
import { sdk } from "#lib/sdk.ts";

const {
	spaceId,
	canManage,
	viewerUuid,
}: { spaceId: string; canManage: boolean; viewerUuid: string | null } =
	$props();

const locale = $derived(getLocale());
let items = $state<SpaceAppAccessItem[]>([]);
let error = $state("");
let revoking = $state<string | null>(null);
let loadVersion = 0;

$effect(() => {
	void load(spaceId);
});

async function load(target: string) {
	const version = ++loadVersion;
	try {
		const result = await sdk.space(target).appAccess.list();
		if (version === loadVersion) items = result.items;
	} catch {
		// Members without access to this list see nothing extra.
		if (version === loadVersion) items = [];
	}
}

async function revoke(item: SpaceAppAccessItem) {
	revoking = item.grantId;
	error = "";
	try {
		await sdk.space(spaceId).appAccess.revoke(item.grantId);
		items = items.filter((entry) => entry.grantId !== item.grantId);
	} catch (err) {
		error =
			err instanceof Error && err.message
				? err.message
				: m.space_app_access_revoke_failed({}, { locale });
	} finally {
		revoking = null;
	}
}
</script>

{#if items.length > 0}
	<div class="py-6">
		<h2 class="text-[13px] font-medium text-text-primary">
			{m.space_app_access({}, { locale })}
			<span class="font-normal text-text-tertiary">· {items.length}</span>
		</h2>
		<p class="mt-1 text-[12px] text-text-tertiary">
			{m.space_app_access_hint({}, { locale })}
		</p>
		<div class="mt-3 divide-y divide-border-subtle rounded-md border border-border-subtle">
			{#each items as item (item.grantId)}
				{@const name = item.app.title || item.app.slug}
				<div data-density="compact" class="flex h-[var(--list-row-height)] items-center gap-[var(--list-row-gap)] px-3">
					<ListRowText title={name} tooltip={name}>
						{#snippet subtitle()}
							<span class="truncate">{m.space_app_access_granted_by({ name: item.grantedBy.displayName }, { locale })} · <span class="font-mono">{item.scopes.join(", ")}</span></span>
						{/snippet}
					</ListRowText>
					{#if canManage || item.grantedBy.userUuid === viewerUuid}
						<button type="button" title={m.space_app_access_revoke({}, { locale })} aria-label={m.space_app_access_revoke({}, { locale })} disabled={revoking === item.grantId} onclick={() => void revoke(item)} class="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-[5px] text-text-tertiary transition-colors hover:bg-error-bg hover:text-error-soft disabled:opacity-40">
							{#if revoking === item.grantId}<Loader2 class="h-3.5 w-3.5 animate-spin" />{:else}<Trash2 class="h-3.5 w-3.5" />{/if}
						</button>
					{/if}
				</div>
			{/each}
		</div>
		{#if error}<p class="mt-2 text-[12px] text-error-soft break-words">{error}</p>{/if}
	</div>
{/if}
