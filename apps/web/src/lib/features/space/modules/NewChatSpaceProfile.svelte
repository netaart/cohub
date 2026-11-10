<script lang="ts">
import type { ResourceAppKind, ResourceAppTarget } from "@cohub/protocol";
import type {
	CronJobRecord,
	SpaceMember,
	SpaceRecord,
	SpaceUsageResponse,
	SpaceWalletSummary,
	UserProfile,
} from "@neta-art/cohub";
import { ArrowRight } from "lucide-svelte";
import type { Snippet } from "svelte";
import { canViewSpaceCost } from "$lib/activity";
import SpaceAvatar from "$lib/components/SpaceAvatar.svelte";
import StatusGlyph, {
	type StatusGlyphMotion,
	type StatusGlyphTone,
} from "$lib/components/StatusGlyph.svelte";
import UserIdentity from "$lib/components/UserIdentity.svelte";
import { formatCurrency } from "$lib/i18n/format";
import { getLocale } from "$lib/i18n/locale.svelte";
import { m } from "$lib/paraglide/messages.js";
import { formatShortDateTime } from "$lib/resource-kit/time";
import type { SpaceAppsFeed } from "../resources/space-apps-feed.svelte";
import type { SpaceCronjobsFeed } from "../resources/space-cronjobs-feed.svelte";
import AppRow from "../side-panel/AppRow.svelte";
import CronjobRow from "../side-panel/CronjobRow.svelte";
import {
	displayUserName,
	formatTokenCount,
	formatUsageCost,
	sandboxStatusKind,
	sandboxStatusLabel,
} from "../space-utils";
import type { SpaceSandboxSnapshot } from "./space-status-controller.svelte";

const SANDBOX_GLYPH: Record<
	ReturnType<typeof sandboxStatusKind>,
	{ tone: StatusGlyphTone; motion?: StatusGlyphMotion; soft?: boolean }
> = {
	running: { tone: "success", motion: "slow" },
	waking: { tone: "activity", motion: "active" },
	sleeping: { tone: "muted", soft: true },
	unknown: { tone: "muted", soft: true },
	error: { tone: "error", soft: true },
};

type Props = {
	spaceId: string;
	space: SpaceRecord | null;
	members: SpaceMember[];
	usage: SpaceUsageResponse | null;
	wallet: SpaceWalletSummary | null;
	apps: SpaceAppsFeed | null;
	cronjobs: SpaceCronjobsFeed | null;
	sandbox: SpaceSandboxSnapshot | null;
	sandboxLoadedFor: string | null;
	expanded: boolean;
	canExpand: boolean;
	bodyMaxHeight: number;
	contentEl?: HTMLDivElement | null;
	bodyEl?: HTMLDivElement | null;
	onToggleExpanded: () => void;
	onOpenResource: (target: ResourceAppTarget) => void;
	onOpenResourceList: (kind: ResourceAppKind) => void;
};

const RECENT_LIMIT = 3;
/** Mirrors the mobile `nth-child` rule below. */
const MOBILE_RECENT_LIMIT = 2;

let {
	spaceId,
	space,
	members,
	usage,
	wallet,
	apps,
	cronjobs,
	sandbox,
	sandboxLoadedFor,
	expanded,
	canExpand,
	bodyMaxHeight,
	contentEl = $bindable(),
	bodyEl = $bindable(),
	onToggleExpanded,
	onOpenResource,
	onOpenResourceList,
}: Props = $props();

const locale = $derived(getLocale());

