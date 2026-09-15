<script lang="ts">
import type {
	SessionRecord,
	SpaceRecord,
	UserSessionListItem,
	UserSessionSourceKey,
} from "@neta-art/cohub";
import { onDestroy, onMount, untrack } from "svelte";
import { goto } from "$app/navigation";
import { resolveAppEntryRoute } from "$lib/app-entry";
import {
	createSessionChatHost,
	subscribeSpaceChannel,
} from "$lib/features/session-chat";
import SessionConversationPanel from "$lib/features/sessions/SessionConversationPanel.svelte";
import UserSessionsList from "$lib/features/sessions/UserSessionsList.svelte";
import { createUserSessionListController } from "$lib/features/sessions/user-session-list-controller.svelte";
import {
	type WindowRef,
	withWindowParam,
} from "$lib/features/space/modules/window-route";
import { DESKTOP_SHELL_MIN_WIDTH_PX } from "$lib/layout/breakpoints";
import { sdk } from "$lib/sdk";
import {
	buildSessionsRoute,
	buildSpaceSessionRoute,
	buildUserSessionRoute,
	buildUserSessionTurnRoute,
} from "$lib/space-routes";
import { createSpaceWorkspaceAssetResolver } from "$lib/space-workspace-assets";
import { authStore } from "$lib/stores/auth.svelte";
import {
	clearLastUserSessionId,
	getLastUserSessionId,
	setLastUserSessionId,
} from "$lib/stores/last-user-session";
import { modelsCatalogStore } from "$lib/stores/models-catalog.svelte";
import {
	fetchSpaceListWithCache,
	getCachedSpaceList,
} from "$lib/stores/space-list-cache";
import {
	type ResolveWorkspaceAsset,
	WorkspaceAssetAccessError,
} from "$lib/workspace-assets";
import type { WorkspaceFileLinkTarget } from "$lib/workspace-file-links";

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

// Scheduled prompts and channel bots flood the cross-space inbox; default to
// human web chats so the list opens on real conversations.
const DEFAULT_SOURCE_KEYS: readonly UserSessionSourceKey[] = ["web"];
const list = createUserSessionListController({ source: DEFAULT_SOURCE_KEYS });

let sourceFilter = $state<readonly UserSessionSourceKey[]>(DEFAULT_SOURCE_KEYS);

function setSourceFilter(next: UserSessionSourceKey[]) {
	sourceFilter = next;
	void list.setSource(next);
}

/** Mutable space identity for host environment ports (set before syncContext). */
const spaceBox = { current: "" as string };
type ConnectionState =
	| "idle"
	| "connecting"
	| "reconnecting"
	| "open"
	| "closed"
	| "error";

const connectionBox: { current: ConnectionState } = { current: "idle" };
let hasOpenedOnce = false;

/**
 * Workspace asset resolver for the cross-space sessions page. The active space
 * changes with the selected session, so the resolver is rebuilt per space.
 */
let workspaceAssetResolverKey = "";
let workspaceAssetResolver: ResolveWorkspaceAsset | null = null;

function chatWorkspaceAssetResolver(): ResolveWorkspaceAsset {
	const spaceId = spaceBox.current;
	if (!spaceId) throw new WorkspaceAssetAccessError();
	if (spaceId !== workspaceAssetResolverKey) {
		workspaceAssetResolverKey = spaceId;
		workspaceAssetResolver = createSpaceWorkspaceAssetResolver(spaceId);
	}
	return workspaceAssetResolver as ResolveWorkspaceAsset;
}

function resolveOpenPathTarget(
	target: string | WorkspaceFileLinkTarget,
): string | null {
	if (typeof target === "string") {
		const trimmed = target.trim();
		return trimmed || null;
	}
	if (target && typeof target === "object" && "path" in target) {
		const path = String((target as { path?: unknown }).path ?? "").trim();
		return path || null;
	}
	return null;
}

