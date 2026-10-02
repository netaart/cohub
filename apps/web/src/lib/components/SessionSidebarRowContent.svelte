<script lang="ts">
import type { SessionRecord } from "@neta-art/cohub";
import UserAvatar from "$lib/components/UserAvatar.svelte";
import { getLocale } from "$lib/i18n/locale.svelte";
import type { ModelCatalogItem } from "$lib/model-catalog";
import { m } from "$lib/paraglide/messages.js";
import { getSessionSidebarActivity } from "$lib/session-sidebar-activity";
import { getSessionActivityAt } from "$lib/session-sort";
import { authStore } from "$lib/stores/auth.svelte";
import { sessionGenerationStore } from "$lib/stores/session-generation.svelte";
import { unreadTracker } from "$lib/stores/session-state.svelte";
import { formatCompactAbsoluteTime } from "$lib/time-format";

const {
	session,
	title,
	isMobile = false,
	modelsCatalog,
	showSourceBadge = false,
}: {
	session: SessionRecord;
	title: string;
	isMobile?: boolean;
	modelsCatalog?: ModelCatalogItem[] | null;
	showSourceBadge?: boolean;
} = $props();

const locale = $derived(getLocale());

const activity = $derived(
	getSessionSidebarActivity(
		sessionGenerationStore.get(session.id),
		modelsCatalog,
		session.activeTurn,
	),
);
const badge = $derived(
	showSourceBadge && !activity.active ? sourceBadge(session.source) : "",
);
const participants = $derived(getSessionParticipants(session));
const visibleParticipants = $derived(
	getVisibleParticipants(participants, authStore.userUuid),
);
const participantLabel = $derived(
	getSessionParticipantLabel(visibleParticipants),
);
const activityTime = $derived(
	formatCompactAbsoluteTime(getSessionActivityAt(session)),
);
const isUnread = $derived(
	unreadTracker.isUnread(session, session.lastMessageId),
);
const shouldShowActivity = $derived(
	activity.active ||
		activity.phase === "failed" ||
		activity.phase === "interrupted",
);
const shouldShowSecondLine = $derived(
	visibleParticipants.length > 0 || shouldShowActivity,
);
const activityLabel = $derived(activity.label);
const activityText = $derived(activity.text);
const activityClass = $derived.by(() => {
	if (activity.phase === "failed") return "text-error-soft";
	if (activity.active) return "text-text-tertiary";
	return "text-text-placeholder";
});

function sourceBadge(source: string | null): string {
	if (!source || source === "web") return "";
	const idx = source.indexOf(":");
	return idx > 0 ? source.slice(0, idx) : source;
}

type Participant = {
	key: string;
	name: string;
	avatarUrl: string | null;
	username: string | null;
};

function getInitials(name: string) {
	return (
		name
			.split(/\s+/)
			.filter(Boolean)
			.slice(0, 2)
			.map((part) => part[0]?.toUpperCase() ?? "")
			.join("") || "?"
	);
}

function getSessionParticipants(session: SessionRecord): Participant[] {
	const participants: Participant[] = [];
	const seen = new Set<string>();
	const addProfile = (
		profile:
			| {
					userUuid?: string | null;
					username?: string | null;
					displayName?: string | null;
					avatarUrl?: string | null;
			  }
			| null
			| undefined,
	) => {
		const name = profile?.displayName?.trim();
		if (!name) return;
		const key = profile?.userUuid?.trim() || name.toLowerCase();
		if (seen.has(key)) return;
		seen.add(key);
		participants.push({
			key,
			name,
			avatarUrl: profile?.avatarUrl ?? null,
			username: profile?.username?.trim() || null,
		});
	};
	addProfile(session.userProfile);
	for (const profile of session.participantProfiles ?? []) addProfile(profile);
	return participants;
}

function getVisibleParticipants(
	participants: Participant[],
	currentUserUuid: string | null,
) {
	if (!currentUserUuid) return participants;
	// In shared sessions (other participants present) show the full group,
	// including the current user, so it's clear who is involved. In solo
	// sessions hide the current user's own avatar to keep the row clean.
	const hasOtherParticipants = participants.some(
		(participant) => participant.key !== currentUserUuid,
	);
	if (hasOtherParticipants) return participants;
	return participants.filter(
		(participant) => participant.key !== currentUserUuid,
	);
}

function getSessionParticipantLabel(participants: Participant[]) {
	if (participants.length === 0) return "";
	const visibleNames = participants
		.slice(0, 3)
		.map((participant) => participant.name);
	const remainingCount = participants.length - visibleNames.length;
	return `${visibleNames.join(", ")}${remainingCount > 0 ? ` +${remainingCount}` : ""}`;
}
</script>

<span class="min-w-0 flex flex-1 flex-col gap-0.5 overflow-hidden leading-tight">
	<span class="flex min-w-0 items-center gap-2">
		<span class="min-w-0 flex flex-1 items-center gap-1.5 overflow-hidden">
			<span class="min-w-0 truncate leading-4">{title}</span>
			{#if isUnread}
				<span class="h-1.5 w-1.5 shrink-0 rounded-full bg-brand/70" aria-label={m.sidebar_unread({}, { locale })}></span>
			{/if}
		</span>
		<span class="inline-flex min-w-0 shrink-0 items-center gap-1.5 group-hover/session:hidden group-focus-within/session:hidden">
			{#if badge}
				<span class="max-w-16 truncate rounded-[3px] bg-bg-hover-strong px-1.5 py-px text-[10px] font-medium leading-none text-text-tertiary" title={badge}>
					{badge}
				</span>
			{/if}
			<span class="shrink-0 tabular-nums text-[9.5px] font-normal leading-4 text-text-placeholder/70">{activityTime}</span>
		</span>
	</span>
	{#if shouldShowSecondLine}
		<span class="flex min-w-0 items-center gap-2 text-[10px] font-normal text-text-placeholder">
			{#if visibleParticipants.length > 0}
				<span class="inline-flex min-w-0 max-w-[60%] shrink-0 items-center gap-1.5 truncate" title={participantLabel}>
					<span class="inline-flex shrink-0 -space-x-1.5 opacity-80">
						{#each visibleParticipants.slice(0, 3) as participant (participant.key)}
							<UserAvatar name={participant.name} avatarUrl={participant.avatarUrl} size="xxs" class="h-3.5 w-3.5 border-bg-primary text-[7px]" />
						{/each}
					</span>
					<span class="min-w-0 truncate">{participantLabel}</span>
				</span>
			{/if}
			{#if shouldShowActivity}
				<span class="min-w-0 flex-1 truncate {activityClass}" title={activityText ? `${activityLabel} · ${activityText}` : activityLabel}>
					{activityLabel}{#if activityText} · {activityText}{/if}{#if activity.active}<span class="session-activity-caret">▍</span>{/if}
				</span>
			{/if}
		</span>
	{/if}
</span>

<style>
	.session-activity-caret {
		display: inline-block;
		margin-left: 0.0625rem;
		color: var(--color-brand);
		font-size: 0.82em;
		line-height: 1;
		animation: session-activity-caret 1.15s steps(2, jump-none) infinite;
	}

	@keyframes session-activity-caret {
		0%,
		45% {
			opacity: 1;
		}
		46%,
		100% {
			opacity: 0.28;
		}
	}

	@media (prefers-reduced-motion: reduce) {
		.session-activity-caret {
			animation: none;
			opacity: 0.85;
		}
	}
</style>