const usageText = $derived.by(() => {
	if (!usage) return "";
	const showCost = canViewSpaceCost(space?.access);
	const base = {
		days: usage.days,
		tokens: formatTokenCount(usage.summary.totalTokens),
		requests: usage.summary.requestCount,
	};
	const generation = usage.generation?.summary;
	if (!showCost) {
		return m.space_profile_usage_no_cost(
			{
				...base,
				generation: generation?.requestCount
					? m.space_profile_generation_no_cost(
							{ count: generation.requestCount },
							{ locale },
						)
					: "",
			},
			{ locale },
		);
	}
	return m.space_profile_usage(
		{
			...base,
			cost: formatUsageCost(usage.summary.costTotal, locale),
			generation: generation?.requestCount
				? m.space_profile_generation(
						{
							count: generation.requestCount,
							cost: formatUsageCost(generation.costTotal, locale),
						},
						{ locale },
					)
				: "",
		},
		{ locale },
	);
});
const walletText = $derived(
	wallet?.spaceId === spaceId && wallet.balanceUsd > 0
		? m.space_profile_wallet(
				{
					amount: formatCurrency(wallet.balanceUsd, "USD", {
						locale,
						maximumFractionDigits: 2,
					}),
				},
				{ locale },
			)
		: "",
);
const recentApps = $derived(apps?.ready ? apps.items : []);
const recentJobs = $derived(
	cronjobs?.ready
		? cronjobs.items.toSorted(
				(a, b) =>
					Number(b.enabled) - Number(a.enabled) ||
					b.updatedAt.localeCompare(a.updatedAt),
			)
		: ([] as CronJobRecord[]),
);
const spaceName = $derived(space?.name || space?.title || "Untitled space");
const owner = $derived(space?.ownerProfile ?? null);
const sortedMembers = $derived(
	[...members]
		.filter((member) => member.userId !== space?.userUuid)
		.sort(
			(a, b) =>
				a.role.localeCompare(b.role) || a.userId.localeCompare(b.userId),
		),
);

function userTitle(
	profile: UserProfile | null | undefined,
	userUuid: string | null | undefined,
) {
	return [displayUserName(profile, userUuid), userUuid]
		.filter(Boolean)
		.join(" · ");
}
</script>

