<script lang="ts">
import {
	HttpError,
	type SessionRecord,
	type UserSessionListItem,
} from "@neta-art/cohub";
import { onMount, untrack } from "svelte";
import { goto } from "$app/navigation";
import ThemeIsland from "$lib/custom-theme/ThemeIsland.svelte";
import ChatsPane from "$lib/features/sessions/ChatsPane.svelte";
import {
	chatsInbox,
	openNewChatSpacePicker,
	spaceSummaryOf,
} from "$lib/features/sessions/chats-inbox.svelte";
import { chatsWorkspaceScope } from "$lib/features/sessions/chats-workspace-scope";
import SpaceWorkspacePage from "$lib/features/space/SpaceWorkspacePage.svelte";
import { getLocale } from "$lib/i18n/locale.svelte";
import { useCompactShell } from "$lib/layout/compact-shell.svelte";
import { m } from "$lib/paraglide/messages.js";
import { sdk } from "$lib/sdk";
import {
	buildSessionsRoute,
	buildSpaceNewSessionRoute,
	buildSpaceSessionRoute,
	buildUserSessionRoute,
} from "$lib/space-routes";
import { authStore } from "$lib/stores/auth.svelte";
import {
	clearLastUserSessionId,
	getLastUserSessionId,
	setLastUserSessionId,
} from "$lib/stores/last-user-session";
import { forgetCachedSession } from "$lib/stores/session-detail-cache";

const {
	data,
}: {
	data: {
		sessionId?: string | null;
		turnSequence?: string | null;
		isNew?: boolean;
		spaceId?: string | null;
	};
} = $props();

const NEW_SESSION = "new";

const list = chatsInbox;
const locale = $derived(getLocale());
const isDesktop = $derived(!useCompactShell());

const routeSessionId = $derived(data.sessionId ?? null);
const routeIsNew = $derived(Boolean(data.isNew));
const routeSpaceId = $derived(data.spaceId?.trim() || null);

let target = $state<{ spaceId: string; sessionId: string } | null>(null);
let resolving = $state(false);
let resolveSeq = 0;
/** Skip one desktop auto-restore after bouncing from a bad /sessions/new URL. */
let suppressNextAutoOpen = false;
/** Session ids that failed to open this page visit — skip on auto-select. */
const failedOpenIds = new Set<string>();

const workspaceData = $derived(
	target
		? {
				spaceId: target.spaceId,
				view: "session" as const,
				sessionId: target.sessionId,
				turnSequence:
					target.sessionId === routeSessionId
						? (data.turnSequence ?? null)
						: null,
			}
		: null,
);
const showEmpty = $derived(
	!target && !resolving && !routeSessionId && !list.view.loading,
);

function isCurrent(seq: number) {
	return seq === resolveSeq;
}

function show(spaceId: string, sessionId: string) {
	if (target?.spaceId !== spaceId || target.sessionId !== sessionId) {
		target = { spaceId, sessionId };
	}
	resolving = false;
}

async function resolveSession(seq: number, sessionId: string) {
	const spaceId =
		list.findById(sessionId)?.spaceId ??
		(await lookupSessionSpace(seq, sessionId));
	if (!spaceId || !isCurrent(seq)) return;
	if (isDesktop) show(spaceId, sessionId);
	else await openInSpace(buildSpaceSessionRoute(spaceId, sessionId));
}

async function lookupSessionSpace(seq: number, sessionId: string) {
	resolving = true;
	const cached = await list.findLocal(sessionId);
	if (!isCurrent(seq)) return null;
	if (cached) {
		if (isDesktop) void confirmSession(seq, cached);
		return cached.spaceId;
	}
	try {
		return (await adoptServerSession(seq, sessionId))?.spaceId ?? null;
	} catch (error) {
		if (isCurrent(seq)) await leaveFailedSession(sessionId, error);
		return null;
	}
}

async function openInSpace(pathname: string) {
	const search = new URLSearchParams(window.location.search);
	search.delete("space");
	const query = search.toString();
	await goto(query ? `${pathname}?${query}` : pathname, { replaceState: true });
}

async function adoptServerSession(seq: number, sessionId: string) {
	const detail = await sdk.user.getSession(sessionId);
	if (!isCurrent(seq)) return null;
	const seed: UserSessionListItem = {
		...detail.session,
		space: spaceSummaryOf(detail.space),
	};
	list.upsertSession(seed);
	return seed;
}