const sessionChat = createSessionChatHost({
	openPath: async (target) => {
		const spaceId = spaceBox.current;
		const path = resolveOpenPathTarget(target);
		const sessionId = sessionChat.activeSessionId;
		if (!spaceId || !path || !sessionId) return;
		const preview: WindowRef = { kind: "file", key: path };
		const href = withWindowParam(
			buildSpaceSessionRoute(spaceId, sessionId),
			null,
			preview,
		);
		await goto(href);
	},
	resolveWorkspaceAsset: (path, options) =>
		chatWorkspaceAssetResolver()(path, options),
	router: {
		toSession: async (sessionId, opts) => {
			// Mobile chats open in the space workspace; desktop stays on /sessions/:id.
			if (!isDesktop && spaceBox.current) {
				await goto(buildSpaceSessionRoute(spaceBox.current, sessionId), {
					replaceState: opts?.replace ?? true,
					keepFocus: true,
					noScroll: true,
				});
				return;
			}
			await goto(buildUserSessionRoute(sessionId), {
				replaceState: opts?.replace ?? true,
				keepFocus: true,
				noScroll: true,
			});
		},
		toTurn: async (sessionId, sequence) => {
			// Stay on /sessions/* — do not navigate into the space workspace.
			await goto(buildUserSessionTurnRoute(sessionId, sequence), {
				replaceState: true,
				keepFocus: true,
				noScroll: true,
			});
		},
		toNewSession: async () => {
			await handleNewChat();
		},
	},
	getConnectionState: () => connectionBox.current,
	hasSpace: () => Boolean(spaceBox.current),
});

let isDesktop = $state(true);
let viewportReady = $state(false);
/** Resolved space for the active /sessions/new draft (null off that route). */
let draftSpace = $state<SpaceRecord | null>(null);
let draftSpaceLookupSeq = 0;
/** Skip one desktop auto-restore after bouncing from a bad /sessions/new URL. */
let suppressNextAutoOpen = false;
let openingNewChat = false;
let unsubscribeCache: (() => void) | null = null;
let unsubscribeRealtime: (() => void) | null = null;
let openSeq = 0;
/** Session ids that failed to open this page visit — skip on auto-select. */
const failedOpenIds = new Set<string>();

const routeSessionId = $derived(data.sessionId ?? null);
const routeIsNew = $derived(Boolean(data.isNew));
const routeSpaceId = $derived(data.spaceId?.trim() || null);
const routeTurnSequence = $derived.by(() => {
	const value = data.turnSequence;
	if (!value) return null;
	const sequence = Number(value);
	return Number.isFinite(sequence) && sequence > 0
		? Math.floor(sequence)
		: null;
});
const activeSeed = $derived(
	routeSessionId ? list.findById(routeSessionId) : null,
);

function updateViewport() {
	isDesktop = window.innerWidth >= DESKTOP_SHELL_MIN_WIDTH_PX;
}

function isCurrentOpen(seq: number, sessionId: string | null) {
	return seq === openSeq && (data.sessionId ?? null) === sessionId;
}

function accessForSessions() {
	return {
		spaceLoadError: "",
		spaceHasMinimalAccess: false,
		canCreateSession: true,
		bootstrapping: false,
	};
}

async function openChatSession(input: {
	spaceId: string;
	sessionId: string;
	session?: SessionRecord | null;
	turnSequence?: number | null;
}) {
	const { spaceId, sessionId, session, turnSequence = null } = input;
	spaceBox.current = spaceId;
	sessionChat.enterSpace(spaceId);
	if (session) {
		sessionChat.upsertSessionRecord(session);
	}
	sessionChat.syncContext({
		spaceId,
		route: { kind: "session", sessionId, turnSequence },
		access: accessForSessions(),
	});
}

function openNewChatDraft(spaceId: string, opts?: { focus?: boolean }) {
	const alreadyOpen =
		spaceBox.current === spaceId && sessionChat.isNewSessionRoute;
	spaceBox.current = spaceId;
	sessionChat.enterSpace(spaceId);
	sessionChat.syncContext({
		spaceId,
		route: { kind: "new" },
		access: accessForSessions(),
	});
	// Focus only on first enter / space change — not on every effect re-run.
	if (opts?.focus !== false && !alreadyOpen) {
		requestAnimationFrame(() => {
			window.dispatchEvent(new CustomEvent("cohub:composer-focus"));
		});
	}
}

function clearChatSession() {
	// Soft clear: keep space lease if any, only drop active session route.
	// Host enterSpace("") is used when leaving the page entirely (dispose).
	const spaceId = spaceBox.current;
	sessionChat.syncContext({
		spaceId: spaceId || "",
		route: { kind: "none" },
		access: accessForSessions(),
	});
}

