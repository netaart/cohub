<script lang="ts">
/**
 * Desktop sessions host panel: space chrome header + full SessionChatPanel.
 * Also hosts the cross-space new-chat draft (explicit space context).
 */
import type { SpaceRecord, UserSessionListItem } from "@neta-art/cohub";
import { ArrowLeft, ArrowUpRight, ChevronDown } from "lucide-svelte";
import SpaceAvatar from "$lib/components/SpaceAvatar.svelte";
import {
	getSessionTitle,
	type SessionChatHost,
} from "$lib/features/session-chat";
import SessionChatPanel from "$lib/features/session-chat/SessionChatPanel.svelte";
import { getLocale } from "$lib/i18n/locale.svelte";
import { m } from "$lib/paraglide/messages.js";
import {
	buildSessionsRoute,
	buildSpaceNewSessionRoute,
	buildSpaceSessionRoute,
} from "$lib/space-routes";

const {
	host,
	seed = null,
	pending = false,
	isNewDraft = false,
	draftSpace = null,
	onChangeSpace,
}: {
	host: SessionChatHost;
	seed?: UserSessionListItem | null;
	pending?: boolean;
	isNewDraft?: boolean;
	draftSpace?: SpaceRecord | null;
	onChangeSpace?: () => void;
} = $props();

const locale = $derived(getLocale());

const session = $derived(host.activeSession ?? seed ?? null);
// Stay on draft chrome for the whole /sessions/new route, including the brief
// window after prompt adopts a session id but before URL replaces to /:id.
const isDraft = $derived(isNewDraft);
const title = $derived(
	isDraft
		? m.chat_new_chat({}, { locale })
		: session
			? getSessionTitle(session)
			: m.chat_title({}, { locale }),
);
const draftSpaceName = $derived(
	draftSpace?.name?.trim() || draftSpace?.title?.trim() || "",
);
const spaceName = $derived(
	isDraft
		? draftSpaceName || (host.spaceId ? "Space" : "")
		: seed?.space?.name?.trim() || (session ? "Space" : ""),
);
const spaceProfile = $derived(
	isDraft
		? (draftSpace?.publicProfile ?? null)
		: (seed?.space?.publicProfile ?? null),
);
const spaceHref = $derived(
	isDraft && host.spaceId
		? buildSpaceNewSessionRoute(host.spaceId)
		: session
			? buildSpaceSessionRoute(session.spaceId, session.id)
			: seed
				? buildSpaceSessionRoute(seed.spaceId, seed.id)
				: null,
);
const hasContent = $derived(Boolean(host.activeSessionId) || isDraft);
// Hide the empty-state hint once the first message is in flight / accepted.
const showDraftHint = $derived(
	isDraft && !host.activeSessionId && Boolean(spaceName),
);
</script>

<section class="flex h-full min-h-0 flex-col bg-chat-bg">
	{#if !hasContent}
		{#if !pending}
			<div
				class="flex flex-1 flex-col items-center justify-center gap-2 px-6 text-center"
			>
				<p class="text-[14px] text-text-secondary">{m.chat_select_chat({}, { locale })}</p>
				<p class="text-[12px] text-text-placeholder">
					{m.chat_no_selected_hint({}, { locale })}
				</p>
			</div>
		{/if}
	{:else}
		<header
			class="relative z-10 flex shrink-0 items-center gap-2 border-b border-chat-panel-border bg-chat-panel px-3 py-2.5 sm:px-4"
		>
			{#if isDraft}
				<a
					href={buildSessionsRoute()}
					class="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-[6px] text-text-tertiary transition-colors hover:bg-bg-hover hover:text-text-secondary sm:hidden"
					title={m.chat_back_to_chats({}, { locale })}
					aria-label={m.chat_back_to_chats({}, { locale })}
				>
					<ArrowLeft class="h-4 w-4" />
				</a>
			{/if}

			{#if isDraft}
				<button
					type="button"
					class="flex min-w-0 flex-1 items-center gap-2 rounded-[6px] px-1 py-0.5 text-left transition-colors hover:bg-bg-hover"
					onclick={() => onChangeSpace?.()}
					title={m.chat_change_space({}, { locale })}
					aria-label={spaceName
						? m.chat_new_chat_in_change_space({ space: spaceName }, { locale })
						: m.chat_choose_space({}, { locale })}
				>
					{#if spaceName}
						<SpaceAvatar name={spaceName} profile={spaceProfile} size="sm" />
					{/if}
					<div class="min-w-0 flex-1">
						<div class="truncate text-[13px] font-medium text-text-primary">
							{title}
						</div>
						<div
							class="flex min-w-0 items-center gap-1 text-[11px] text-text-placeholder"
						>
							<span class="truncate">
								{spaceName
									? m.chat_in_space({ space: spaceName }, { locale })
									: m.chat_choose_space_short({}, { locale })}
							</span>
							<ChevronDown class="h-3 w-3 shrink-0 opacity-70" />
						</div>
					</div>
				</button>
			{:else}
				{#if seed?.space || spaceName}
					<SpaceAvatar
						name={spaceName || seed?.space?.name || "Space"}
						profile={spaceProfile}
						size="sm"
					/>
				{/if}
				<div class="min-w-0 flex-1">
					<div class="truncate text-[13px] font-medium text-text-primary">
						{title}
					</div>
					{#if spaceName}
						<div class="truncate text-[11px] text-text-placeholder">
							{spaceName}
						</div>
					{/if}
				</div>
			{/if}

			{#if spaceHref}
				<a
					href={spaceHref}
					class="inline-flex h-7 shrink-0 items-center gap-1 rounded-[6px] px-2 text-[11px] text-text-tertiary transition-colors hover:bg-bg-hover hover:text-text-secondary"
					title={m.chat_open_in_space({}, { locale })}
				>
					{m.chat_open_in_space({}, { locale })}
					<ArrowUpRight class="h-3 w-3" />
				</a>
			{/if}
		</header>

		<div class="relative flex min-h-0 flex-1 flex-col overflow-hidden">
			{#if showDraftHint}
				<div
					class="pointer-events-none absolute inset-x-0 top-0 z-[1] flex justify-center px-6 pt-[min(10dvh,4.5rem)] sm:pt-[min(14dvh,6rem)]"
					aria-hidden="true"
				>
					<div class="max-w-md text-center">
						<p
							class="text-[15px] font-medium tracking-tight text-text-secondary"
						>
							{m.chat_new_chat_in_space({ space: spaceName }, { locale })}
						</p>
						<p class="mt-1 text-[12px] text-text-placeholder">
							{m.chat_draft_hint({}, { locale })}
						</p>
					</div>
				</div>
			{/if}
			<SessionChatPanel {host} />
		</div>
	{/if}
</section>