async function confirmSession(seq: number, cached: SessionRecord) {
	try {
		await adoptServerSession(seq, cached.id);
	} catch (error) {
		// Only a definite 403/404 drops local data.
		const gone =
			error instanceof HttpError &&
			(error.status === 403 || error.status === 404);
		if (!gone) return;
		void forgetCachedSession(cached.spaceId, cached.id).catch(() => undefined);
		if (isCurrent(seq)) await leaveFailedSession(cached.id, error);
	}
}

async function leaveFailedSession(sessionId: string, error: unknown) {
	console.warn("[sessions] failed to open session", error);
	failedOpenIds.add(sessionId);
	resolving = false;
	if (target?.sessionId === sessionId) target = null;
	// Drop a stale remembered id so the next auto-select can fall back.
	const userUuid = authStore.userUuid;
	if (userUuid) clearLastUserSessionId(userUuid);
	const fallback = isDesktop
		? (list.sessions.find(
				(session) => session.id !== sessionId && !failedOpenIds.has(session.id),
			) ?? null)
		: null;
	await goto(
		fallback ? buildUserSessionRoute(fallback.id) : buildSessionsRoute(),
		{ replaceState: true, keepFocus: true, noScroll: true },
	);
}

async function bounceNewChatToPicker() {
	suppressNextAutoOpen = true;
	await goto(buildSessionsRoute(), { replaceState: true });
	openNewChatSpacePicker();
}

$effect(() => {
	const isNew = routeIsNew;
	const spaceId = routeSpaceId;
	const sessionId = routeSessionId;
	// Resizing must not tear down an open workspace; only routes resolve.
	untrack(() => {
		const seq = ++resolveSeq;
		if (isNew) {
			if (!spaceId) void bounceNewChatToPicker();
			else if (isDesktop) show(spaceId, NEW_SESSION);
			else void openInSpace(buildSpaceNewSessionRoute(spaceId));
			return;
		}
		if (sessionId) {
			void resolveSession(seq, sessionId);
			return;
		}
		resolving = false;
		if (!isDesktop) target = null;
	});
});

// Persist the last desktop selection so /sessions can restore it next visit.
$effect(() => {
	const sessionId = routeSessionId;
	const userUuid = authStore.userUuid;
	if (!sessionId || !userUuid || routeIsNew) return;
	setLastUserSessionId(userUuid, sessionId);
});

$effect(() => {
	if (!isDesktop || routeIsNew || routeSessionId) return;
	if (suppressNextAutoOpen) {
		suppressNextAutoOpen = false;
		return;
	}
	const userUuid = authStore.userUuid;
	const remembered = userUuid ? getLastUserSessionId(userUuid) : null;
	const targetId =
		(remembered && !failedOpenIds.has(remembered) ? remembered : null) ??
		list.sessions.find((session) => !failedOpenIds.has(session.id))?.id ??
		null;
	if (!targetId) return;
	untrack(() => {
		void goto(buildUserSessionRoute(targetId), {
			replaceState: true,
			keepFocus: true,
			noScroll: true,
		});
	});
});

onMount(() => list.retain());
</script>

<svelte:head>
	{#if !workspaceData}<title>Chats · Cohub</title>{/if}
</svelte:head>

{#if workspaceData}
	<ThemeIsland spaceId={workspaceData.spaceId}>
		<SpaceWorkspacePage data={workspaceData} scope={chatsWorkspaceScope} />
	</ThemeIsland>
{:else if !isDesktop}
	<div class="h-full min-h-0 w-full overflow-hidden bg-bg-primary">
		{#if !routeIsNew}
			<ChatsPane variant="page" />
		{/if}
	</div>
{:else if showEmpty}
	<div
		class="flex h-full min-h-0 flex-1 flex-col items-center justify-center gap-2 bg-chat-bg px-6 text-center"
	>
		<p class="text-[14px] text-text-secondary">{m.chat_select_chat({}, { locale })}</p>
		<p class="text-[12px] text-text-placeholder">
			{m.chat_no_selected_hint({}, { locale })}
		</p>
	</div>
{:else}
	<div class="h-full min-h-0 flex-1 bg-chat-bg"></div>
{/if}