function openNewChatSpacePicker() {
	window.dispatchEvent(
		new CustomEvent("cohub:open-command-palette", {
			detail: {
				title: "New chat in…",
				query: "a: ",
				placeholder: "Search spaces…",
				refreshSpaces: true,
				intent: "new-chat",
			},
		}),
	);
}

function resolveSpaceFromCache(spaceId: string): SpaceRecord | null {
	return getCachedSpaceList()?.find((space) => space.id === spaceId) ?? null;
}

function clearDraftSpace() {
	draftSpace = null;
	draftSpaceLookupSeq += 1;
}

/**
 * Resolve draft space metadata. Returns null when the id is unknown so the
 * caller can bounce back to the picker instead of a hollow draft.
 */
async function ensureDraftSpace(spaceId: string): Promise<SpaceRecord | null> {
	if (draftSpace?.id === spaceId) return draftSpace;
	const cached = resolveSpaceFromCache(spaceId);
	if (cached) {
		draftSpace = cached;
		return cached;
	}
	const seq = ++draftSpaceLookupSeq;
	try {
		const spaces = await fetchSpaceListWithCache(
			async () => await sdk.spaces.list(),
		);
		if (seq !== draftSpaceLookupSeq) return null;
		const found = spaces.find((space) => space.id === spaceId) ?? null;
		draftSpace = found;
		return found;
	} catch (error) {
		if (seq !== draftSpaceLookupSeq) return null;
		console.warn("[sessions] failed to resolve draft space", error);
		return null;
	}
}

/** Leave a bad /sessions/new URL without racing desktop auto-restore. */
async function bounceNewChatToPicker() {
	suppressNextAutoOpen = true;
	clearDraftSpace();
	clearChatSession();
	await goto(buildSessionsRoute(), { replaceState: true });
	openNewChatSpacePicker();
}

async function selectSession(session: UserSessionListItem) {
	if (!isDesktop) {
		await goto(buildSpaceSessionRoute(session.spaceId, session.id));
		return;
	}
	await goto(buildUserSessionRoute(session.id), {
		keepFocus: true,
		noScroll: true,
	});
}

async function openRouteSession(sessionId: string | null) {
	const seq = ++openSeq;
	if (!sessionId) {
		if (isCurrentOpen(seq, null)) clearChatSession();
		return;
	}

	if (!isDesktop) {
		const known = list.findById(sessionId);
		if (known) {
			if (!isCurrentOpen(seq, sessionId)) return;
			await goto(buildSpaceSessionRoute(known.spaceId, sessionId), {
				replaceState: true,
			});
			return;
		}
		try {
			const detail = await sdk.user.getSession(sessionId);
			if (!isCurrentOpen(seq, sessionId)) return;
			await goto(buildSpaceSessionRoute(detail.session.spaceId, sessionId), {
				replaceState: true,
			});
		} catch (error) {
			if (!isCurrentOpen(seq, sessionId)) return;
			console.warn("[sessions] failed to resolve mobile session", error);
			await goto(buildSessionsRoute(), { replaceState: true });
		}
		return;
	}

	const turnSequence = routeTurnSequence;
	const known = list.findById(sessionId);
	if (known) {
		if (!isCurrentOpen(seq, sessionId)) return;
		await openChatSession({
			spaceId: known.spaceId,
			sessionId: known.id,
			session: known,
			turnSequence,
		});
		return;
	}

	try {
		const detail = await sdk.user.getSession(sessionId);
		if (!isCurrentOpen(seq, sessionId)) return;
		list.upsertSession({
			...detail.session,
			space: {
				id: detail.space.id,
				name: detail.space.name ?? detail.space.title ?? "Space",
				slug: detail.space.slug ?? null,
				publicProfile: detail.space.publicProfile ?? null,
			},
		});
		if (!isCurrentOpen(seq, sessionId)) return;
		await openChatSession({
			spaceId: detail.session.spaceId,
			sessionId: detail.session.id,
			session: detail.session,
			turnSequence,
		});
	} catch (error) {
		if (!isCurrentOpen(seq, sessionId)) return;
		console.warn("[sessions] failed to open session", error);
		failedOpenIds.add(sessionId);
		// Drop a stale remembered id so the next auto-select can fall back.
		const userUuid = authStore.userUuid;
		if (userUuid) clearLastUserSessionId(userUuid);
		const fallback =
			list.sessions.find(
				(session) => session.id !== sessionId && !failedOpenIds.has(session.id),
			) ?? null;
		if (fallback) {
			await goto(buildUserSessionRoute(fallback.id), {
				replaceState: true,
				keepFocus: true,
				noScroll: true,
			});
			return;
		}
		await goto(buildSessionsRoute(), { replaceState: true });
	}
}

