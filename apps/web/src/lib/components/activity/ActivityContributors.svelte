<script lang="ts">
import type { SpaceActivityContributor } from "@neta-art/cohub";
import { formatCompact, formatCost } from "$lib/activity";
import UserAvatar from "$lib/components/UserAvatar.svelte";
import { getLocale } from "$lib/i18n/locale.svelte";
import { m } from "$lib/paraglide/messages.js";
import { formatCompactAbsoluteTime } from "$lib/time-format";

type Props = {
	items: SpaceActivityContributor[];
	memberCount: number;
	showCost: boolean;
};

const { items, memberCount, showCost }: Props = $props();

const locale = $derived(getLocale());
const displayName = (contributor: SpaceActivityContributor) =>
	contributor.profile?.displayName ||
	contributor.profile?.username ||
	m.activity_contributor_unknown({}, { locale });
</script>

<section class="border-b border-border-subtle py-7">
	<div class="mb-4 flex items-center justify-between">
		<h2 class="text-[13px] font-medium text-text-primary">{m.activity_contributors({}, { locale })}</h2>
		<span class="text-[10px] text-text-placeholder">{m.activity_member_count({ count: memberCount }, { locale })}</span>
	</div>
	{#if items.length}
		<ul class="flex flex-wrap gap-2">
			{#each items as contributor (contributor.userUuid)}
				<li
					class="flex items-center gap-2 rounded-full border border-border-subtle bg-bg-surface py-1 pl-1 pr-3"
					title={`${formatCompact(contributor.tokens, locale)} tokens · ${formatCompact(contributor.requests, locale)} requests${contributor.lastActiveAt ? ` · ${formatCompactAbsoluteTime(contributor.lastActiveAt)}` : ""}`}
				>
					<UserAvatar
						name={displayName(contributor)}
						avatarUrl={contributor.profile?.avatarUrl ?? null}
						seed={contributor.userUuid}
						size="xs"
					/>
					<span class="max-w-36 truncate text-[12px] text-text-secondary">{displayName(contributor)}</span>
					{#if contributor.role}
						<span class="rounded-sm bg-bg-hover px-1 py-px text-[10px] text-text-tertiary">{contributor.role}</span>
					{/if}
					<span class="font-mono text-[11px] text-text-placeholder">{formatCompact(contributor.tokens, locale)}</span>
					{#if showCost}
						<span class="font-mono text-[11px] text-text-placeholder">{formatCost(contributor.costTotal, locale)}</span>
					{/if}
				</li>
			{/each}
		</ul>
	{:else}
		<p class="text-[12px] text-text-placeholder">{m.activity_no_contributors({}, { locale })}</p>
	{/if}
</section>
