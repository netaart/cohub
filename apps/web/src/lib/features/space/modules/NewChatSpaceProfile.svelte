<script lang="ts">
import type {
	SpaceMember,
	SpaceRecord,
	SpaceUsageResponse,
	UserProfile,
} from "@neta-art/cohub";
import { canViewSpaceCost } from "$lib/activity";
import SpaceAvatar from "$lib/components/SpaceAvatar.svelte";
import StatusGlyph, {
	type StatusGlyphMotion,
	type StatusGlyphTone,
} from "$lib/components/StatusGlyph.svelte";
import UserIdentity from "$lib/components/UserIdentity.svelte";
import { getLocale } from "$lib/i18n/locale.svelte";
import { m } from "$lib/paraglide/messages.js";
import {
	displayUserName,
	formatShortDateTime,
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
	waking: { tone: "brand", motion: "active" },
	sleeping: { tone: "muted", soft: true },
	unknown: { tone: "muted", soft: true },
	error: { tone: "error", soft: true },
};

type Props = {
	spaceId: string;
	space: SpaceRecord | null;
	members: SpaceMember[];
	usage: SpaceUsageResponse | null;
	sandbox: SpaceSandboxSnapshot | null;
	sandboxLoadedFor: string | null;
	expanded: boolean;
	canExpand: boolean;
	bodyMaxHeight: number;
	contentEl?: HTMLDivElement | null;
	bodyEl?: HTMLDivElement | null;
	onToggleExpanded: () => void;
};

let {
	spaceId,
	space,
	members,
	usage,
	sandbox,
	sandboxLoadedFor,
	expanded,
	canExpand,
	bodyMaxHeight,
	contentEl = $bindable(),
	bodyEl = $bindable(),
	onToggleExpanded,
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
					{#if space?.createdAt}
						<div class="mt-2 font-mono text-[10px] text-text-placeholder sm:text-[11px]">Created {formatShortDateTime(space.createdAt)}</div>
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
	</div>
</section>

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
		animation: new-chat-profile-fragment-in 180ms cubic-bezier(0.22, 1, 0.36, 1) both;
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

		.new-chat-profile-body {
			overflow: hidden;
			transition: max-height 180ms cubic-bezier(0.22, 1, 0.36, 1);
		}
	}
</style>