async function handleNewChat() {
	if (openingNewChat) return;
	openingNewChat = true;
	try {
		// Prefer cached list so the picker opens instantly; refresh inside palette.
		const cached = getCachedSpaceList();
		if (cached?.length) {
			openNewChatSpacePicker();
			return;
		}

		// No local spaces: GET /default resolves (and ensures Home for empty accounts).
		// Avoid an extra list() RTT on cold empty accounts.
		const dest = await resolveAppEntryRoute();
		if (dest) {
			await goto(dest);
			return;
		}
		openNewChatSpacePicker();
	} finally {
		openingNewChat = false;
	}
}

function handleChangeDraftSpace() {
	openNewChatSpacePicker();
}

// Keep the left list in sync when host mutates the active session record.
// Untrack list reads/writes so upsertSession cannot re-enter this effect.
$effect(() => {
	const session = sessionChat.activeSession;
	if (!session) return;
	untrack(() => {
		const existing = list.findById(session.id);
		// Skip no-op writes (same title/updatedAt) to avoid churn.
		if (
			existing &&
			existing.title === session.title &&
			existing.updatedAt === session.updatedAt &&
			existing.lastMessageId === session.lastMessageId
		) {
			return;
		}
		const draft =
			draftSpace && draftSpace.id === session.spaceId ? draftSpace : null;
		list.upsertSession({
			...session,
			space:
				existing?.space ??
				(draft
					? {
							id: draft.id,
							name: draft.name ?? draft.title ?? "Space",
							slug: draft.slug ?? null,
							publicProfile: draft.publicProfile ?? null,
						}
					: null),
		} as UserSessionListItem);
	});
});

$effect(() => {
	const isNew = routeIsNew;
	const spaceId = routeSpaceId;
	const sessionId = routeSessionId;
	const turnSequence = routeTurnSequence;
	// openRouteSession / syncContext read list state and write chat host state.
	// Untrack to avoid effect_update_depth_exceeded.
	untrack(() => {
		if (isNew) {
			if (!spaceId) {
				// Missing ?space= — leave draft URL, suppress auto-open, re-pick.
				void bounceNewChatToPicker();
				return;
			}
			void (async () => {
				const space = await ensureDraftSpace(spaceId);
				// Route may have changed while the list was loading.
				if (!routeIsNew || routeSpaceId !== spaceId) return;
				if (!space) {
					void bounceNewChatToPicker();
					return;
				}
				openNewChatDraft(spaceId);
			})();
			return;
		}

		// Left the draft route — drop draft meta so it cannot leak into later chats.
		if (draftSpace) clearDraftSpace();

		// Same session + turn-only URL change: re-sync turn without reopening.
		if (
			sessionId &&
			sessionChat.activeSessionId === sessionId &&
			spaceBox.current
		) {
			sessionChat.syncContext({
				spaceId: spaceBox.current,
				route: { kind: "session", sessionId, turnSequence },
				access: accessForSessions(),
			});
			return;
		}
		void openRouteSession(sessionId);
	});
});

// Persist the last desktop selection so /sessions can restore it next visit.
$effect(() => {
	const sessionId = routeSessionId;
	const userUuid = authStore.userUuid;
	if (!sessionId || !userUuid || routeIsNew) return;
	setLastUserSessionId(userUuid, sessionId);
});