<section class="new-chat-profile-panel pointer-events-auto mx-auto w-full max-w-4xl px-4 pt-[clamp(1.25rem,5dvh,2.5rem)] pb-4 sm:px-6 sm:pt-[clamp(2.25rem,7dvh,4.5rem)] sm:pb-6" class:expanded aria-label="Space profile">
	<div bind:this={contentEl} class="space-y-5 sm:space-y-7">
		<header class="new-chat-profile-fragment space-y-3.5 sm:space-y-4" style:animation-delay="20ms">
			<div class="flex items-start gap-3 sm:gap-4">
				<SpaceAvatar name={spaceName} profile={space?.publicProfile} seed={spaceId} size="lg" loading="eager" class="mt-0.5 h-10 w-10 rounded-[12px] sm:mt-1 sm:h-12 sm:w-12 sm:rounded-[14px]" />
				<div class="min-w-0 flex-1 pt-0.5">
					<div class="flex flex-wrap items-center gap-x-2 gap-y-1.5">
						<h1 class="min-w-0 max-w-full break-words text-[23px] font-semibold leading-[1.08] tracking-[-0.035em] text-text-primary sm:text-[34px]">{spaceName}</h1>
						{#if sandboxLoadedFor === spaceId}
							<StatusGlyph {...SANDBOX_GLYPH[sandboxStatusKind(sandbox)]} label={sandboxStatusLabel(sandbox)} class="translate-y-[0.02rem] [--status-glyph-size:0.48rem]" />
						{/if}
					</div>
					{#if space?.createdAt || walletText}
						<div class="mt-2 font-mono text-[10px] text-text-placeholder sm:text-[11px]">
							{#if space?.createdAt}Created {formatShortDateTime(space.createdAt)}{/if}
							{#if walletText}
								{#if space?.createdAt}<span aria-hidden="true"> · </span>{/if}
								<a href={`/spaces/${spaceId}/wallet`} class="transition-colors hover:text-text-secondary">{walletText}</a>
							{/if}
						</div>
					{/if}
				</div>
			</div>
		</header>

		<div bind:this={bodyEl} class="new-chat-profile-body new-chat-profile-fragment max-w-[68ch] text-[13px] leading-7 text-text-tertiary sm:text-[14px]" class:expanded style:animation-delay="55ms" style:max-height={expanded ? undefined : `${bodyMaxHeight}px`}>
			{#if space?.description}
				<p class="mb-3 text-text-secondary sm:text-[15px]">{space.description}</p>
			{/if}
			{#if owner || space?.userUuid || sortedMembers.length > 0}
				<p class="mb-3">
					{#if owner || space?.userUuid}
						<span>Created by </span>
						<UserIdentity
							name={displayUserName(owner, space?.userUuid)}
							avatarUrl={owner?.avatarUrl}
							seed={space?.userUuid}
							username={owner?.username}
							title={userTitle(owner, space?.userUuid)}
							size="xs"
							class="align-middle text-text-secondary"
							avatarClass="h-[18px] w-[18px] border-0 sm:h-5 sm:w-5"
							nameClass="min-w-0 max-w-[9rem] truncate font-medium text-text-primary sm:max-w-none"
						/>
					{/if}
					{#if sortedMembers.length > 0}
						<span>{owner || space?.userUuid ? " with " : "Members include "}</span>
						{#each sortedMembers as member, index (member.userId)}
							<UserIdentity
								name={displayUserName(member.profile, member.userId)}
								avatarUrl={member.profile.avatarUrl}
								seed={member.userId}
								username={member.profile.username}
								title={userTitle(member.profile, member.userId)}
								size="xs"
								class="align-middle text-text-secondary"
								avatarClass="h-[18px] w-[18px] border-0 sm:h-5 sm:w-5"
								nameClass="min-w-0 max-w-[9rem] truncate font-medium sm:max-w-none"
							/>{#if index < sortedMembers.length - 1}<span class="inline-block w-1.5 sm:w-2" aria-hidden="true"></span>{:else}<span>. </span>{/if}
						{/each}
					{:else}<span>. </span>{/if}
				</p>
			{/if}
			{#if usage}
				<p>{usageText}</p>
			{/if}
		</div>
		{#if canExpand}
			<button type="button" class="new-chat-profile-expand new-chat-profile-fragment mt-5 text-[12px] text-text-placeholder transition-colors hover:text-text-secondary sm:hidden" style:animation-delay="120ms" onclick={onToggleExpanded} aria-expanded={expanded}>
				{expanded ? m.space_profile_show_less({}, { locale }) : m.space_profile_show_full({}, { locale })}
			</button>
		{/if}
		{#if recentApps.length > 0 || recentJobs.length > 0}
			<div class="new-chat-profile-fragment grid grid-cols-2 gap-x-3 gap-y-5 sm:gap-x-8" style:animation-delay="90ms">
				{#if recentApps.length > 0}
					{@render recent(m.side_panel_tab_apps({}, { locale }), "app", recentApps.length, appRows)}
				{/if}
				{#if recentJobs.length > 0}
					{@render recent(m.side_panel_tab_scheduled({}, { locale }), "cronjob", recentJobs.length, jobRows)}
				{/if}
			</div>
		{/if}
	</div>
</section>

{#snippet appRows()}
	{#each recentApps.slice(0, RECENT_LIMIT) as app (app.id)}
		<AppRow {spaceId} {app} draggable onOpen={() => onOpenResource({ kind: "app", id: app.id })} />
	{/each}
{/snippet}

{#snippet jobRows()}
	{#each recentJobs.slice(0, RECENT_LIMIT) as job (job.id)}
		<CronjobRow {job} onOpen={() => onOpenResource({ kind: "cronjob", id: job.id })} />
	{/each}
{/snippet}

{#snippet recent(title: string, kind: ResourceAppKind, count: number, rows: Snippet)}
	<section class="min-w-0">
		<h2 class="mb-1 px-1.5 text-[11px] font-medium text-text-placeholder">{title}</h2>
		<div class="new-chat-recent-list -mx-0.5" role="list">{@render rows()}</div>
		{#if count > MOBILE_RECENT_LIMIT}
			<button type="button" class="mt-0.5 inline-flex h-7 items-center gap-1 rounded-[5px] px-1.5 text-[11px] text-text-tertiary transition-colors hover:bg-bg-hover hover:text-text-secondary {count <= RECENT_LIMIT ? 'sm:hidden' : ''}" onclick={() => onOpenResourceList(kind)}>
				{m.space_profile_view_all({ count }, { locale })}
				<ArrowRight class="h-3 w-3" />
			</button>
		{/if}
	</section>
{/snippet}

<style>
	@keyframes new-chat-profile-fragment-in {
		from {
			opacity: 0;
			transform: translateY(6px);
		}
		to {
			opacity: 1;
			transform: translateY(0);
		}
	}

	.new-chat-profile-fragment {
		animation: new-chat-profile-fragment-in 180ms var(--ease-out) both;
	}

	@media (prefers-reduced-motion: reduce) {
		.new-chat-profile-fragment {
			animation: none;
		}
	}

	@media (max-width: 639px) {
		.new-chat-profile-panel {
			max-height: 100%;
			overflow: hidden;
		}

		.new-chat-recent-list > :global(:nth-child(n + 3)) {
			display: none;
		}

		.new-chat-profile-body {
			overflow: hidden;
			transition: max-height 180ms var(--ease-out);
		}
	}
</style>