// Desktop /sessions with no sessionId shows an empty right pane — auto-open the
// last selected chat (fallback: most recent in list) so users skip a wasted click.
// Never steal focus from an explicit new-chat draft.
// Mobile keeps the list route; never redirect away from the inbox there.
$effect(() => {
	if (!viewportReady || !isDesktop) return;
	if (routeIsNew || routeSessionId) return;
	if (suppressNextAutoOpen) {
		suppressNextAutoOpen = false;
		return;
	}
	const userUuid = authStore.userUuid;
	const remembered = userUuid ? getLastUserSessionId(userUuid) : null;
	const rememberedOk =
		remembered && !failedOpenIds.has(remembered) ? remembered : null;
	const first =
		list.sessions.find((session) => !failedOpenIds.has(session.id)) ?? null;
	const targetId = rememberedOk ?? first?.id ?? null;
	if (!targetId) return;
	untrack(() => {
		void goto(buildUserSessionRoute(targetId), {
			replaceState: true,
			keepFocus: true,
			noScroll: true,
		});
	});
});

// One shared space room per active space (refcount with Space page if both open).
// New-chat draft has no session yet — subscribe once the first session id lands.
$effect(() => {
	const spaceId = sessionChat.spaceId;
	const sessionId = sessionChat.activeSessionId;
	if (!spaceId || !sessionId) return;
	return subscribeSpaceChannel(spaceId, (event) => {
		void sessionChat.ingestRealtimeEnvelope(event);
	});
});

onMount(() => {
	updateViewport();
	viewportReady = true;
	window.addEventListener("resize", updateViewport);
	unsubscribeCache = list.subscribeCache();
	unsubscribeRealtime = list.subscribeRealtime();
	void list.hydrateFromCache().then(() => list.refresh());
	void modelsCatalogStore.load().catch(() => undefined);

	// Real transport lifecycle (same signals Space uses via spaceRealtime).
	const disposeConnection = sdk.onConnection((snapshot) => {
		const state = (snapshot as { state?: ConnectionState }).state ?? "idle";
		const previous = connectionBox.current;
		connectionBox.current = state;
		if (state === "open") {
			sessionChat.onTransportOpen();
			const recovered =
				hasOpenedOnce &&
				(previous === "reconnecting" ||
					previous === "closed" ||
					previous === "error");
			hasOpenedOnce = true;
			if (recovered) sessionChat.onConnectionRecovered();
		}
	});

	const onVisible = () => {
		if (document.visibilityState === "visible") {
			void list.refresh({ force: true });
			sessionChat.onVisibilityChanged(true);
		} else {
			sessionChat.onVisibilityChanged(false);
		}
	};
	document.addEventListener("visibilitychange", onVisible);
	return () => {
		window.removeEventListener("resize", updateViewport);
		document.removeEventListener("visibilitychange", onVisible);
		disposeConnection?.();
	};
});

onDestroy(() => {
	unsubscribeCache?.();
	unsubscribeRealtime?.();
	sessionChat.dispose();
});
</script>

<svelte:head>
	<title>{routeIsNew ? "New chat · Cohub" : "Chats · Cohub"}</title>
</svelte:head>

<div class="flex h-full min-h-0 w-full overflow-hidden bg-bg-primary">
	{#if isDesktop || !routeIsNew}
		<div
			class="min-h-0 shrink-0 overflow-hidden border-r border-border-subtle"
			class:w-full={!isDesktop}
			class:w-[320px]={isDesktop}
			class:max-w-[360px]={isDesktop}
		>
			<UserSessionsList
				sessions={list.sessions}
				{sourceFilter}
				onSourceFilterChange={setSourceFilter}
				activeSessionId={isDesktop ? (routeIsNew ? null : routeSessionId) : null}
				loading={list.loading}
				loadingMore={list.loadingMore}
				refreshing={list.refreshing}
				error={list.error}
				hasMore={list.pageInfo.hasMore}
				{isDesktop}
				modelsCatalog={modelsCatalogStore.items ?? null}
				onSelect={(session) => {
					void selectSession(session);
				}}
				onLoadMore={() => {
					void list.loadMore();
				}}
				onNewChat={() => {
					void handleNewChat();
				}}
			/>
		</div>
	{/if}

	{#if isDesktop || routeIsNew}
		<div class="min-h-0 min-w-0 flex-1 overflow-hidden" class:w-full={!isDesktop}>
			<SessionConversationPanel
				host={sessionChat}
				seed={activeSeed}
				isNewDraft={routeIsNew}
				{draftSpace}
				onChangeSpace={handleChangeDraftSpace}
			/>
		</div>
	{/if}
</div>
