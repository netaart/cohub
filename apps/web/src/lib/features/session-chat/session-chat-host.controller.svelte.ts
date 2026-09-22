/**
 * Full-capability session chat host.
 * Shell uses a small Handle surface; Panel uses the host as view-model.
 */
import {
	buildFileReferencesText,
	buildImageReferencesText,
	buildViewportContentBlock,
} from "@cohub/protocol";
import type { ContentBlock } from "@cohub/protocol/core";
import type { SpaceFsChangedPayload } from "@cohub/protocol/fs";
import type { GenerationContentBlock } from "@cohub/protocol/generation";
import type {
	SessionTurnIndexItem,
	SessionTurnRecord,
	StoredIntermediateMessage,
} from "@cohub/protocol/model";
import type { ChannelEnvelope } from "@cohub/protocol/realtime";
import {
	extractBillingPayload,
	HttpError,
	type SessionRecord,
} from "@neta-art/cohub";
import { tick, untrack } from "svelte";
import { classifyAccessError } from "$lib/access/access-state";
import type { SessionListForkRecord } from "$lib/cache/db";
import { getCacheUserKey } from "$lib/cache/keys";
import { sessionTurnsRepo } from "$lib/cache/repositories/session-turns-repo";
import { shouldRefreshAgentCatalogs } from "$lib/cache/space-fs-invalidation";
import { noteViewerActivity } from "$lib/command-palette/palette-overview";
import {
	buildComposerTextContentBlock,
	type ComposerFileAttachment,
	type ComposerImageAttachment,
	type ComposerTextAttachment,
} from "$lib/composer-attachments";
import {
	createPromptTemplateController,
	type PromptQuickAction,
} from "$lib/features/space/modules/prompt-template-controller.svelte";
import { createKeyedRouteRequestGuard } from "$lib/features/space/modules/route-request-guard";
import { createSkillController } from "$lib/features/space/modules/skill-controller.svelte";
import {
	cachedRuntimeStatus,
	refreshRuntimeStatus,
} from "$lib/features/space/runtime-status.svelte";
import { isStale } from "$lib/features/space/runtime-status-view";
import { asRecord } from "$lib/features/space/space-utils";
import { resolvePreferredGenerationModel } from "$lib/generation-model-catalog";
import { formatGenerationPolicyLabel } from "$lib/generation-policy-label";
import { extractSpaceMentionsFromText } from "$lib/mentions/space";
import {
	formatThinkingLevelShort,
	getRequestedThinkingLevel,
	type ModelThinkingLevel,
} from "$lib/model-catalog";
import { m } from "$lib/paraglide/messages.js";
import {
	uploadChatAttachmentFile,
	uploadChatAttachmentImage,
} from "$lib/public-asset-images";
import { sdk } from "$lib/sdk";
import { sortSessionsByRecentActivity } from "$lib/session-sort";
import type { TimelineItem } from "$lib/session-tree";
import { buildTurnTimelineItems } from "$lib/session-turn-render";
import type { NewChatComposerApplyPayload } from "$lib/space-config";
import { materializeSpaceEntries } from "$lib/space-upload";
import { authStore } from "$lib/stores/auth.svelte";
import {
	billingConversion,
	isBillingAccessBlockedCode,
} from "$lib/stores/billing-conversion.svelte";
import {
	readCreateModelPreference,
	saveCreateModelPreference,
} from "$lib/stores/create-model-preference";
import {
	readDraftSessionModel,
	saveDraftSessionModel,
} from "$lib/stores/draft-session-model";
import { modelsCatalogStore } from "$lib/stores/models-catalog.svelte";
import {
	readSessionComposerDraftText,
	removeSessionComposerDraftText,
	sessionComposerDraftKey,
	writeSessionComposerDraftText,
} from "$lib/stores/session-composer-drafts";
import { sessionGenerationStore } from "$lib/stores/session-generation.svelte";
import {
	buildStreamingStoredIntermediateMessages,
	clearCompletedIntermediateHandoff,
	clearGenerationError,
	completeGeneration,
	failGeneration,
	interruptGeneration,
	replaceGenerationTurnId,
	resetGeneration,
	startGenerationRequest,
} from "$lib/stores/session-generation-controller";
import { reconcileGenerationStateFromSessionList } from "$lib/stores/session-generation-list-reconcile";
import { isLiveTurnStatus } from "$lib/stores/session-generation-state";
import {
	fetchSessionListWithCache,
	getCachedSessionListSnapshot,
	patchCachedSessionList,
} from "$lib/stores/session-list-cache";
import { unreadTracker } from "$lib/stores/session-state.svelte";
import { mergeTurnsById } from "$lib/stores/turn-cache";
import {
	loadMessageToolCalls,
	loadTurnIntermediate,
} from "$lib/stores/turn-intermediate-cache";
import { turnRecordToIndexItem } from "$lib/turn-nav-preview";
import type { LocalUploadEntry } from "$lib/upload-entries";
import type { WorkspaceFileLinkTarget } from "$lib/workspace-file-links";
import {
	shouldClearActiveSessionForNewDraft,
	shouldClearResolvedNewSessionOnRoute,
} from "./new-chat-draft-isolation";
import {
	createSessionComposerController,
	revokeComposerAttachmentPreview,
} from "./session-composer-controller.svelte";
import { createSessionGenerationPolicyController } from "./session-generation-policy-controller.svelte";
import { createSessionGenerationRealtimeController } from "./session-generation-realtime-controller.svelte";
import {
	createSessionScrollController,
	isSessionScrollAnchorKind,
	isSessionScrollAnchorTurnLoaded,
	resolveSessionScrollAnchorTargetIndex,
	resolveSessionScrollRestore,
	type SessionScrollAnchor,
	type SessionScrollAnchorTarget,
	shouldFollowSessionTail,
} from "./session-scroll-controller.svelte";
import { createSessionShareController } from "./session-share-controller.svelte";
import { createSessionTaskController } from "./session-task-controller.svelte";
import { createSessionTurnLoadingController } from "./session-turn-loading-controller.svelte";
import {
	adoptPromptSessionState,
	areSessionTurnsEqual,
	getTurnClientMessageId,
	isOptimisticTurn,
	isSameClientMessageTurn,
	mergeComposerTurnSources,
	normalizeTurnDuplicates,
	preserveSessionTurnRefs,
	reconcileOptimisticTurn,
	resolveComposerSelectionFromTurn,
	resolveLastAgentTurnModel,
	resolveTurnHarness,
	type SessionComposerSelection,
	shouldClearComposerDraftAfterSend,
} from "./session-utils";
import {
	createSessionWorkspaceController,
	type SessionViewState,
} from "./session-workspace-controller.svelte";
import {
	acquireSpaceGeneration,
	releaseSpaceGeneration,
	setSpaceGenerationLastReleaseHandler,
} from "./space-generation-lease";
import { findCurrentTurnAnchorSequence } from "./turn-rail-markers";
import type {
	SelectedModel,
	SessionChatAccess,
	SessionChatContext,
	SessionChatEnvironment,
	SessionChatRoute,
} from "./types";
import {
	type ActiveViewportSource,
	type BoardViewportObservation,
	createViewportContextController,
} from "./viewport-context-controller.svelte";

const PRELOAD_THRESHOLD = 10;
const TURN_SCROLL_ANCHOR_OFFSET = 16;
const SESSION_INITIAL_LOADING_DELAY_MS = 160;
const SESSION_SCROLL_RESTORE_TIMEOUT_MS = 3000;
const SESSION_SCROLL_RESTORE_RETRY_DELAYS_MS = [40, 80, 160, 320];
// V1 used overlapping numeric ids; leave that raw key untouched for rollback.
const SESSION_SCROLL_ANCHOR_STORAGE_KEY = "cohub:session_scroll_anchor:v2";
const TERMINAL_GENERATION_STATUSES = new Set([
	"idle",
	"completed",
	"failed",
	"interrupted",
]);

export type SessionChatHostOptions = SessionChatEnvironment & {
	getConnectionState: () =>
		| "idle"
		| "connecting"
		| "reconnecting"
		| "open"
		| "closed"
		| "error";
	canManageSessionAccess?: () => boolean;
	hasSpace?: () => boolean;
};

// Wire generation store reset once for process-wide leases.
setSpaceGenerationLastReleaseHandler((spaceId) => {
	sessionGenerationStore.resetSpace(spaceId);
});

export function createSessionChatHost(options: SessionChatHostOptions) {
	let spaceId = $state("");
	let route = $state<SessionChatRoute>({ kind: "none" });
	let access = $state<SessionChatAccess>({
		spaceLoadError: "",
		spaceHasMinimalAccess: false,
		canCreateSession: false,
		bootstrapping: false,
	});
	let disposed = false;
	/** Space id this host currently holds a generation lease for (null if none). */
	let leasedSpaceId: string | null = null;

	function acquireGenerationLease(nextSpaceId: string) {
		if (!nextSpaceId || leasedSpaceId === nextSpaceId) return;
		if (leasedSpaceId) releaseSpaceGeneration(leasedSpaceId);
		acquireSpaceGeneration(nextSpaceId);
		leasedSpaceId = nextSpaceId;
	}

	function releaseGenerationLease() {
		if (!leasedSpaceId) return;
		releaseSpaceGeneration(leasedSpaceId);
		leasedSpaceId = null;
	}

	const isNewSessionRoute = $derived(route.kind === "new");
	const workspace = createSessionWorkspaceController();
	const composer = createSessionComposerController();
	const viewport = createViewportContextController();
	const scroll = createSessionScrollController();
	let sessionScrollAnchorsLoaded = $state(false);
	let scrollRestoreGeneration = $state(0);
	let tailReconcileGeneration = 0;
	let pageHideHandler: (() => void) | null = null;
	// Load before any route/bootstrap effect can prepare the first session.
	if (typeof window !== "undefined") {
		scroll.loadSessionScrollAnchors(SESSION_SCROLL_ANCHOR_STORAGE_KEY);
		sessionScrollAnchorsLoaded = true;
		pageHideHandler = () => {
			if (activeSessionId) captureCurrentScrollAnchor(activeSessionId);
			persistSessionScrollAnchorsNow();
		};
		window.addEventListener("pagehide", pageHideHandler);
	}
	const turnLoading = createSessionTurnLoadingController({
		getSpaceId: () => spaceId,
	});
	const tasks = createSessionTaskController();
	const generationPolicy = createSessionGenerationPolicyController({
		getActiveSessionId: () => workspace.activeSessionId,
	});
	const promptTemplatesCtrl = createPromptTemplateController({
		getSpaceId: () => spaceId,
	});
	const skillsCtrl = createSkillController({
		getSpaceId: () => spaceId,
	});
	const share = createSessionShareController({
		getSpaceId: () => spaceId,
		canManageAccess: () => options.canManageSessionAccess?.() ?? false,
	});

	const spaceSessions = $derived(workspace.spaceSessions);
	const sessionStateById = $derived(workspace.sessionStateById);
	const activeSessionId = $derived(workspace.activeSessionId);
	const loadingSessionIds = $derived(workspace.loadingSessionIds);
	const visibleInitialLoadingSessionIds = $derived(
		workspace.visibleInitialLoadingSessionIds,
	);

	let resolvedNewSessionId = $state<string | null>(null);
	const isDraftNewSessionRoute = $derived(
		isNewSessionRoute && !resolvedNewSessionId,
	);
	let createSessionError = $state("");
	let forkingTurnId = $state<string | null>(null);

	// Stable empty refs — fresh `{}` / `[]` each derived run re-triggers effects.
	const EMPTY_DRAFT_SESSION_STATE: SessionViewState = {
		session: undefined,
		turns: [],
		loading: false,
		loaded: true,
		error: null,
		hasMore: false,
		hasMoreNewer: false,
		loadingOlder: false,
		loadingNewer: false,
		oldestCursor: undefined,
	};
	const EMPTY_TIMELINE: TimelineItem[] = [];

	const draftSessionState = $derived<SessionViewState | null>(
		isDraftNewSessionRoute ? EMPTY_DRAFT_SESSION_STATE : null,
	);
	const activeSessionState = $derived(
		isDraftNewSessionRoute
			? draftSessionState
			: activeSessionId
				? (sessionStateById[activeSessionId] ?? null)
				: null,
	);
	const activeSessionInitialLoadingVisible = $derived.by(() =>
		Boolean(
			activeSessionId && visibleInitialLoadingSessionIds[activeSessionId],
		),
	);

	let activeComposerDraftKey = $state<string | null>(null);
	let composerDraftSaveTimer: ReturnType<typeof setTimeout> | null = null;
	let preserveComposerInputOnNextDraftKeyChange = false;
	const input = $derived(composer.input);
	const attachments = $derived(composer.attachments);
	const sending = $derived(composer.sending);
	const aborting = $derived(composer.aborting);
	const composerError = $derived(composer.error);
	const composerErrorCode = $derived(composer.errorCode);
	const nextComposerDraftKey = $derived.by(() => {
		if (sending && activeComposerDraftKey) return activeComposerDraftKey;
		if (isNewSessionRoute)
			return sessionComposerDraftKey(spaceId, { kind: "new" });
		if (activeSessionId) {
			return sessionComposerDraftKey(spaceId, {
				kind: "session",
				sessionId: activeSessionId,
			});
		}
		return null;
	});

	const modelsCatalog = $derived(modelsCatalogStore.items);
	const visibleModelsCatalog = $derived(modelsCatalogStore.visibleItems);
	const generationModelsCatalog = $derived(generationPolicy.modelsCatalog);
	let composerSelection = $state<SessionComposerSelection>({
		mode: "agent",
		model: null,
	});
	let harnessBySession = $state<Record<string, "cohub" | "pi" | "codex">>({});
	let localModelsBySession = $state<Record<string, SelectedModel | null>>({});
	const harnessSelectionKey = $derived(
		`${spaceId}:${activeSessionId ?? "draft"}`,
	);
	const composerAgentTurns = $derived.by(() =>
		mergeComposerTurnSources(
			activeSessionState?.turns ?? [],
			activeTurnIndex,
		).filter((turn) => turn.executionKind !== "direct_generation"),
	);
	const composerHarness = $derived(
		harnessBySession[harnessSelectionKey] ??
			resolveTurnHarness(composerAgentTurns.at(-1)),
	);
	const localModel = $derived.by(() => {
		const key = `${harnessSelectionKey}:${composerHarness}`;
		if (Object.hasOwn(localModelsBySession, key))
			return localModelsBySession[key] ?? null;
		const previous = [...composerAgentTurns]
			.reverse()
			.find(
				(turn) => resolveTurnHarness(turn) === composerHarness && turn.model,
			);
		return previous?.model && composerHarness !== "cohub"
			? { id: previous.model, provider: previous.provider ?? composerHarness }
			: null;
	});
	const runtimeCatalog = $derived(cachedRuntimeStatus(spaceId));
	async function loadRuntimeCatalog() {
		const targetSpaceId = spaceId;
		if (!targetSpaceId) return;
		try {
			await refreshRuntimeStatus(targetSpaceId);
		} catch {
			/* Local capabilities are optional; Cloud remains available. */
		}
	}
	$effect(() => {
		const target = spaceId;
		if (!target) return;
		void loadRuntimeCatalog();
		const refresh = () => {
			if (document.visibilityState === "visible") void loadRuntimeCatalog();
		};
		window.addEventListener("focus", refresh);
		return () => window.removeEventListener("focus", refresh);
	});
	const composerMode = $derived(composerSelection.mode);
	let createModelId = $state<string | null>(null);
	let createModelPreferenceRequest = 0;
	const activeSessionLastGenerationModelId = $derived.by(() => {
		const turns = mergeComposerTurnSources(
			activeSessionState?.turns ?? [],
			activeTurnIndex,
		)
			.filter(
				(turn) =>
					turn.executionKind === "direct_generation" &&
					typeof turn.model === "string" &&
					turn.model.trim(),
			)
			.sort((a, b) => a.sequence - b.sequence);
		return turns.at(-1)?.model ?? null;
	});
	const activeCreateModelId = $derived(
		composerSelection.mode === "create" && composerSelection.modelId
			? composerSelection.modelId
			: (activeSessionLastGenerationModelId ?? createModelId),
	);
	const activeCreateModelDeclaration = $derived.by(() => {
		const catalog = generationModelsCatalog ?? [];
		return resolvePreferredGenerationModel(catalog, activeCreateModelId);
	});
	const activeGenerationModel = $derived.by(() => {
		const model = activeCreateModelDeclaration;
		return model
			? {
					provider: "generation",
					id: model.model,
					name: model.title?.trim() || model.model,
				}
			: null;
	});
	const generationPolicyMode = $derived(generationPolicy.mode);
	const selectedGenerationModels = $derived(generationPolicy.selectedModels);
	const generationPolicyLabel = $derived(
		formatGenerationPolicyLabel({
			mode: generationPolicyMode,
			selectedModels: selectedGenerationModels,
			catalog: generationModelsCatalog,
		}),
	);
	const generationEnumSelections = $derived(generationPolicy.enumSelections);
	const generationNumericConstraints = $derived(
		generationPolicy.numericConstraints,
	);
	const generationBooleanConstraints = $derived(
		generationPolicy.booleanConstraints,
	);
	const promptTemplates = $derived(promptTemplatesCtrl.items);
	const promptTemplatesLoaded = $derived(promptTemplatesCtrl.loaded);
	const quickPromptActions = $derived(promptTemplatesCtrl.quickActions);
	const skills = $derived(skillsCtrl.items);
	const skillsLoaded = $derived(skillsCtrl.loaded);
	let showModelSelector = $state(false);
	let restoredComposerModeKey: string | null = null;
	let generationDraftSessionId = $state<string | null>(null);
	let sessionModelById = $state<Record<string, SelectedModel | null>>({});
	let sessionThinkingLevelById = $state<
		Record<string, ModelThinkingLevel | null>
	>({});
	let draftSessionModel = $state<SelectedModel | null>(null);
	let draftSessionModelManuallySelected = $state(false);
	let draftThinkingLevel = $state<ModelThinkingLevel | null>(null);

	$effect(() => {
		const authIdentity = authStore.loaded
			? `${authStore.isAuthenticated}:${authStore.userUuid ?? authStore.claims?.sub ?? "guest"}`
			: null;
		untrack(() => {
			const request = ++createModelPreferenceRequest;
			createModelId = null;
			if (!authIdentity) return;
			void readCreateModelPreference()
				.then((preference) => {
					if (
						request !== createModelPreferenceRequest ||
						preference.userKey !== getCacheUserKey()
					)
						return;
					createModelId = preference.modelId;
				})
				.catch(() => undefined);
		});
	});
	$effect(() => {
		const shouldLoad = authStore.loaded && composerMode === "create";
		const authIdentity = authStore.userUuid ?? authStore.claims?.sub ?? "guest";
		untrack(() => {
			if (shouldLoad && authIdentity) void loadGenerationModelsCatalog();
		});
	});
	$effect(() => {
		const sessionKey = activeSessionId ?? "new";
		const latestTurn = mergeComposerTurnSources(
			activeSessionState?.turns ?? [],
			activeTurnIndex,
		).at(-1);
		const modeKey = `${sessionKey}:${latestTurn?.id ?? "none"}:${latestTurn?.executionKind ?? "agent"}`;
		if (restoredComposerModeKey === modeKey) return;
		untrack(() => {
			restoredComposerModeKey = modeKey;
			if (activeSessionId && latestTurn) {
				composerSelection = resolveComposerSelectionFromTurn(
					latestTurn,
					visibleModelsCatalog,
				);
			}
		});
	});

	let composerHostEl = $state<HTMLDivElement | null>(null);
	let chatChromeEl = $state<HTMLDivElement | null>(null);
	const shouldAutoFollow = $derived(scroll.shouldAutoFollow);
	const composerHeight = $derived(scroll.composerHeight);
	const chatChromeHeight = $derived(scroll.chatChromeHeight);
	const listEl = $derived(scroll.listEl);
	const chatTimelineRef = $derived(scroll.chatTimelineRef);
	const turnIndexBySessionId = $derived(turnLoading.turnIndexBySessionId);
	const loadingTurnSequence = $derived(turnLoading.loadingTurnSequence);
	let currentTurnSequence = $state<number | null>(null);
	let highlightedTurnSequence = $state<number | null>(null);
	const turnMarkerPositions = $derived(scroll.turnMarkerPositions);
	const turnMarkerHeights = $derived(scroll.turnMarkerHeights);
	const timelineScrollTop = $derived(scroll.timelineScrollTop);
	const timelineScrollHeight = $derived(scroll.timelineScrollHeight);
	const timelineClientHeight = $derived(scroll.timelineClientHeight);
	let showTurnBottomSheet = $state(false);
	let appliedRouteTurnKey = $state<string | null>(null);
	let lastTurnIndexRefreshKey = "";
	let restoringBottomSessionId = $state<string | null>(null);
	let pendingTailReconcileSessionId = $state<string | null>(null);
	let programmaticScrollEpoch = 0;
	let programmaticScrollActive = false;
	let programmaticScrollTarget: number | null = null;
	let userScrollActive = false;
	let anchorRestoreRetryTimer: ReturnType<typeof setTimeout> | null = null;
	let anchorRestoreWaitStartedAt = 0;
	let anchorRestoreRetryStep = 0;
	let scrollCaptureFrame: number | null = null;
	const pendingRestoreSessionId = $derived(scroll.pendingRestoreSessionId);
	const activeAnchorRestore = $derived(scroll.activeAnchorRestore);
	const pendingTimelineMarkdownRenders = $derived(
		scroll.pendingTimelineMarkdownRenders,
	);

	const pendingFollowupActionIds = $derived(tasks.pendingFollowupActionIds);
	const scrollAnchorWindowLoads = new Set<string>();

	let refreshSessionsListInFlight: Promise<void> | null = null;
	let refreshSessionsListQueued = false;
	let refreshSessionsListQueuedForce = false;
	const turnHydrationInFlight = new Map<string, Promise<void>>();
	let reconnectSyncInFlight: Promise<void> | null = null;

	const viewportContexts = $derived(viewport.contexts);

	const firstCatalogModel = $derived(
		visibleModelsCatalog && visibleModelsCatalog.length > 0
			? {
					provider: visibleModelsCatalog[0].provider,
					id: visibleModelsCatalog[0].id,
					name: visibleModelsCatalog[0].model.name as string | undefined,
				}
			: null,
	);
	const EMPTY_TURN_INDEX: SessionTurnIndexItem[] = [];
	const activeTurnIndex = $derived.by(() =>
		activeSessionId
			? (turnIndexBySessionId[activeSessionId] ?? EMPTY_TURN_INDEX)
			: EMPTY_TURN_INDEX,
	);
	const activeSessionLastTurnModel = $derived.by(() =>
		resolveLastAgentTurnModel(
			mergeComposerTurnSources(
				activeSessionState?.turns ?? [],
				activeTurnIndex,
			),
			visibleModelsCatalog,
		),
	);
	const activeSessionLastRequestedThinkingLevel =
		$derived.by<ModelThinkingLevel | null>(() => {
			const lastPersistedTurn = [...(activeSessionState?.turns ?? [])]
				.filter((turn) => asRecord(turn.meta)?.optimistic !== true)
				.sort((a, b) => a.sequence - b.sequence)
				.at(-1);
			return getRequestedThinkingLevel(lastPersistedTurn?.meta);
		});
	const restoredSessionModel = $derived.by(() => {
		if (!activeSessionId) return draftSessionModel ?? firstCatalogModel;
		return (
			sessionModelById[activeSessionId] ??
			activeSessionLastTurnModel ??
			firstCatalogModel
		);
	});
	const activeSessionModel = $derived(
		composerSelection.mode === "agent" && composerSelection.model
			? composerSelection.model
			: restoredSessionModel,
	);
	// Explicit choices remain sticky across turns. Effective model defaults are
	// never promoted into a request, and a pending null explicitly resets to default.
	const activeSessionThinkingLevel = $derived.by<ModelThinkingLevel | null>(
		() => {
			if (!activeSessionId) return draftThinkingLevel;
			return Object.hasOwn(sessionThinkingLevelById, activeSessionId)
				? (sessionThinkingLevelById[activeSessionId] ?? null)
				: activeSessionLastRequestedThinkingLevel;
		},
	);
	const activeGenerationState = $derived.by(() =>
		sessionGenerationStore.get(activeSessionId),
	);
	const activeTurnRailItems = $derived.by<SessionTurnIndexItem[]>(() => {
		const bySequence = new Map<number, SessionTurnIndexItem>();
		for (const item of activeTurnIndex) bySequence.set(item.sequence, item);
		for (const turn of activeSessionState?.turns ?? []) {
			const item = turnRecordToIndexItem(turn);
			const existing = bySequence.get(turn.sequence);
			bySequence.set(turn.sequence, {
				...existing,
				...item,
				authorProfile: item.authorProfile ?? existing?.authorProfile ?? null,
				userUuid: item.userUuid ?? existing?.userUuid ?? null,
			});
		}
		return [...bySequence.values()].sort((a, b) => a.sequence - b.sequence);
	});
	const loadedTurnSequences = $derived.by(() =>
		(activeSessionState?.turns ?? [])
			.map((turn) => turn.sequence)
			.sort((a, b) => a - b),
	);
	const loadedMinTurnSequence = $derived(loadedTurnSequences.at(0) ?? null);
	const loadedMaxTurnSequence = $derived(loadedTurnSequences.at(-1) ?? null);
	const unloadedOlderTurnCount = $derived.by(() => {
		if (loadedMinTurnSequence == null) return 0;
		return activeTurnIndex.filter((t) => t.sequence < loadedMinTurnSequence)
			.length;
	});
	const unloadedNewerTurnCount = $derived.by(() => {
		if (loadedMaxTurnSequence == null) return 0;
		return activeTurnIndex.filter((t) => t.sequence > loadedMaxTurnSequence)
			.length;
	});
	const EMPTY_INTERMEDIATE_MESSAGES: ReturnType<
		typeof buildStreamingStoredIntermediateMessages
	> = [];
	const activeStreamingIntermediateMessages = $derived.by(() => {
		if (!activeGenerationState || !activeSessionId)
			return EMPTY_INTERMEDIATE_MESSAGES;
		return buildStreamingStoredIntermediateMessages({
			spaceId,
			sessionId: activeSessionId,
			turnId: activeGenerationState.turnId,
			intermediateMessages: activeGenerationState.intermediateMessages,
		});
	});
	const activeGenerationClientMessageId = $derived.by(() => {
		const turnId = activeGenerationState?.turnId;
		if (!turnId) return null;
		return getTurnClientMessageId(
			activeSessionState?.turns.find((turn) => turn.id === turnId) ??
				activeSessionState?.turns.find(
					(turn) => getTurnClientMessageId(turn) === turnId,
				) ?? { meta: null },
		);
	});
	const activeStreamError = $derived.by(
		() => activeGenerationState?.error ?? "",
	);
	const activeStreamErrorCode = $derived.by(
		() => activeGenerationState?.errorCode ?? null,
	);
	const composerNotice = $derived.by(() => activeStreamError || composerError);
	const composerShowsBillingAction = $derived(
		isBillingAccessBlockedCode(activeStreamErrorCode) ||
			isBillingAccessBlockedCode(composerErrorCode),
	);
	const activeSessionIsRunning = $derived.by(() =>
		Boolean(
			activeGenerationState &&
				!TERMINAL_GENERATION_STATUSES.has(activeGenerationState.status),
		),
	);
	const timeline = $derived.by<TimelineItem[]>(() => {
		const state = activeSessionState;
		if (!state) return EMPTY_TIMELINE;
		const streaming =
			activeGenerationState &&
			(activeGenerationState.status === "streaming" ||
				activeGenerationState.status === "pending" ||
				(activeGenerationState.status === "completed" &&
					activeStreamingIntermediateMessages.length > 0) ||
				!TERMINAL_GENERATION_STATUSES.has(activeGenerationState.status))
				? {
						sessionId: activeSessionId ?? "active",
						turnId: activeGenerationState.turnId ?? null,
						anchorUserMessageId:
							activeGenerationState.anchorUserMessageId ?? null,
						clientMessageId: activeGenerationClientMessageId,
						executionKind: activeSessionState?.turns.find(
							(turn) => turn.id === activeGenerationState.turnId,
						)?.executionKind,
						intermediateMessages: activeStreamingIntermediateMessages,
						contentBlocks: activeGenerationState.contentBlocks,
						finalizedPreview: activeGenerationState.finalizedPreview,
						status: activeGenerationState.status,
						runtimePhase: activeGenerationState.runtimePhase,
						runtimeProvider: activeGenerationState.runtimeProvider,
						runtimeModel: activeGenerationState.runtimeModel,
						lastPatchAt: activeGenerationState.lastPatchAt ?? null,
						startedAt: activeGenerationState.startedAt ?? null,
					}
				: null;
		if (state.turns.length === 0 && !streaming) return EMPTY_TIMELINE;
		return buildTurnTimelineItems({
			sessionId: activeSessionId,
			turns: state.turns,
			streaming,
		});
	});
	// Boolean view of timeline emptiness: recomputes per stream chunk, but its
	// value only flips when items appear or disappear, so effects keyed on it
	// stay stable during streaming.
	const hasTimelineItems = $derived(timeline.length > 0);
	const hasUnread = $derived.by(() => {
		const session = activeSessionState?.session;
		if (
			!session ||
			!activeSessionState?.loaded ||
			activeSessionState.turns.length === 0
		)
			return false;
		return unreadTracker.isUnread(session, session.lastMessageId);
	});

	const generationRealtime = createSessionGenerationRealtimeController({
		getSpaceId: () => spaceId,
		getConnectionState: () => options.getConnectionState(),
		getActiveSessionId: () => activeSessionId,
		hasExplicitScrollTarget: (sessionId) =>
			route.kind === "session" &&
			route.sessionId === sessionId &&
			route.turnSequence != null,
		getSessionState: (id) => sessionStateById[id],
		updateSessionState: (id, state) => {
			workspace.sessionStateById = { ...sessionStateById, [id]: state };
		},
		refreshSessionsList: (force) => refreshSessionsList(force ?? true),
		requestBottomFollow: (opts) => requestBottomFollow(opts),
		shouldAutoFollow: () => scroll.shouldAutoFollow,
		getListEl: () =>
			activeSessionId ? getSessionScrollList(activeSessionId) : null,
		captureCurrentScrollAnchor: (id) => captureCurrentScrollAnchor(id),
		getSessionScrollAnchor: (id) => getSessionScrollAnchor(id),
		areSessionScrollAnchorsEqual: (a, b) => areSessionScrollAnchorsEqual(a, b),
		restoreSessionScrollAnchorSoon: (id) => restoreSessionScrollAnchorSoon(id),
		isUserScrollActive: () => userScrollActive,
		syncGenerationStateFromTail: (id, turns, at) =>
			syncGenerationStateFromTail(id, turns, at),
		onRecovered: () => undefined,
		onExhausted: (sessionId) => {
			console.warn("[session-chat] recovery exhausted", {
				sessionId,
				spaceId,
			});
		},
	});

	function preferFollowupQueueTurn(
		current: SessionTurnRecord,
		incoming: SessionTurnRecord,
	) {
		if (isOptimisticTurn(current) && !isOptimisticTurn(incoming))
			return incoming;
		if (!isOptimisticTurn(current) && isOptimisticTurn(incoming))
			return current;
		return Date.parse(incoming.updatedAt) >= Date.parse(current.updatedAt)
			? incoming
			: current;
	}
	function dedupeFollowupQueueTurns(turns: SessionTurnRecord[]) {
		const byKey = new Map<string, SessionTurnRecord>();
		for (const turn of turns) {
			const clientMessageId = getTurnClientMessageId(turn);
			const key = clientMessageId
				? `client:${clientMessageId}`
				: `turn:${turn.id}`;
			const current = byKey.get(key);
			byKey.set(key, current ? preferFollowupQueueTurn(current, turn) : turn);
		}
		return [...byKey.values()].sort(
			(a, b) =>
				a.sequence - b.sequence || a.createdAt.localeCompare(b.createdAt),
		);
	}
	const followupQueue = $derived.by(() =>
		dedupeFollowupQueueTurns(
			(activeSessionState?.turns ?? []).filter(
				(turn) =>
					turn.status === "queued" &&
					turn.intent === "followup" &&
					turn.id !== activeGenerationState?.turnId,
			),
		),
	);

	$effect(() => {
		const key = nextComposerDraftKey;
		if (key === activeComposerDraftKey) return;
		untrack(() => {
			const previousKey = activeComposerDraftKey;
			const preserveInput = preserveComposerInputOnNextDraftKeyChange;
			preserveComposerInputOnNextDraftKeyChange = false;
			flushActiveComposerDraft();
			activeComposerDraftKey = key;
			if (preserveInput) {
				if (key) writeSessionComposerDraftText(key, composer.input);
				if (previousKey !== key) removeSessionComposerDraftText(previousKey);
				return;
			}
			composer.input = key ? readSessionComposerDraftText(key) : "";
		});
	});
	$effect(() => {
		const key = activeComposerDraftKey;
		const text = input;
		if (!key) return;
		clearComposerDraftSaveTimer();
		composerDraftSaveTimer = setTimeout(() => {
			writeSessionComposerDraftText(key, text);
			composerDraftSaveTimer = null;
		}, 400);
		return clearComposerDraftSaveTimer;
	});
	$effect(() => {
		if (isDraftNewSessionRoute) draftSessionModelManuallySelected = false;
	});
	$effect(() => {
		if (!isDraftNewSessionRoute) return;
		const catalog = visibleModelsCatalog;
		if (!catalog || catalog.length === 0) return;
		if (draftSessionModel) return;
		const stored = readDraftSessionModel();
		if (!stored) return;
		const catalogItem = catalog.find(
			(item) => item.provider === stored.provider && item.id === stored.id,
		);
		if (!catalogItem) return;
		draftSessionModel = {
			provider: catalogItem.provider,
			id: catalogItem.id,
			name: catalogItem.model.name as string | undefined,
		};
	});

	// ── Timeline lifecycle (scroll, restore, markers, generation) ──
	$effect(() => {
		const sessionId = activeSessionId;
		if (!sessionId) return;
		untrack(() => {
			void sessionGenerationStore
				.restore(spaceId, sessionId)
				.catch(() => undefined);
			void loadTurnIndex(sessionId);
		});
	});

	$effect(() => {
		if (!listEl || !hasTimelineItems) {
			scroll.clearTurnMarkers();
			return;
		}
		void tick().then(() => {
			updateCurrentTurnSequence();
			scroll.scheduleTurnMarkerMeasureThrottled();
		});
	});

	// Every measurement pass or cache clear bumps the version; recompute the
	// current turn from the (possibly empty) cache right after each bump.
	// Covers prepends, content reflows above the viewport, and emptied
	// timelines — none of which reliably fire a scroll event.
	$effect(() => {
		void scroll.turnMarkerMeasureVersion;
		untrack(() => updateCurrentTurnSequence());
	});

	$effect(() => {
		const sessionId = activeSessionId;
		const loadedCount = activeSessionState?.turns.length ?? 0;
		const indexedCount = activeTurnIndex.length;
		if (!sessionId || loadedCount < 2 || indexedCount >= loadedCount) return;
		const key = `${sessionId}:${loadedCount}:${indexedCount}`;
		if (lastTurnIndexRefreshKey === key) return;
		lastTurnIndexRefreshKey = key;
		untrack(() => {
			void loadTurnIndex(sessionId, true);
		});
	});

	$effect(() => {
		const el = listEl;
		if (!el) return;
		const container = el as HTMLDivElement;
		const ownerSessionId = container.dataset.sessionId;
		function handleScrollTrack() {
			if (!ownerSessionId || activeSessionId !== ownerSessionId) return;
			const isProgrammatic =
				programmaticScrollActive ||
				(programmaticScrollTarget != null &&
					Math.abs(container.scrollTop - programmaticScrollTarget) <= 1);
			if (isProgrammatic) {
				clearProgrammaticScroll();
				updateTimelineScrollMetrics();
				if (!isRestoringSessionScroll(ownerSessionId)) {
					updateAutoFollow();
					markLatestTurnViewedIfVisible(ownerSessionId);
				}
				updateCurrentTurnSequence();
				return;
			}
			updateTimelineScrollMetrics();
			if (activeSessionId && userScrollActive) {
				scheduleScrollAnchorCapture(activeSessionId);
			}
			updateAutoFollow();
			updateCurrentTurnSequence();
		}
		container.addEventListener("wheel", beginUserScroll, { passive: true });
		container.addEventListener("touchstart", beginUserScroll, {
			passive: true,
		});
		container.addEventListener("touchmove", beginUserScroll, { passive: true });
		container.addEventListener("pointerdown", beginUserScroll, {
			passive: true,
		});
		container.addEventListener("keydown", handleScrollKeydown);
		container.addEventListener("scroll", handleScrollTrack, { passive: true });
		return () => {
			container.removeEventListener("wheel", beginUserScroll);
			container.removeEventListener("touchstart", beginUserScroll);
			container.removeEventListener("touchmove", beginUserScroll);
			container.removeEventListener("pointerdown", beginUserScroll);
			container.removeEventListener("keydown", handleScrollKeydown);
			container.removeEventListener("scroll", handleScrollTrack);
		};
	});

	$effect(() => {
		const restoreGeneration = scrollRestoreGeneration;
		const targetId = pendingRestoreSessionId;
		if (!sessionScrollAnchorsLoaded) return;
		if (!targetId || targetId !== activeSessionId) return;
		if (!getSessionScrollList(targetId)) return;
		const state = sessionStateById[targetId];
		if (!state?.loaded) return;
		const isRestoreTargetCurrent = () =>
			activeSessionId === targetId &&
			scrollRestoreGeneration === restoreGeneration &&
			scroll.pendingRestoreSessionId === targetId;
		beginAnchorRestoreWait();
		// Read the anchor untracked: scroll-capture writes to the anchor Map
		// must not re-trigger this effect.
		const anchor = untrack(() => getSessionScrollAnchor(targetId));
		if (!anchor) {
			// Deferred: the bottom restore cancels this restore by writing state
			// this effect reads — running it synchronously would self-invalidate.
			void tick().then(() => restoreSessionScrollToBottom(targetId));
			return;
		}
		if (!isSessionScrollAnchorTurnLoaded(anchor, state.turns)) {
			const loadKey = `${targetId}:${anchor.turnSequence}:${anchor.updatedAt}`;
			if (!scrollAnchorWindowLoads.has(loadKey)) {
				scrollAnchorWindowLoads.add(loadKey);
				untrack(() => {
					void ensureTurnWindowLoaded(targetId, anchor.turnSequence)
						.catch((error) => {
							console.warn(
								"[session-scroll] Failed to load the saved turn window:",
								error,
							);
						})
						.then(() => {
							if (!isRestoreTargetCurrent()) {
								return;
							}
							const currentAnchor = getSessionScrollAnchor(targetId);
							const currentState = sessionStateById[targetId];
							if (
								areSessionScrollAnchorsEqual(currentAnchor, anchor) &&
								currentState &&
								!isSessionScrollAnchorTurnLoaded(anchor, currentState.turns)
							) {
								clearSessionScrollAnchor(targetId);
							}
						})
						.finally(() => scrollAnchorWindowLoads.delete(loadKey));
				});
			}
			return;
		}
		const restore = { ...anchor, sessionId: targetId };
		// Write untracked: this effect must not depend on the signal it writes
		// (isSameActiveAnchorRestore reads scroll.activeAnchorRestore — a
		// tracked read plus a write here is a self-invalidation cycle).
		untrack(() => {
			if (!isSameActiveAnchorRestore(restore)) {
				scroll.activeAnchorRestore = restore;
			}
		});
		// Turn merges, markdown renders, and container resizes re-run this effect
		// and re-apply the anchor; the backoff timer only covers missed triggers.
		requestAnimationFrame(() => {
			if (activeSessionId !== targetId) return;
			maybeCompleteAnchorRestore();
		});
	});

	$effect(() => {
		const sessionId = activeSessionId;
		if (!sessionId) return;
		const state = sessionStateById[sessionId];
		if (!state?.loaded && !state?.loading) {
			untrack(() => {
				void loadSessionState(sessionId);
			});
		}
	});

	$effect(() => {
		const chromeEl = chatChromeEl;
		const composerEl = composerHostEl;
		if (!chromeEl && !composerEl) {
			if (scroll.chatChromeHeight !== 0) scroll.chatChromeHeight = 0;
			if (scroll.composerHeight !== 0) scroll.composerHeight = 0;
			return;
		}
		const updateChromeHeights = () => {
			const nextChrome =
				chromeEl?.offsetHeight ?? composerEl?.offsetHeight ?? 0;
			const nextComposer = composerEl?.offsetHeight ?? 0;
			const chromeChanged = scroll.chatChromeHeight !== nextChrome;
			const composerChanged = scroll.composerHeight !== nextComposer;
			if (chromeChanged) scroll.chatChromeHeight = nextChrome;
			if (composerChanged) scroll.composerHeight = nextComposer;
			// Rail bottomOffset changes the track geometry; remeasure after layout.
			if (chromeChanged || composerChanged) {
				scroll.scheduleTurnMarkerMeasure();
			}
		};
		updateChromeHeights();
		const ro = new ResizeObserver(() => updateChromeHeights());
		if (chromeEl) ro.observe(chromeEl);
		if (composerEl && composerEl !== chromeEl) ro.observe(composerEl);
		return () => ro.disconnect();
	});

	$effect(() => {
		if (!activeSessionId || !getSessionScrollList(activeSessionId)) return;
		// These helpers sync DOM scroll metrics into scroll state. They read the
		// very signals they write (timelineScrollTop/Height/ClientHeight via
		// updateTimelineScrollMetrics, shouldAutoFollow via updateAutoFollow), so
		// tracking those reads self-invalidates this effect. Run the body untracked:
		// this effect only needs to re-run when the session or the scroll container
		// changes, not when its own metric writes settle.
		untrack(() => {
			updateTimelineScrollMetrics();
			if (!isRestoringSessionScroll(activeSessionId)) updateAutoFollow();
		});
	});

	// Keep pinned to bottom while following when content grows (markdown/images)
	// or the viewport shrinks (soft keyboard under `interactive-widget=
	// resizes-content`, split screen) — either one pushes the tail out of view.
	$effect(() => {
		const el = listEl;
		const ownerSessionId = el?.dataset.sessionId;
		if (!el || !ownerSessionId) return;
		let prevHeight = el.scrollHeight;
		let prevClientHeight = el.clientHeight;
		const ro = new ResizeObserver(() => {
			if (listEl !== el || activeSessionId !== ownerSessionId) return;
			const currentHeight = el.scrollHeight;
			const currentClientHeight = el.clientHeight;
			const tailPushedOut =
				currentHeight > prevHeight || currentClientHeight < prevClientHeight;
			const restoringBottom = restoringBottomSessionId === ownerSessionId;
			const restoringPosition = isRestoringSessionScroll(ownerSessionId);
			if (restoringPosition) maybeCompleteAnchorRestore();
			if (
				tailPushedOut &&
				!restoringPosition &&
				(shouldAutoFollow || restoringBottom)
			) {
				requestBottomFollow({ immediate: restoringBottom });
			}
			prevHeight = currentHeight;
			prevClientHeight = currentClientHeight;
			updateTimelineScrollMetrics();
			scroll.scheduleTurnMarkerMeasureThrottled();
		});
		ro.observe(el);
		for (const child of Array.from(el.children)) ro.observe(child);
		scroll.scheduleTurnMarkerMeasure();
		return () => ro.disconnect();
	});

	// Active session turns cache subscription
	$effect(() => {
		const currentSpaceId = spaceId;
		const sessionId = activeSessionId;
		if (!currentSpaceId || !sessionId) return;
		return sessionTurnsRepo.subscribe(currentSpaceId, sessionId, (snapshot) => {
			const current = sessionStateById[sessionId];
			if (!current) return;
			const nextTurns = preserveSessionTurnRefs(
				current.turns,
				normalizeTurnDuplicates(
					mergeTurnsById(current.turns, snapshot.turns, {
						preferIncoming: true,
					}),
				),
			);
			const nextSession = snapshot.session ?? current.session;
			const nextOldestCursor = snapshot.oldestSequence ?? undefined;
			// A cache emit fires on every in-memory write even when the merged
			// content is identical. Rewriting the state with a fresh object would
			// re-invalidate every `sessionStateById` consumer for no reason — a
			// churn source that feeds effect re-run cascades during restore.
			// `snapshot.session` is re-serialized each emit, so compare by value.
			const sessionUnchanged =
				nextSession === current.session ||
				(nextSession?.id === current.session?.id &&
					nextSession?.lastMessageId === current.session?.lastMessageId &&
					nextSession?.updatedAt === current.session?.updatedAt);
			if (
				sessionUnchanged &&
				areSessionTurnsEqual(current.turns, nextTurns) &&
				current.hasMore === snapshot.hasMoreOlder &&
				current.hasMoreNewer === snapshot.hasMoreNewer &&
				current.oldestCursor === nextOldestCursor
			) {
				return;
			}
			workspace.sessionStateById = {
				...sessionStateById,
				[sessionId]: {
					...current,
					session: nextSession,
					turns: nextTurns,
					hasMore: snapshot.hasMoreOlder,
					hasMoreNewer: snapshot.hasMoreNewer,
					oldestCursor: nextOldestCursor,
				},
			};
		});
	});

	$effect(() => {
		const sessionId = activeSessionId;
		generationRealtime.syncActiveSubscription(Boolean(spaceId && sessionId));
	});

	// ── Chat methods (extracted from SpaceWorkspacePage) ──
	function clearComposerError() {
		composer.clearError();
	}

	function setComposerError(message: string, code: string | null = null) {
		composer.setError(message, code);
	}

	function clearComposerDraftSaveTimer() {
		if (composerDraftSaveTimer == null) return;
		clearTimeout(composerDraftSaveTimer);
		composerDraftSaveTimer = null;
	}

	function flushActiveComposerDraft() {
		clearComposerDraftSaveTimer();
		if (!activeComposerDraftKey) return;
		writeSessionComposerDraftText(activeComposerDraftKey, composer.input);
	}

	function clearActiveComposerDraft() {
		clearComposerDraftSaveTimer();
		removeSessionComposerDraftText(activeComposerDraftKey);
	}

	function getHttpErrorCode(error: unknown): string | null {
		if (!(error instanceof HttpError)) return null;
		const body = error.body;
		if (!body || typeof body !== "object" || Array.isArray(body)) return null;
		const record = body as Record<string, unknown>;
		const directError = record.error;
		if (
			directError &&
			typeof directError === "object" &&
			!Array.isArray(directError)
		) {
			const code = (directError as Record<string, unknown>).code;
			if (typeof code === "string") return code;
		}
		const code = record.code;
		return typeof code === "string" ? code : null;
	}

	function turnPreviewText(turn: SessionTurnRecord) {
		return (turn.userText ?? "").replace(/\s+/g, " ").trim() || "Follow-up";
	}

	function removeQueuedFollowupDuplicates(
		turns: SessionTurnRecord[],
		resolvedTurn: SessionTurnRecord,
	) {
		const clientMessageId = getTurnClientMessageId(resolvedTurn);
		if (!clientMessageId)
			return turns.filter((turn) => turn.id !== resolvedTurn.id);
		return turns.filter((turn) => {
			if (turn.id === resolvedTurn.id) return false;
			return !(
				turn.status === "queued" &&
				turn.intent === "followup" &&
				getTurnClientMessageId(turn) === clientMessageId
			);
		});
	}

	async function refreshSessionAfterStaleFollowupAction(sessionId: string) {
		clearComposerError();
		await syncSessionNewer(sessionId, null).catch(() => undefined);
	}

	async function handleSteerFollowup(turnId: string) {
		if (
			!activeSessionId ||
			!(options.hasSpace?.() ?? Boolean(spaceId)) ||
			pendingFollowupActionIds.has(turnId)
		)
			return;
		const sessionId = activeSessionId;
		tasks.addPendingFollowupAction(turnId);
		clearComposerError();
		try {
			const result = await sdk
				.space(spaceId)
				.session(sessionId)
				.steerTurn(turnId);
			const current = sessionStateById[sessionId];
			if (current) {
				workspace.sessionStateById = {
					...sessionStateById,
					[sessionId]: {
						...current,
						turns: mergeTurnsById(
							removeQueuedFollowupDuplicates(current.turns, result.turn),
							result.affectedTurns,
							{ preferIncoming: true },
						),
					},
				};
			}
			startGenerationRequest(sessionId, {
				spaceId,
				turnId: result.turn.id,
			});
		} catch (error) {
			if (error instanceof HttpError && error.status === 409) {
				await refreshSessionAfterStaleFollowupAction(sessionId);
				return;
			}
			setComposerError(
				error instanceof Error ? error.message : "Failed to steer follow-up",
			);
		} finally {
			tasks.removePendingFollowupAction(turnId);
		}
	}

	async function handleCancelFollowup(turnId: string) {
		if (
			!activeSessionId ||
			!(options.hasSpace?.() ?? Boolean(spaceId)) ||
			pendingFollowupActionIds.has(turnId)
		)
			return;
		const sessionId = activeSessionId;
		tasks.addPendingFollowupAction(turnId);
		clearComposerError();
		try {
			const result = await sdk
				.space(spaceId)
				.session(sessionId)
				.cancelTurn(turnId);
			const current = sessionStateById[sessionId];
			if (current) {
				workspace.sessionStateById = {
					...sessionStateById,
					[sessionId]: {
						...current,
						turns: mergeTurnsById(
							removeQueuedFollowupDuplicates(current.turns, result.turn),
							[result.turn],
							{ preferIncoming: true },
						),
					},
				};
			}
		} catch (error) {
			if (error instanceof HttpError && error.status === 409) {
				await refreshSessionAfterStaleFollowupAction(sessionId);
				return;
			}
			setComposerError(
				error instanceof Error ? error.message : "Failed to cancel follow-up",
			);
		} finally {
			tasks.removePendingFollowupAction(turnId);
		}
	}

	function applySessionGenerationPolicy(sessionId: string) {
		generationPolicy.apply(generationPolicy.load(sessionId));
	}

	function ensureSessionModelLoaded(sessionId: string) {
		if (Object.hasOwn(sessionModelById, sessionId)) return;
		sessionModelById = {
			...sessionModelById,
			[sessionId]: null,
		};
	}

	async function loadModelsCatalog() {
		try {
			await modelsCatalogStore.load();
		} catch (error) {
			console.error("Failed to load models catalog:", error);
		}
	}

	async function loadGenerationModelsCatalog() {
		await generationPolicy.loadModelsCatalog();
	}

	function buildTurnGenerationPolicy() {
		return generationPolicy.buildTurnPolicy();
	}

	function setGenerationPolicyMode(mode: "auto" | "limited") {
		generationPolicy.setPolicyMode(mode);
	}

	function setGenerationModelSelected(modelId: string, selected: boolean) {
		generationPolicy.setModelSelected(modelId, selected);
	}

	function setGenerationEnumValueSelected(
		modelId: string,
		parameter: string,
		value: string,
		selected: boolean,
	) {
		generationPolicy.setEnumValueSelected(modelId, parameter, value, selected);
	}

	function setGenerationNumericConstraint(
		modelId: string,
		parameter: string,
		constraint: { min?: number; max?: number },
	) {
		generationPolicy.setNumericConstraint(modelId, parameter, constraint);
	}

	function setGenerationBooleanConstraint(
		modelId: string,
		parameter: string,
		constraint: { value?: boolean },
	) {
		generationPolicy.setBooleanConstraint(modelId, parameter, constraint);
	}

	async function loadPromptTemplates(options: { ensureFresh?: boolean } = {}) {
		await Promise.all([
			promptTemplatesCtrl.load(options),
			skillsCtrl.load(options),
		]);
	}

	function handleModelSelect(model: {
		provider: string;
		id: string;
		thinkingLevel?: ModelThinkingLevel;
	}) {
		const catalogItem = modelsCatalog?.find(
			(item) => item.provider === model.provider && item.id === model.id,
		);
		const selected = {
			provider: model.provider,
			id: model.id,
			name: catalogItem?.model.name as string | undefined,
		} satisfies SelectedModel;
		const thinkingLevel = model.thinkingLevel ?? null;
		composerSelection = { mode: "agent", model: selected };
		if (!activeSessionId) {
			draftSessionModel = selected;
			draftSessionModelManuallySelected = true;
			draftThinkingLevel = thinkingLevel;
			showModelSelector = false;
			focusComposerSoon();
			return;
		}
		sessionModelById = {
			...sessionModelById,
			[activeSessionId]: selected,
		};
		sessionThinkingLevelById = {
			...sessionThinkingLevelById,
			[activeSessionId]: thinkingLevel,
		};
		showModelSelector = false;
		focusComposerSoon();
	}

	function loadSessionScrollAnchors() {
		if (sessionScrollAnchorsLoaded) return;
		scroll.loadSessionScrollAnchors(SESSION_SCROLL_ANCHOR_STORAGE_KEY);
		sessionScrollAnchorsLoaded = true;
	}

	function persistSessionScrollAnchorsNow() {
		scroll.persistSessionScrollAnchorsNow(SESSION_SCROLL_ANCHOR_STORAGE_KEY);
	}

	function setSessionScrollAnchor(
		sessionId: string,
		anchor: SessionScrollAnchor,
	) {
		scroll.setSessionScrollAnchor(
			SESSION_SCROLL_ANCHOR_STORAGE_KEY,
			sessionId,
			anchor,
		);
	}

	function getSessionScrollAnchor(sessionId: string) {
		return scroll.getSessionScrollAnchor(sessionId);
	}

	function clearSessionScrollAnchor(sessionId: string) {
		scroll.clearSessionScrollAnchor(
			SESSION_SCROLL_ANCHOR_STORAGE_KEY,
			sessionId,
		);
	}

	function getSessionScrollList(sessionId: string) {
		return scroll.listEl?.dataset.sessionId === sessionId
			? scroll.listEl
			: null;
	}

	function readSessionScrollAnchorTarget(
		node: HTMLElement,
	): SessionScrollAnchorTarget | null {
		const itemKey = node.dataset.scrollAnchorKey?.trim();
		const turnSequence = Number(node.dataset.scrollAnchorTurnSequence);
		const kind = node.dataset.scrollAnchorKind;
		if (
			!itemKey ||
			!Number.isInteger(turnSequence) ||
			turnSequence <= 0 ||
			!isSessionScrollAnchorKind(kind)
		) {
			return null;
		}
		return { itemKey, turnSequence, kind };
	}

	function getSessionScrollAnchorNodes(sessionId: string) {
		const list = getSessionScrollList(sessionId);
		if (!list) return [];
		return Array.from(
			list.querySelectorAll<HTMLElement>("[data-scroll-anchor-key]"),
		).flatMap((node) => {
			const target = readSessionScrollAnchorTarget(node);
			return target ? [{ node, target }] : [];
		});
	}

	function findSessionScrollAnchorNode(
		sessionId: string,
		anchor: SessionScrollAnchor,
	) {
		const entries = getSessionScrollAnchorNodes(sessionId);
		const index = resolveSessionScrollAnchorTargetIndex(
			anchor,
			entries.map((entry) => entry.target),
		);
		return index >= 0 ? (entries[index]?.node ?? null) : null;
	}

	function getMessageElementAbsoluteTop(node: HTMLElement) {
		return scroll.getMessageElementAbsoluteTop(node);
	}

	function updateTimelineScrollMetrics() {
		scroll.updateTimelineScrollMetrics();
	}

	function markVisibleLatestTurnViewed(
		sessionId: string,
		nodes: HTMLElement[],
		containerRect: DOMRect,
	) {
		const state = sessionStateById[sessionId];
		if (!state?.session) return;
		const latestTurn =
			state.turns.findLast(
				(turn) =>
					turn.status !== "running" && turn.status !== "abort_requested",
			) ?? null;
		if (!latestTurn) return;
		// Anchor nodes are ordered with non-decreasing turn sequence, so the
		// newest visible turn is the first candidate found from the end — no need
		// to measure the whole list on every scroll frame.
		for (let i = nodes.length - 1; i >= 0; i -= 1) {
			const node = nodes[i];
			const rect = node.getBoundingClientRect();
			if (rect.top >= containerRect.bottom - 8) continue; // below viewport
			const sequence = Number(node.dataset.turnSequence);
			if (!Number.isFinite(sequence)) continue;
			if (
				rect.bottom > containerRect.top + 8 &&
				sequence >= latestTurn.sequence
			) {
				unreadTracker.markViewed(sessionId, state.session.lastMessageId);
			}
			return;
		}
	}

	function markLatestTurnViewedIfVisible(sessionId: string) {
		const list = getSessionScrollList(sessionId);
		if (!list) return;
		const nodes = getSessionScrollAnchorNodes(sessionId).map(
			(entry) => entry.node,
		);
		if (nodes.length === 0) return;
		markVisibleLatestTurnViewed(sessionId, nodes, list.getBoundingClientRect());
	}

	function isStreamingRegionVisible(
		list: HTMLDivElement,
		containerRect: DOMRect,
	) {
		return Array.from(
			list.querySelectorAll<HTMLElement>('[data-session-follow-tail="true"]'),
		).some((node) => {
			const rect = node.getBoundingClientRect();
			return (
				rect.bottom > containerRect.top + 8 &&
				rect.top < containerRect.bottom - 8
			);
		});
	}

	function markSessionFollowingTail(sessionId: string) {
		clearSessionScrollAnchor(sessionId);
		const state = sessionStateById[sessionId];
		unreadTracker.markViewed(sessionId, state?.session?.lastMessageId ?? null);
	}

	function captureCurrentScrollAnchor(sessionId: string) {
		const list = getSessionScrollList(sessionId);
		if (!list) return;
		// Re-entry restore owns the saved leave position until it finishes.
		if (isRestoringSessionScroll(sessionId)) return;
		const entries = getSessionScrollAnchorNodes(sessionId);
		const containerRect = list.getBoundingClientRect();
		if (
			shouldFollowSessionTail({
				shouldAutoFollow: scroll.shouldAutoFollow,
				scrollTop: list.scrollTop,
				scrollHeight: list.scrollHeight,
				clientHeight: list.clientHeight,
				streamingRegionVisible: isStreamingRegionVisible(list, containerRect),
			})
		) {
			markSessionFollowingTail(sessionId);
			return;
		}
		if (entries.length === 0) return;
		const firstVisible =
			entries.find(
				(entry) =>
					entry.node.getBoundingClientRect().bottom > containerRect.top + 8,
			) ?? entries[0];
		if (!firstVisible) return;
		const absoluteTop = getMessageElementAbsoluteTop(firstVisible.node);
		setSessionScrollAnchor(sessionId, {
			...firstVisible.target,
			offset: list.scrollTop - absoluteTop,
			updatedAt: Date.now(),
		});
		markVisibleLatestTurnViewed(
			sessionId,
			entries.map((entry) => entry.node),
			containerRect,
		);
	}

	function upsertSessionRecord(
		session: SessionRecord,
		options?: { cache?: boolean },
	) {
		const nextSessions = workspace.upsertSessionRecord(session);
		reconcileGenerationStateFromSessionList([session]);
		if (options?.cache !== false) {
			void patchCachedSessionList(spaceId, () => nextSessions).catch(
				() => undefined,
			);
		}
	}

	function applySessionRealtimeRecord(session: SessionRecord) {
		upsertSessionRecord(session);
	}

	function applySessionsSnapshot(
		sessions: SessionRecord[],
		options?: { authoritative?: boolean; requestStartedAt?: number },
	) {
		workspace.applySessionsSnapshot(sessions);
		reconcileGenerationStateFromSessionList(sessions, options);
	}

	function seedSessions(sessions: SessionRecord[]) {
		workspace.seedSessions(sessions);
		reconcileGenerationStateFromSessionList(sessions);
	}

	async function syncForkResponseToSessionListCache(
		session: SessionRecord,
		fork: SessionListForkRecord | null | undefined,
		parentSession?: SessionRecord | null,
	) {
		const snapshot = await getCachedSessionListSnapshot(spaceId).catch(
			() => null,
		);
		const forkByChildId = new Map(
			(snapshot?.forks ?? []).map((item) => [item.childSessionId, item]),
		);
		if (fork?.childSessionId) forkByChildId.set(fork.childSessionId, fork);
		await patchCachedSessionList(
			spaceId,
			(current) => {
				const base =
					current.length > 0 ? current : parentSession ? [parentSession] : [];
				return [session, ...base.filter((item) => item.id !== session.id)];
			},
			undefined,
			Array.from(forkByChildId.values()),
		);
	}

	async function refreshSessionsList(force = true) {
		if (refreshSessionsListInFlight) {
			refreshSessionsListQueued = true;
			refreshSessionsListQueuedForce ||= force;
			return refreshSessionsListInFlight;
		}
		// Pin the request identity: a space switch mid-flight must never fetch,
		// cache, or apply another space's sessions.
		const requestSpaceId = spaceId;
		const run = (async () => {
			try {
				const requestStartedAt = Date.now();
				let backgroundRefreshApplied = false;
				const sessions = await fetchSessionListWithCache(
					requestSpaceId,
					async () => {
						const result = await sdk.space(requestSpaceId).sessions.list({
							includeForks: true,
						});
						return {
							sessions: result.sessions ?? [],
							forks: result.forks,
							pageInfo: result.pageInfo,
						};
					},
					{
						force,
						onBackgroundRefresh: force
							? undefined
							: (freshSessions) => {
									if (spaceId !== requestSpaceId) return;
									backgroundRefreshApplied = true;
									applySessionsSnapshot(freshSessions, {
										authoritative: true,
										requestStartedAt,
									});
								},
					},
				);
				if (spaceId !== requestSpaceId) return;
				if (force || !backgroundRefreshApplied) {
					applySessionsSnapshot(sessions, {
						authoritative: force,
						requestStartedAt,
					});
				}
			} catch (error) {
				console.warn("[space] Failed to refresh sessions:", error);
			}
		})();
		refreshSessionsListInFlight = run.finally(() => {
			refreshSessionsListInFlight = null;
			if (refreshSessionsListQueued) {
				const rerunForce = refreshSessionsListQueuedForce;
				refreshSessionsListQueued = false;
				refreshSessionsListQueuedForce = false;
				void refreshSessionsList(rerunForce);
			}
		});
		return refreshSessionsListInFlight;
	}

	function prepareRouteSession(sessionId: string) {
		const previousSessionId = activeSessionId;
		const existing = sessionStateById[sessionId];
		// Space bootstrap and route sync can both prepare the same session during
		// refresh. Keep the first restore owner instead of starting a second race.
		if (
			previousSessionId === sessionId &&
			(existing?.loaded ||
				existing?.loading ||
				pendingRestoreSessionId === sessionId)
		) {
			return;
		}
		++scrollRestoreGeneration;
		const tailGeneration = ++tailReconcileGeneration;
		// `loaded` means bootstrap finished (cache paint and/or network). While
		// loading, loadSessionState owns the fetch — do not double-hit /turns.
		const alreadyLoaded = Boolean(sessionStateById[sessionId]?.loaded);
		const sessionChanged = previousSessionId !== sessionId;
		const shouldReconcileTail = alreadyLoaded && sessionChanged;
		pendingTailReconcileSessionId = shouldReconcileTail ? sessionId : null;
		restoringBottomSessionId = null;
		clearAnchorRestoreRetry();
		workspace.prepareRouteSession(sessionId);
		scroll.pendingRestoreSessionId = sessionId;
		scroll.activeAnchorRestore = null;
		// Session switch remounts the timeline via `{#key}`. MarkdownViews that
		// started rendering on the previous tree may never fire onRendered, so
		// drop any leaked pending count — otherwise restore waits forever and
		// the new list stays at scrollTop 0.
		if (sessionChanged) {
			scroll.pendingTimelineMarkdownRenders = 0;
		}
		userScrollActive = false;
		clearProgrammaticScroll();
		currentTurnSequence = null;
		showTurnBottomSheet = false;
		ensureSessionModelLoaded(sessionId);
		applySessionGenerationPolicy(sessionId);
		// Do not let early layout growth follow the tail before the saved anchor
		// cache has been loaded and classified.
		scroll.shouldAutoFollow = sessionScrollAnchorsLoaded
			? !getSessionScrollAnchor(sessionId)
			: false;
		// Always restore local generation UI. Re-fetch tail only when switching
		// back into a fully loaded session (mid-send leave / dual-host return).
		void sessionGenerationStore
			.restore(spaceId, sessionId)
			.catch(() => undefined)
			.then(() => {
				if (disposed || activeSessionId !== sessionId) return;
				if (!shouldReconcileTail) return;
				return reconcileSessionTail(sessionId);
			})
			.catch(() => undefined)
			.finally(() => {
				if (
					tailReconcileGeneration === tailGeneration &&
					pendingTailReconcileSessionId === sessionId
				) {
					pendingTailReconcileSessionId = null;
				}
			});
	}

	async function syncGenerationStateFromTail(
		sessionId: string,
		turns: SessionTurnRecord[],
		requestStartedAt: number,
	) {
		const runningTurn = turns.findLast(
			(turn) => turn.status === "running" || turn.status === "abort_requested",
		);
		if (runningTurn) {
			const current = sessionGenerationStore.get(sessionId);
			const optimisticTurn = turns.find(
				(turn) =>
					turn.meta?.optimistic === true &&
					getTurnClientMessageId(turn) === getTurnClientMessageId(runningTurn),
			);
			if (optimisticTurn?.id && optimisticTurn.id !== runningTurn.id) {
				return;
			}
			// The HTTP API response may lag behind WebSocket events. Two guards:
			//
			// 1. If the generation already reached a terminal state for the same
			//    turn, the API data is stale — skip to avoid re-activating.
			//
			// 2. If the generation is actively streaming for the same turn and
			//    the API request was sent BEFORE the last streaming event arrived,
			//    the API data is likely stale (the server may not have persisted
			//    the completed status yet). Skip to avoid replacing
			//    streaming-accumulated content with a stale snapshot, which would
			//    reset the StreamingMarkdownController and cause a re-stream.
			const isSameTurn = current?.turnId === runningTurn.id;
			const alreadyTerminalForTurn =
				current &&
				TERMINAL_GENERATION_STATUSES.has(current.status) &&
				isSameTurn;
			const staleApiForActiveStream =
				current &&
				isSameTurn &&
				(current.status === "streaming" || current.status === "pending") &&
				(current.lastEventAt ?? 0) > requestStartedAt;
			if (alreadyTerminalForTurn || staleApiForActiveStream) {
				return;
			}
			const anchorUserMessageId =
				typeof runningTurn.meta?.userMessageId === "string"
					? runningTurn.meta.userMessageId
					: runningTurn.id;
			sessionGenerationStore.resumePending(sessionId, {
				spaceId,
				turnId: runningTurn.id,
				anchorUserMessageId,
			});
			const state = sessionStateById[sessionId];
			if (!state?.turns.some((turn) => turn.id === runningTurn.id)) {
				await hydrateTurnOnce({
					sessionId,
					turnId: runningTurn.id,
					reason: "running-recovery",
				});
			}
			await restoreSessionStreamSnapshot(sessionId, { turnId: runningTurn.id });
			return;
		}
		const current = sessionGenerationStore.get(sessionId);
		if (
			current &&
			!TERMINAL_GENERATION_STATUSES.has(current.status) &&
			(current.lastEventAt ?? 0) <= requestStartedAt
		) {
			resetGeneration(sessionId);
		}
	}

	async function loadSessionState(sessionId: string, force = false) {
		const existing = sessionStateById[sessionId];
		if (existing?.loaded && !force) return;
		const load = async () => {
			const guard = createKeyedRouteRequestGuard({
				captureKey: () => `${spaceId}:${sessionId}`,
			});
			let cached: Awaited<
				ReturnType<typeof sessionTurnsRepo.getCached>
			> | null = null;
			if (!force) {
				try {
					cached = await sessionTurnsRepo.getCached(spaceId, sessionId);
				} catch (error) {
					console.warn(
						"[loadSessionState] Failed to read session cache:",
						error,
					);
				}
			}
			if (!guard.isCurrent()) return;
			if (cached && (cached.turns.length > 0 || cached.session)) {
				workspace.sessionStateById = {
					...sessionStateById,
					[sessionId]: {
						session:
							cached.session ??
							existing?.session ??
							spaceSessions.find((s) => s.id === sessionId),
						turns: cached.turns,
						loading: true,
						loaded: true,
						error: null,
						hasMore: cached.hasMoreOlder,
						hasMoreNewer: cached.hasMoreNewer,
						loadingOlder: false,
						loadingNewer: false,
						oldestCursor: cached.oldestSequence ?? undefined,
					},
				};
			}
			workspace.loadingSessionIds = {
				...loadingSessionIds,
				[sessionId]: true,
			};
			workspace.visibleInitialLoadingSessionIds = {
				...visibleInitialLoadingSessionIds,
				[sessionId]: false,
			};
			const loadSpaceId = spaceId;
			const loadingTimer = setTimeout(() => {
				if (spaceId !== loadSpaceId) return;
				if (sessionStateById[sessionId]?.loaded) return;
				workspace.visibleInitialLoadingSessionIds = {
					...visibleInitialLoadingSessionIds,
					[sessionId]: true,
				};
			}, SESSION_INITIAL_LOADING_DELAY_MS);
			const currentSeed = sessionStateById[sessionId];
			workspace.sessionStateById = {
				...sessionStateById,
				[sessionId]: {
					session:
						currentSeed?.session ??
						existing?.session ??
						spaceSessions.find((s) => s.id === sessionId),
					turns: currentSeed?.turns ?? existing?.turns ?? [],
					loading: true,
					loaded: currentSeed?.loaded ?? existing?.loaded ?? false,
					error: currentSeed?.error ?? existing?.error ?? null,
					hasMore: currentSeed?.hasMore ?? existing?.hasMore ?? true,
					hasMoreNewer:
						currentSeed?.hasMoreNewer ?? existing?.hasMoreNewer ?? false,
					loadingOlder: false,
					loadingNewer: false,
					oldestCursor: currentSeed?.oldestCursor ?? existing?.oldestCursor,
				},
			};
			try {
				const requestStartedAt = Date.now();
				const response = await sdk
					.space(spaceId)
					.session(sessionId)
					.turns.listPaginated({
						limit: 30,
					});
				if (!guard.isCurrent()) return;
				await syncGenerationStateFromTail(
					sessionId,
					response.turns,
					requestStartedAt,
				);
				const snapshot = await sessionTurnsRepo.replaceTail(
					spaceId,
					sessionId,
					{
						session: response.session,
						turns: response.turns,
						hasMore: response.hasMore,
					},
				);
				if (!guard.isCurrent()) return;
				upsertSessionRecord(response.session);
				const currentAfterSnapshot = sessionStateById[sessionId];
				const nextTurns = currentAfterSnapshot
					? preserveSessionTurnRefs(currentAfterSnapshot.turns, snapshot.turns)
					: snapshot.turns;
				workspace.sessionStateById = {
					...sessionStateById,
					[sessionId]: {
						session: snapshot.session ?? response.session,
						turns: nextTurns,
						loading: false,
						loaded: true,
						error: null,
						hasMore: snapshot.hasMoreOlder,
						hasMoreNewer: snapshot.hasMoreNewer,
						loadingOlder: false,
						loadingNewer: false,
						oldestCursor: snapshot.oldestSequence ?? undefined,
					},
				};
			} catch (error) {
				if (!guard.isCurrent()) return;
				const fallback = sessionStateById[sessionId];
				workspace.sessionStateById = {
					...sessionStateById,
					[sessionId]: {
						session:
							fallback?.session ??
							existing?.session ??
							spaceSessions.find((s) => s.id === sessionId),
						turns: fallback?.turns ?? existing?.turns ?? [],
						loading: false,
						loaded: Boolean(fallback?.loaded ?? existing?.loaded),
						error: classifyAccessError(error, {
							isAuthenticated: authStore.isAuthenticated,
							resource: "session",
						}),
						hasMore: fallback?.hasMore ?? existing?.hasMore ?? true,
						hasMoreNewer:
							fallback?.hasMoreNewer ?? existing?.hasMoreNewer ?? false,
						loadingOlder: false,
						loadingNewer: false,
						oldestCursor: fallback?.oldestCursor ?? existing?.oldestCursor,
					},
				};
			} finally {
				clearTimeout(loadingTimer);
				if (guard.isCurrent()) {
					const nextVisibleLoading = { ...visibleInitialLoadingSessionIds };
					delete nextVisibleLoading[sessionId];
					workspace.visibleInitialLoadingSessionIds = nextVisibleLoading;
					workspace.loadingSessionIds = {
						...loadingSessionIds,
						[sessionId]: false,
					};
				}
			}
		};
		if (force) return load();
		return workspace.runSessionLoad(sessionId, load);
	}

	async function loadTurnIndex(sessionId: string, force = false) {
		await turnLoading.loadTurnIndex(sessionId, force);
	}

	function getTurnAnchorNode(sequence: number) {
		return (
			listEl?.querySelector<HTMLElement>(
				`[data-turn-anchor="user"][data-turn-sequence="${sequence}"]`,
			) ?? null
		);
	}

	function snapScrollToNearestTurn(threshold = 32) {
		if (!listEl) return false;
		const anchors = Array.from(
			listEl.querySelectorAll<HTMLElement>('[data-turn-anchor="user"]'),
		);
		let nearest: { sequence: number; distance: number } | null = null;
		for (const anchor of anchors) {
			const sequence = Number(anchor.dataset.turnSequence);
			if (!Number.isFinite(sequence)) continue;
			const targetTop = Math.max(
				0,
				getMessageElementAbsoluteTop(anchor) - TURN_SCROLL_ANCHOR_OFFSET,
			);
			const distance = Math.abs(targetTop - listEl.scrollTop);
			if (!nearest || distance < nearest.distance) {
				nearest = { sequence, distance };
			}
		}
		if (!nearest || nearest.distance > threshold) return false;
		return scrollToTurnAnchor(nearest.sequence);
	}

	function scrollToTurnAnchor(sequence: number) {
		if (!listEl) return false;
		const node = getTurnAnchorNode(sequence);
		if (!node) return false;
		setProgrammaticScrollTop(
			Math.max(
				0,
				getMessageElementAbsoluteTop(node) - TURN_SCROLL_ANCHOR_OFFSET,
			),
		);
		scroll.shouldAutoFollow = false;
		currentTurnSequence = sequence;
		requestAnimationFrame(() => updateCurrentTurnSequence());
		highlightedTurnSequence = sequence;
		window.setTimeout(() => {
			if (highlightedTurnSequence === sequence) highlightedTurnSequence = null;
		}, 1400);
		return true;
	}

	async function ensureTurnWindowLoaded(sessionId: string, sequence: number) {
		const key = `${sessionId}:${sequence}`;
		return turnLoading.runTurnWindowLoad(key, async () => {
			const guard = createKeyedRouteRequestGuard({
				captureKey: () => `${spaceId}:${sessionId}`,
			});
			const state = sessionStateById[sessionId];
			if (state?.turns.some((turn) => turn.sequence === sequence)) return;
			if (state?.loaded && !state.loading && state.turns.length === 0) return;
			turnLoading.loadingTurnSequence = sequence;
			try {
				const response = await sdk
					.space(spaceId)
					.session(sessionId)
					.turns.window({
						sequence,
						before: 10,
						after: 20,
					});
				if (!guard.isCurrent()) return;
				const current = sessionStateById[sessionId] ?? state;
				const mergedTurns = current
					? normalizeTurnDuplicates(
							mergeTurnsById(current.turns, response.turns, {
								preferIncoming: true,
							}),
						)
					: response.turns;
				void sessionTurnsRepo
					.mergeTurns(spaceId, sessionId, response.turns, {
						session: response.session,
						hasMoreOlder: response.hasMoreOlder,
						hasMoreNewer:
							"hasMoreNewer" in response ? response.hasMoreNewer : undefined,
						source: "network",
						trimAnchorSequence: sequence,
					})
					.catch(() => undefined);
				if (current) {
					workspace.sessionStateById = {
						...sessionStateById,
						[sessionId]: {
							...current,
							session: response.session ?? current.session,
							turns: mergedTurns,
							hasMore: response.hasMoreOlder,
							hasMoreNewer:
								"hasMoreNewer" in response
									? response.hasMoreNewer
									: current.hasMoreNewer,
							oldestCursor: mergedTurns[0]?.sequence ?? undefined,
							loaded: true,
							loading: false,
						},
					};
				}
			} catch (error) {
				const current = sessionStateById[sessionId];
				if (
					error instanceof HttpError &&
					error.status === 404 &&
					!current?.turns.some((turn) => turn.sequence === sequence)
				) {
					return;
				}
				throw error;
			} finally {
				if (guard.isCurrent()) turnLoading.loadingTurnSequence = null;
			}
		});
	}

	async function jumpToTurn(sequence: number) {
		if (!activeSessionId) return;
		try {
			clearComposerError();
			if (scrollToTurnAnchor(sequence)) return;
			await ensureTurnWindowLoaded(activeSessionId, sequence);
			await tick();
			requestAnimationFrame(() => scrollToTurnAnchor(sequence));
		} catch (error) {
			console.warn("[jumpToTurn] Failed to jump to turn:", error);
			setComposerError(
				error instanceof Error ? error.message : "Failed to jump to turn",
			);
		}
	}

	async function jumpToTurnAndUpdateUrl(sequence: number) {
		if (!activeSessionId) return;
		try {
			appliedRouteTurnKey = `${activeSessionId}:${sequence}`;
			await options.router.toTurn(activeSessionId, sequence);
			await jumpToTurn(sequence);
		} catch (error) {
			console.warn("[jumpToTurnAndUpdateUrl] Failed to jump to turn:", error);
			setComposerError(
				error instanceof Error ? error.message : "Failed to jump to turn",
			);
		}
	}

	async function syncSessionNewer(sessionId: string, _cached: unknown) {
		const sync = async () => {
			const state = sessionStateById[sessionId];
			if (!state || state.turns.length === 0) return;
			const newestSeq = state.turns.at(-1)?.sequence;
			if (newestSeq == null) return;
			workspace.sessionStateById = {
				...sessionStateById,
				[sessionId]: {
					...state,
					loadingNewer: true,
				},
			};
			try {
				const response = await sdk
					.space(spaceId)
					.session(sessionId)
					.turns.listPaginated({
						cursor: newestSeq,
						direction: "newer",
						limit: 100,
					});
				if (response.turns.length > 0) {
					void sessionTurnsRepo
						.mergeTurns(spaceId, sessionId, response.turns, {
							session: response.session,
							source: "network",
						})
						.catch(() => undefined);
					const current = sessionStateById[sessionId];
					if (current) {
						const mergedTurns = normalizeTurnDuplicates(
							mergeTurnsById(current.turns, response.turns, {
								preferIncoming: true,
							}),
						);
						workspace.sessionStateById = {
							...sessionStateById,
							[sessionId]: {
								...current,
								session: response.session ?? current.session,
								turns: mergedTurns,
							},
						};
					}
				}
			} catch (error) {
				console.warn("[syncSessionNewer] Failed to sync newer turns:", error);
			} finally {
				const current = sessionStateById[sessionId];
				if (current) {
					workspace.sessionStateById = {
						...sessionStateById,
						[sessionId]: {
							...current,
							loadingNewer: false,
						},
					};
				}
			}
		};
		return workspace.runSyncSessionNewer(sessionId, sync);
	}

	async function loadOlderTurns(sessionId: string) {
		const state = sessionStateById[sessionId];
		if (!state?.hasMore || state.loadingOlder) return;
		chatTimelineRef?.preparePrepend();
		workspace.sessionStateById = {
			...sessionStateById,
			[sessionId]: {
				...state,
				loadingOlder: true,
			},
		};
		try {
			const response = await sdk
				.space(spaceId)
				.session(sessionId)
				.turns.listPaginated({
					cursor: state.oldestCursor,
					direction: "older",
					limit: 30,
				});
			void sessionTurnsRepo
				.loadOlder(spaceId, sessionId, {
					session: response.session,
					turns: response.turns,
					hasMore: response.hasMore,
				})
				.catch(() => undefined);
			const current = sessionStateById[sessionId] ?? state;
			const mergedTurns = normalizeTurnDuplicates(
				mergeTurnsById(current.turns, response.turns, {
					preferIncoming: false,
				}),
			);
			workspace.sessionStateById = {
				...sessionStateById,
				[sessionId]: {
					...current,
					session: response.session ?? current.session,
					turns: mergedTurns,
					hasMore: response.hasMore,
					hasMoreNewer: current.hasMoreNewer,
					loadingOlder: false,
					loadingNewer: false,
					oldestCursor: mergedTurns[0]?.sequence ?? undefined,
				},
			};
			if (response.turns.length > 0) {
				await tick();
				chatTimelineRef?.finalizePrepend();
			}
		} catch (error) {
			workspace.sessionStateById = {
				...sessionStateById,
				[sessionId]: {
					...state,
					loadingOlder: false,
					error: {
						kind: "error",
						message:
							error instanceof Error
								? error.message
								: "Failed to load older turns",
					},
				},
			};
		}
	}

	function handleFirstVisible(index: number) {
		if (!activeSessionId) return;
		const state = sessionStateById[activeSessionId];
		if (!state?.hasMore || state.loadingOlder) return;
		if (
			index <= PRELOAD_THRESHOLD &&
			!workspace.isPreloadingSession(activeSessionId)
		) {
			const sessionId = activeSessionId;
			workspace.beginPreloadingSession(sessionId);
			void loadOlderTurns(sessionId).finally(() =>
				workspace.endPreloadingSession(sessionId),
			);
		}
	}

	function restoreSessionStreamSnapshot(
		sessionId: string,
		options?: { turnId?: string | null; force?: boolean },
	) {
		return generationRealtime.restoreSessionStreamSnapshot(sessionId, options);
	}

	function reconcileSessionTail(sessionId: string) {
		return generationRealtime.reconcileSessionTail(sessionId);
	}

	function clearPostSendRecovery(sessionId: string | null | undefined) {
		generationRealtime.clearPostSendRecovery(sessionId);
	}

	function clearAllPostSendRecovery() {
		generationRealtime.clearAllPostSendRecovery();
	}

	function schedulePostSendRecoveryCheck(sessionId: string) {
		generationRealtime.schedulePostSendRecoveryCheck(sessionId);
	}

	async function reconnectSync() {
		if (reconnectSyncInFlight) return reconnectSyncInFlight;
		const run = (async () => {
			await generationRealtime.reconcileAfterReconnect(
				activeSessionId && sessionStateById[activeSessionId]?.loaded
					? activeSessionId
					: null,
			);
			if (activeSessionId && sessionStateById[activeSessionId]?.loaded) {
				const activeState = sessionStateById[activeSessionId];
				const latestTurn =
					activeState?.turns.findLast(
						(turn) =>
							turn.status !== "running" && turn.status !== "abort_requested",
					) ?? activeState?.turns.at(-1);
				if (latestTurn && shouldAutoFollow) {
					unreadTracker.markViewed(
						activeSessionId,
						activeState?.session?.lastMessageId ?? null,
					);
				}
			}
		})();
		reconnectSyncInFlight = run.finally(() => {
			reconnectSyncInFlight = null;
		});
		return reconnectSyncInFlight;
	}

	function applyAcceptedTurnId(input: {
		sessionId: string;
		previousTurnId?: string | null;
		nextTurnId: string;
		confirmedTurn?: SessionTurnRecord | null;
	}) {
		if (input.previousTurnId && input.previousTurnId !== input.nextTurnId) {
			replaceGenerationTurnId(input.sessionId, {
				previousTurnId: input.previousTurnId,
				nextTurnId: input.nextTurnId,
			});
			const current = sessionStateById[input.sessionId];
			if (current) {
				const turns = current.turns.map((turn) => {
					if (turn.id !== input.previousTurnId) return turn;
					const meta = {
						...(turn.meta ?? {}),
						...(input.confirmedTurn?.meta ?? {}),
					};
					delete meta.optimistic;
					return {
						...turn,
						...(input.confirmedTurn ?? {}),
						id: input.nextTurnId,
						userUuid: input.confirmedTurn?.userUuid ?? turn.userUuid,
						authorProfile:
							input.confirmedTurn?.authorProfile ?? turn.authorProfile ?? null,
						provider: input.confirmedTurn?.provider ?? turn.provider,
						model: input.confirmedTurn?.model ?? turn.model,
						meta,
					};
				});
				workspace.sessionStateById = {
					...sessionStateById,
					[input.sessionId]: {
						...current,
						turns: normalizeTurnDuplicates(turns),
					},
				};
			}
			return;
		}
		replaceGenerationTurnId(input.sessionId, { nextTurnId: input.nextTurnId });
	}

	function hydrateTurnOnce(input: {
		sessionId: string;
		turnId: string;
		reason: string;
		onHydrated?: () => void;
	}) {
		const key = `${input.sessionId}:${input.turnId}`;
		const inFlight = turnHydrationInFlight.get(key);
		if (inFlight) return inFlight;
		const run = sdk
			.space(spaceId)
			.session(input.sessionId)
			.turns.get(input.turnId)
			.then(async (response) => {
				const current = sessionStateById[input.sessionId];
				if (!current) return;
				const snapshot = await sessionTurnsRepo.mergeTurns(
					spaceId,
					input.sessionId,
					[response.turn],
					{
						session: response.session ?? current.session ?? null,
						source: "network",
					},
				);
				workspace.sessionStateById = {
					...sessionStateById,
					[input.sessionId]: {
						...current,
						session: snapshot.session ?? current.session,
						turns: snapshot.turns,
					},
				};
				input.onHydrated?.();
			})
			.catch((error) =>
				console.warn(`[${input.reason}] Failed to load full turn:`, error),
			);
		turnHydrationInFlight.set(key, run);
		return run.finally(() => {
			if (turnHydrationInFlight.get(key) === run) {
				turnHydrationInFlight.delete(key);
			}
		});
	}

	async function requestIntermediateSyncForTurn(
		sessionId: string,
		turnId: string | null,
	) {
		const current = sessionGenerationStore.get(sessionId);
		if (turnId && current?.turnId && current.turnId !== turnId) return false;
		return restoreSessionStreamSnapshot(sessionId, {
			turnId,
			force: true,
		});
	}

	function clearIntermediateHandoffIfPersisted(
		sessionId: string,
		turnId: string | null,
	) {
		if (!turnId) return;
		const state = sessionStateById[sessionId];
		const turn = state?.turns.find((item) => item.id === turnId) ?? null;
		if (!turn?.intermediateIndex?.messagesObjectKey) return;
		clearCompletedIntermediateHandoff(sessionId, { turnId });
	}

	function completeGenerationForTurn(sessionId: string, turnId: string | null) {
		const current = sessionGenerationStore.get(sessionId);
		if (turnId && current?.turnId && current.turnId !== turnId) return;
		completeGeneration(sessionId);
	}

	function syncSidebarGenerationFromTurn(
		sessionId: string,
		turn: Partial<SessionTurnRecord> | undefined,
	) {
		if (sessionId === activeSessionId || !turn?.id) return;
		if (isLiveTurnStatus(turn.status)) {
			const userMessageId =
				turn.meta && typeof turn.meta.userMessageId === "string"
					? turn.meta.userMessageId
					: null;
			sessionGenerationStore.resumePending(sessionId, {
				spaceId,
				turnId: turn.id,
				anchorUserMessageId: userMessageId,
			});
			return;
		}
		if (
			turn.status === "completed" ||
			turn.status === "failed" ||
			turn.status === "interrupted" ||
			turn.status === "merged" ||
			turn.status === "cancelled"
		) {
			completeGenerationForTurn(sessionId, turn.id);
		}
	}

	function syncSidebarGenerationFromLifecycle(
		sessionId: string,
		payload: Record<string, unknown>,
	) {
		if (sessionId === activeSessionId || payload.phase !== "llm_call_started")
			return;
		const turnId = typeof payload.turnId === "string" ? payload.turnId : null;
		const anchorUserMessageId =
			typeof payload.anchorUserMessageId === "string"
				? payload.anchorUserMessageId
				: null;
		sessionGenerationStore.markRuntimePhase(sessionId, {
			phase: "llm_call_started",
			at: typeof payload.at === "string" ? payload.at : null,
			llmRound: typeof payload.llmRound === "number" ? payload.llmRound : null,
			provider: typeof payload.provider === "string" ? payload.provider : null,
			model: typeof payload.model === "string" ? payload.model : null,
			spaceId,
			turnId,
			anchorUserMessageId,
		});
	}

	async function handleForkTurn(turn: SessionTurnRecord) {
		if (!activeSessionId || forkingTurnId) return;
		const opSpaceId = spaceId;
		const opSessionId = activeSessionId;
		const parentSession = activeSessionState?.session ?? null;
		forkingTurnId = turn.id;
		clearComposerError();
		try {
			const response = await sdk
				.space(opSpaceId)
				.session(opSessionId)
				.turn(turn.sourceTurnId ?? turn.id)
				.fork();
			if (disposed || spaceId !== opSpaceId) return;
			await sessionTurnsRepo
				.clearSession(opSpaceId, response.session.id)
				.catch(() => undefined);
			if (disposed || spaceId !== opSpaceId) return;
			await syncForkResponseToSessionListCache(
				response.session,
				response.fork as SessionListForkRecord,
				parentSession,
			).catch(() => undefined);
			if (disposed || spaceId !== opSpaceId) return;
			await options.router.toSession(response.session.id);
		} catch (error) {
			if (disposed || spaceId !== opSpaceId) return;
			setComposerError(
				error instanceof Error ? error.message : "Failed to fork session",
			);
		} finally {
			if (spaceId === opSpaceId) forkingTurnId = null;
		}
	}

	async function handleAbort() {
		if (
			!activeSessionId ||
			!activeSessionState?.session ||
			!(options.hasSpace?.() ?? Boolean(spaceId)) ||
			aborting
		)
			return;
		const opSpaceId = spaceId;
		const opSessionId = activeSessionId;
		const opTurnId = activeGenerationState?.turnId ?? null;
		composer.aborting = true;
		clearComposerError();
		try {
			await sdk.space(opSpaceId).session(opSessionId).abort({
				turnId: opTurnId,
			});
			if (disposed || spaceId !== opSpaceId) return;
			interruptGeneration(opSessionId);
		} catch (error) {
			if (disposed || spaceId !== opSpaceId) return;
			setComposerError(
				error instanceof Error ? error.message : "Failed to stop generation",
			);
		} finally {
			if (spaceId === opSpaceId) composer.aborting = false;
		}
	}

	function uniqueComposerRelativePaths(
		entries: Array<{ file: File; relativePath: string }>,
	) {
		const used = new Set<string>();
		return entries.map((entry) => {
			const base = entry.relativePath.trim() || entry.file.name || "file";
			if (!used.has(base)) {
				used.add(base);
				return { ...entry, relativePath: base };
			}
			const dot = base.lastIndexOf(".");
			const stem = dot > 0 ? base.slice(0, dot) : base;
			const ext = dot > 0 ? base.slice(dot) : "";
			let index = 2;
			let candidate = `${stem}-${index}${ext}`;
			while (used.has(candidate)) {
				index += 1;
				candidate = `${stem}-${index}${ext}`;
			}
			used.add(candidate);
			return { ...entry, relativePath: candidate };
		});
	}

	async function materializeDurableUrlsToSandbox(
		opSpaceId: string,
		sessionId: string | null,
		entries: Array<{
			name: string;
			relativePath: string;
			size: number;
			mimeType?: string | null;
			downloadUrl: string;
		}>,
	) {
		if (entries.length === 0) return [] as string[];
		// Deduplicate relative paths while keeping each entry's durable metadata.
		const uniquePaths = uniqueComposerRelativePaths(
			entries.map((entry) => ({
				file: new File([], entry.name),
				relativePath: entry.relativePath,
			})),
		);
		const payload = uniquePaths.map((pathEntry, index) => ({
			name: entries[index].name,
			relativePath: pathEntry.relativePath,
			size: entries[index].size,
			mimeType: entries[index].mimeType ?? null,
			downloadUrl: entries[index].downloadUrl,
		}));
		const uploaded = await materializeSpaceEntries({
			spaceId: opSpaceId,
			destination: {
				kind: "sandbox_tmp",
				...(sessionId ? { sessionId } : {}),
			},
			entries: payload,
		});
		return uploaded.map((file) => file.path);
	}

	async function uploadComposerFileDurables(
		opSpaceId: string,
		sessionId: string | null,
		fileAttachments: ComposerFileAttachment[],
	) {
		if (fileAttachments.length === 0) return new Map<string, string>();
		composer.setUploading("file");
		const urls = new Map<string, string>();
		const results = await Promise.allSettled(
			fileAttachments.map(async (attachment) => {
				const asset = await uploadChatAttachmentFile({
					spaceId: opSpaceId,
					sessionId: sessionId ?? undefined,
					file: attachment.file,
					filename: attachment.name,
					onProgress: ({ ratio }) =>
						composer.setAttachmentUploadProgress(
							attachment.id,
							Math.round(ratio * 100),
						),
				});
				urls.set(attachment.id, asset.publicUrl);
				composer.setAttachmentFinalizing(attachment.id);
			}),
		);
		const failed = results.find((result) => result.status === "rejected");
		if (failed?.status === "rejected") throw failed.reason;
		return urls;
	}

	async function uploadComposerImageDurables(
		opSpaceId: string,
		sessionId: string | null,
		imageAttachments: ComposerImageAttachment[],
	) {
		if (imageAttachments.length === 0) {
			return {
				urls: new Map<string, string>(),
				fileUrls: new Map<string, string>(),
				demotedIds: new Set<string>(),
			};
		}
		composer.setUploading("image");
		const urls = new Map<string, string>();
		const fileUrls = new Map<string, string>();
		const demotedIds = new Set<string>();
		await Promise.all(
			imageAttachments.map(async (attachment) => {
				if (attachment.uploadedUrl) {
					urls.set(attachment.id, attachment.uploadedUrl);
					composer.setAttachmentFinalizing(attachment.id);
					return;
				}
				try {
					const asset = await uploadChatAttachmentImage({
						spaceId: opSpaceId,
						sessionId: sessionId ?? undefined,
						file: attachment.file,
						mediaType: attachment.mediaType,
						filename: attachment.name,
						onProgress: ({ ratio }) =>
							composer.setAttachmentUploadProgress(
								attachment.id,
								Math.round(ratio * 100),
							),
					});
					urls.set(attachment.id, asset.publicUrl);
					composer.setAttachmentFinalizing(attachment.id);
				} catch (error) {
					// Image specialization failed — still upload as a normal durable file.
					demotedIds.add(attachment.id);
					console.warn(
						"[composer] image specialization demoted to file durable",
						{
							name: attachment.name,
							size: attachment.size,
							error,
						},
					);
					try {
						const asset = await uploadChatAttachmentFile({
							spaceId: opSpaceId,
							sessionId: sessionId ?? undefined,
							file: attachment.file,
							filename: attachment.name,
							onProgress: ({ ratio }) =>
								composer.setAttachmentUploadProgress(
									attachment.id,
									Math.round(ratio * 100),
								),
						});
						fileUrls.set(attachment.id, asset.publicUrl);
						composer.setAttachmentFinalizing(attachment.id);
					} catch (fileError) {
						console.warn("[composer] demoted image file durable failed", {
							name: attachment.name,
							error: fileError,
						});
					}
				}
			}),
		);
		if (urls.size > 0) composer.setUploadedImageUrls(urls);
		return { urls, fileUrls, demotedIds };
	}

	function adoptPromptSession(input: {
		session: SessionRecord;
		turn: SessionTurnRecord;
		model: SelectedModel | null;
	}) {
		const { session, turn, model } = input;
		const nextSessions = sortSessionsByRecentActivity([
			session,
			...spaceSessions.filter((item) => item.id !== session.id),
		]);
		void patchCachedSessionList(spaceId, (current) => [
			session,
			...current.filter((item) => item.id !== session.id),
		]).catch(() => undefined);
		seedSessions(nextSessions);
		// Merge with any state already populated by realtime while prompt was in flight.
		// Never clobber turns with [] if WS already delivered session.turn.* events.
		const existing = sessionStateById[session.id];
		const targetSessionState = adoptPromptSessionState({
			existing,
			session,
			turn,
		});
		workspace.sessionStateById = {
			...sessionStateById,
			[session.id]: targetSessionState,
		};
		resolvedNewSessionId = session.id;
		if (model) {
			sessionModelById = {
				...sessionModelById,
				[session.id]: model,
			};
			if (draftSessionModelManuallySelected) {
				saveDraftSessionModel(model);
			}
		}
		workspace.activeSessionId = session.id;
		ensureSessionModelLoaded(session.id);
		applySessionGenerationPolicy(session.id);
		void options.router.toSession(session.id).catch((error) => {
			console.warn("[NewChat] failed to update URL after prompt", error);
		});
		return targetSessionState;
	}

	async function handleDirectGenerationSend() {
		const prompt = input.trim();
		if ((!prompt && attachments.length === 0) || sending || !spaceId) return;
		const selected = activeCreateModelDeclaration;
		if (!selected) {
			composer.setError("No generation model is available.");
			return;
		}
		const sessionIdAtStart =
			activeSessionId ??
			generationDraftSessionId ??
			(isNewSessionRoute ? crypto.randomUUID() : null);
		if (!activeSessionId && isNewSessionRoute)
			generationDraftSessionId = sessionIdAtStart;
		const clientMessageId = crypto.randomUUID();
		composer.sending = true;
		composer.clearError();
		try {
			const imageAttachments = attachments.filter(
				(attachment): attachment is ComposerImageAttachment =>
					attachment.kind === "image",
			);
			const fileAttachments = attachments.filter(
				(attachment): attachment is ComposerFileAttachment =>
					attachment.kind === "file",
			);
			if (fileAttachments.length > 0)
				throw new Error(
					"Create mode supports text and image attachments only.",
				);
			const imageUpload = await uploadComposerImageDurables(
				spaceId,
				sessionIdAtStart,
				imageAttachments,
			);
			const imageUrls = [...imageUpload.urls.values()];
			if (imageUrls.length !== imageAttachments.length)
				throw new Error("Failed to upload an image attachment.");
			const textAttachments = attachments.filter(
				(attachment): attachment is ComposerTextAttachment =>
					attachment.kind === "text",
			);
			const content: GenerationContentBlock[] = [
				...(prompt
					? [{ type: "text", text: prompt } satisfies GenerationContentBlock]
					: []),
				...textAttachments.map(
					(attachment) =>
						({
							type: "text",
							text: attachment.text,
						}) satisfies GenerationContentBlock,
				),
				...imageUrls.map(
					(url) =>
						({
							type: "image",
							source: { type: "url", url },
						}) satisfies GenerationContentBlock,
				),
			];
			const result = await sdk.space(spaceId).prompt({
				mode: "create",
				...(sessionIdAtStart ? { sessionId: sessionIdAtStart } : {}),
				generation: { model: selected.model, content },
				clientMessageId,
				accessMode: "full_access",
				intent: "followup",
				schedule: { mode: "immediate" },
			});
			if (result.mode !== "immediate")
				throw new Error("Expected immediate generation response");
			noteViewerActivity();
			if (shouldClearComposerDraftAfterSend("create")) {
				composer.clearDraft();
				clearActiveComposerDraft();
			}
			const acceptedSessionId = result.session?.id ?? sessionIdAtStart;
			composerSelection = {
				mode: "create",
				modelId: result.turn.model ?? selected.model,
			};
			if (acceptedSessionId) {
				startGenerationRequest(acceptedSessionId, {
					spaceId,
					turnId: result.turn.id,
				});
			}
			if (
				acceptedSessionId &&
				(acceptedSessionId !== sessionIdAtStart || isNewSessionRoute)
			) {
				generationDraftSessionId = null;
				await options.router.toSession(acceptedSessionId);
				preserveComposerInputOnNextDraftKeyChange = true;
			} else if (acceptedSessionId) {
				generationDraftSessionId = null;
				await syncSessionNewer(acceptedSessionId, null);
			}
		} catch (error) {
			composer.setError(
				error instanceof Error ? error.message : "Generation could not start.",
			);
		} finally {
			composer.sending = false;
		}
	}

	function setComposerHarness(harness: "cohub" | "pi" | "codex") {
		if (sending || composerMode === "create") return;
		harnessBySession = { ...harnessBySession, [harnessSelectionKey]: harness };
		clearComposerError();
	}

	function canUseHarness(harness: "cohub" | "pi" | "codex") {
		if (harness === "cohub") return true;
		return Boolean(
			runtimeCatalog?.online &&
				(!runtimeCatalog.observedAt ||
					!isStale(runtimeCatalog.observedAt, Date.now())) &&
				runtimeCatalog.capabilities?.harnesses.includes(harness),
		);
	}

	function setComposerMode(mode: "agent" | "create") {
		if (sending || composerMode === mode) return;
		composerSelection =
			mode === "create"
				? { mode, modelId: activeCreateModelId }
				: { mode: "agent", model: restoredSessionModel };
		showModelSelector = false;
		clearComposerError();
		if (mode === "agent") void loadModelsCatalog();
	}

	function handleCreateModelSelect(modelId: string) {
		const selected = generationModelsCatalog?.find(
			(model) => model.model === modelId,
		);
		if (!selected) return;
		composerSelection = { mode: "create", modelId: selected.model };
		createModelId = selected.model;
		void saveCreateModelPreference(selected.model, getCacheUserKey());
		focusComposerSoon();
	}

	/**
	 * Quick action button above the composer: sends `/name` directly, or prefills
	 * the composer when the prompt declares an argument hint.
	 */
	function handleQuickPromptAction(action: PromptQuickAction) {
		if (sending) return;
		const command = `/${action.name}`;
		if (action.argumentHint) {
			composer.input = `${command} `;
			focusComposerSoon();
			return;
		}
		if (composerMode === "create") setComposerMode("agent");
		composer.input = command;
		void handleSend();
	}

	async function handleSend() {
		if (composerMode === "create") {
			await handleDirectGenerationSend();
			return;
		}
		if (
			(!activeSessionState?.session && !isNewSessionRoute) ||
			(!input.trim() && attachments.length === 0) ||
			sending ||
			!(options.hasSpace?.() ?? Boolean(spaceId))
		)
			return;
		const harness = composerHarness;
		// Fail closed: a disconnected Runtime must never dispatch a local turn.
		if (!canUseHarness(harness)) {
			setComposerError(m.runtime_harness_unavailable());
			return;
		}
		composer.sending = true;
		const model = harness === "cohub" ? activeSessionModel : localModel;
		clearComposerError();
		// Snapshot identity for the whole send pipeline (multi-space host safe).
		const opSpaceId = spaceId;
		const opSessionIdAtStart = activeSessionId;
		clearGenerationError(opSessionIdAtStart);
		// Existing session only — new chat lets prompt create the session server-side.
		let sessionId = activeSessionState?.session?.id ?? null;
		let targetSessionState = activeSessionState;
		const isNewChat = !sessionId;
		const pendingInput = input;
		const pendingAttachments = attachments;
		const optimisticTurnId = crypto.randomUUID();
		const clientMessageId = crypto.randomUUID();
		const currentUser = {
			uuid: authStore.userUuid ?? null,
			profile: authStore.profile,
		};
		let content: ContentBlock[] = [];
		let text = "";
		let hadFileUpload = false;
		let hadImageUpload = false;
		let uploadCompleted = false;
		let uploadedReferenceText = "";
		let uploadedImageUrls = new Map<string, string>();
		let optimisticTurn: SessionTurnRecord | null = null;
		let hasActiveTurn = false;
		try {
			const fileAttachments = attachments.filter(
				(attachment): attachment is ComposerFileAttachment =>
					attachment.kind === "file",
			);
			const imageAttachments = attachments.filter(
				(attachment): attachment is ComposerImageAttachment =>
					attachment.kind === "image",
			);
			hadFileUpload = fileAttachments.length > 0;
			hadImageUpload = imageAttachments.length > 0;

			// Client uploads once to durable public storage.
			// With space, server materializes from those URLs into sandbox (no second client upload).
			const [fileDurableUrls, imageUpload] = await Promise.all([
				uploadComposerFileDurables(opSpaceId, sessionId, fileAttachments),
				uploadComposerImageDurables(opSpaceId, sessionId, imageAttachments),
			]);
			const imageUrls = imageUpload.urls;
			const demotedImageIds = imageUpload.demotedIds;
			const demotedImageFileUrls = imageUpload.fileUrls;
			const durableFileUrls = [
				...fileDurableUrls.values(),
				...demotedImageFileUrls.values(),
			];

			const materializeSource = [
				...fileAttachments.flatMap((attachment) => {
					const url = fileDurableUrls.get(attachment.id);
					if (!url) return [];
					return [
						{
							name: attachment.name,
							relativePath: attachment.relativePath,
							size: attachment.size,
							mimeType: attachment.mediaType,
							downloadUrl: url,
						},
					];
				}),
				...imageAttachments.flatMap((attachment) => {
					const url =
						imageUrls.get(attachment.id) ??
						demotedImageFileUrls.get(attachment.id);
					if (!url) return [];
					return [
						{
							name: attachment.name,
							relativePath: attachment.name,
							size: attachment.size,
							mimeType: attachment.mediaType,
							downloadUrl: url,
						},
					];
				}),
			];
			const sandboxPaths =
				materializeSource.length > 0
					? await materializeDurableUrlsToSandbox(
							opSpaceId,
							sessionId,
							materializeSource,
						).catch((error) => {
							// Durable URL is enough without sandbox.
							console.warn("[composer] sandbox materialize skipped", error);
							return [] as string[];
						})
					: [];

			// Per-attachment delivery: each binary must have durable URL (image or file).
			// Sandbox is additive; durable is the always-on channel without space.
			const undelivered = [
				...fileAttachments.filter(
					(attachment) => !fileDurableUrls.has(attachment.id),
				),
				...imageAttachments.filter(
					(attachment) =>
						!imageUrls.has(attachment.id) &&
						!demotedImageFileUrls.has(attachment.id),
				),
			];
			if (undelivered.length > 0) {
				const names = undelivered
					.map((attachment) => attachment.name)
					.slice(0, 3)
					.join(", ");
				const more =
					undelivered.length > 3 ? ` +${undelivered.length - 3} more` : "";
				throw new Error(
					`Failed to upload ${undelivered.length} attachment${undelivered.length === 1 ? "" : "s"}: ${names}${more}`,
				);
			}
			uploadedImageUrls = imageUrls;
			uploadCompleted = true;
			const userText = input.trim();
			if (disposed || spaceId !== opSpaceId) {
				// Host left this space while upload was in flight — drop results.
				return;
			}
			const pendingViewportContexts = viewport.takeSendSnapshot();
			// Prefer sandbox paths when available; otherwise durable public URLs.
			const referenceText = sandboxPaths.length
				? buildFileReferencesText(sandboxPaths)
				: [
						buildFileReferencesText(durableFileUrls),
						buildImageReferencesText([...imageUrls.values()]),
					]
						.filter(Boolean)
						.join("\n\n");
			uploadedReferenceText = referenceText;
			text = [userText, referenceText].filter(Boolean).join("\n\n");
			const attachmentBlocks: ContentBlock[] = attachments.flatMap(
				(attachment) => {
					if (attachment.kind === "file") return [];
					if (attachment.kind === "text")
						return [buildComposerTextContentBlock(attachment)];
					// Image specialization only: durable URL → image content block.
					// Demoted images keep durable file URL in text refs, no image block.
					if (demotedImageIds.has(attachment.id)) return [];
					const url = imageUrls.get(attachment.id);
					if (!url) return [];
					return [
						{
							type: "image",
							source: {
								type: "url",
								url,
							},
							_meta: {
								filename: attachment.name,
								mediaType: attachment.mediaType,
								size: attachment.size,
							},
						} satisfies ContentBlock,
					];
				},
			);
			const viewportBlock = buildViewportContentBlock(pendingViewportContexts);
			const mentions = extractSpaceMentionsFromText(text);
			content = [
				...(text
					? [
							{
								type: "text",
								text,
								_meta: mentions.length > 0 ? { mentions } : undefined,
							} satisfies ContentBlock,
						]
					: []),
				...(viewportBlock ? [viewportBlock] : []),
				...attachmentBlocks,
			];

			// Clear input immediately so it disappears from the composer at the same
			// time the optimistic turn appears in the list — avoids the awkward "stuck"
			// feeling where the message shows in the list but lingers in the input.
			if (shouldClearComposerDraftAfterSend("agent")) {
				composer.clearDraft();
				clearActiveComposerDraft();
			}

			// Existing chat: optimistic turn before prompt.
			// New chat: wait for prompt (server creates session); keep sending state.
			if (!isNewChat && sessionId && targetSessionState?.session) {
				const now = new Date().toISOString();
				const sequenceHint =
					(targetSessionState.turns.at(-1)?.sequence ?? 0) + 1;
				hasActiveTurn = activeSessionIsRunning;
				optimisticTurn = {
					id: optimisticTurnId,
					sessionId,
					userUuid: currentUser.uuid,
					sequence: sequenceHint,
					status: hasActiveTurn ? "queued" : "running",
					intent: "followup",
					userContent: content,
					userText: text,
					assistantContent: null,
					assistantText: null,
					provider: model?.provider ?? null,
					model: model?.id ?? null,
					stopReason: null,
					errorMessage: null,
					finalUsage: null,
					totalUsage: null,
					summary: null,
					intermediateIndex: null,
					intermediateSummary: null,
					meta: {
						optimistic: true,
						harness,
						userId: currentUser.uuid,
						clientMessageId,
					},
					authorProfile: currentUser.profile,
					startedAt: now,
					completedAt: null,
					durationMs: null,
					createdAt: now,
					updatedAt: now,
				} as SessionTurnRecord;
				workspace.sessionStateById = {
					...sessionStateById,
					[sessionId]: {
						...targetSessionState,
						turns: mergeTurnsById(targetSessionState.turns, [optimisticTurn], {
							preferIncoming: true,
						}),
					},
				};
				// Sending a message is an explicit intent to jump back to the live edge.
				scroll.shouldAutoFollow = true;
				await tick();
				requestBottomFollow({ immediate: true });
				if (!hasActiveTurn)
					startGenerationRequest(sessionId, {
						spaceId: opSpaceId,
						turnId: optimisticTurnId,
					});
			}

			const sendResult = await sdk.space(opSpaceId).prompt({
				// Omit sessionId for new chat — server creates it.
				...(sessionId ? { sessionId } : {}),
				content,
				model: model?.id,
				provider: model?.provider,
				harness,
				...(harness === "cohub" && activeSessionThinkingLevel
					? { thinkingLevel: activeSessionThinkingLevel }
					: {}),
				clientMessageId,
				...(harness === "cohub"
					? { generationPolicy: buildTurnGenerationPolicy() }
					: {}),
				accessMode: "full_access",
				intent: "followup",
				schedule: { mode: "immediate" },
			});
			if (sendResult.mode !== "immediate") {
				throw new Error("Expected immediate prompt response");
			}
			// The server accepted the prompt even if this host moved elsewhere.
			// Invalidate before the UI-only early return so Recent revalidates later.
			noteViewerActivity();
			// Prompt already accepted server-side. If we left the space, skip local
			// adopt; other hosts / re-enter will load via WS or session fetch.
			if (disposed || spaceId !== opSpaceId) {
				return;
			}
			const acceptedTurn = sendResult.turn;
			const acceptedSession = sendResult.session;
			if (!acceptedSession) throw new Error("Prompt response missing session");
			const acceptedTurnWithProfile = {
				...acceptedTurn,
				userUuid: acceptedTurn.userUuid ?? currentUser.uuid,
				authorProfile:
					acceptedTurn.authorProfile ?? currentUser.profile ?? null,
			};

			if (isNewChat) {
				targetSessionState = adoptPromptSession({
					session: acceptedSession,
					turn: acceptedTurnWithProfile,
					model,
				});
				sessionId = acceptedSession.id;
				startGenerationRequest(sessionId, {
					spaceId: opSpaceId,
					turnId: acceptedTurn.id,
				});
				scroll.shouldAutoFollow = true;
			} else if (sessionId) {
				applyAcceptedTurnId({
					sessionId,
					previousTurnId: optimisticTurnId,
					nextTurnId: acceptedTurn.id,
					confirmedTurn: acceptedTurn,
				});
				upsertSessionRecord(acceptedSession);
			}

			const current = sessionId ? sessionStateById[sessionId] : null;
			if (!isNewChat && sessionId && current) {
				workspace.sessionStateById = {
					...sessionStateById,
					[sessionId]: {
						...current,
						session: acceptedSession,
						turns: normalizeTurnDuplicates(
							mergeTurnsById(current.turns, [acceptedTurnWithProfile], {
								preferIncoming: true,
							}),
						),
					},
				};
			}
			if (isNewChat && sessionId) {
				void sessionTurnsRepo
					.mergeTurns(opSpaceId, sessionId, [acceptedTurnWithProfile], {
						session: acceptedSession,
						hasMoreOlder: false,
						hasMoreNewer: false,
						source: "network",
					})
					.catch((error) =>
						console.warn("[NewChat] failed to cache accepted turn", error),
					);
			}
			// The accepted turn now owns the explicit request state. Clear the local
			// override only after merging it to avoid briefly showing the older level.
			if (sessionId) {
				const nextThinkingLevels = { ...sessionThinkingLevelById };
				delete nextThinkingLevels[sessionId];
				sessionThinkingLevelById = nextThinkingLevels;
			}
			draftThinkingLevel = null;
			if (sessionId && options.getConnectionState() !== "open") {
				schedulePostSendRecoveryCheck(sessionId);
			}
			for (const attachment of pendingAttachments)
				revokeComposerAttachmentPreview(attachment);
			viewport.markSendSucceeded();
			if (isNewChat) {
				await tick();
				requestBottomFollow({ immediate: true });
			}
		} catch (error) {
			// Always persist failed draft against the originating space/session key so
			// a mid-send space switch cannot permanently lose the message.
			const failedDraftText =
				(hadFileUpload || hadImageUpload) && uploadCompleted
					? [pendingInput.trim(), uploadedReferenceText]
							.filter(Boolean)
							.join("\n\n")
					: pendingInput;
			const failedDraftScope =
				sessionId != null
					? { kind: "session" as const, sessionId }
					: { kind: "new" as const };
			const failedDraftKey = sessionComposerDraftKey(
				opSpaceId,
				failedDraftScope,
			);
			if (failedDraftText.trim()) {
				writeSessionComposerDraftText(failedDraftKey, failedDraftText);
			}
			// Restore UI only if we still own the originating space/session context.
			if (disposed || spaceId !== opSpaceId) {
				return;
			}
			// Restore input and attachments on failure so user doesn't lose their message
			viewport.restoreAfterFailedSend();
			if ((hadFileUpload || hadImageUpload) && uploadCompleted) {
				composer.restoreDraft(
					[pendingInput.trim(), uploadedReferenceText]
						.filter(Boolean)
						.join("\n\n"),
					pendingAttachments
						.filter((attachment) => attachment.kind !== "file")
						.map((attachment) =>
							attachment.kind === "image"
								? {
										...attachment,
										status: "ready" as const,
										uploadedUrl:
											uploadedImageUrls.get(attachment.id) ??
											attachment.uploadedUrl,
									}
								: attachment,
						),
				);
			} else {
				composer.restoreDraft(pendingInput, pendingAttachments);
			}
			preserveComposerInputOnNextDraftKeyChange = true;
			if ((hadFileUpload || hadImageUpload) && !uploadCompleted) {
				composer.markAttachmentUploadsFailed();
			}
			const rawSendError =
				error instanceof Error ? error.message : "Failed to send message";
			// Safari often surfaces Headers/URL/FormData failures as this opaque TypeError.
			const sendError =
				rawSendError === "The string did not match the expected pattern."
					? "Could not send request. Your session may be invalid — try refreshing or signing in again."
					: rawSendError;
			const sendErrorCode = getHttpErrorCode(error);
			const displayError =
				hadFileUpload || hadImageUpload
					? uploadCompleted
						? "Message failed. Attachments were uploaded."
						: "Upload failed. Please try again."
					: sendError;
			setComposerError(displayError, sendErrorCode);
			if (sessionId)
				failGeneration(sessionId, sendError, { errorCode: sendErrorCode });
			const current = sessionId ? sessionStateById[sessionId] : null;
			const failedSessionId = sessionId;
			if (current && optimisticTurn && failedSessionId) {
				const failedAt = new Date().toISOString();
				const failedTurn = {
					id: optimisticTurnId,
					sessionId: failedSessionId,
					userUuid: currentUser.uuid,
					sequence: optimisticTurn.sequence,
					status: hasActiveTurn ? "cancelled" : "failed",
					intent: "followup",
					userContent: content,
					userText: text,
					assistantContent: null,
					assistantText: null,
					provider: optimisticTurn.provider,
					model: optimisticTurn.model,
					stopReason: "error",
					errorMessage: displayError,
					finalUsage: null,
					totalUsage: null,
					summary: null,
					intermediateIndex: null,
					intermediateSummary: null,
					meta: {
						...(optimisticTurn.meta ?? {}),
						localOnly: true,
						failedAt,
					},
					authorProfile: currentUser.profile,
					startedAt: optimisticTurn.startedAt,
					completedAt: failedAt,
					durationMs: null,
					createdAt: optimisticTurn.createdAt,
					updatedAt: failedAt,
				} as SessionTurnRecord;
				workspace.sessionStateById = {
					...sessionStateById,
					[failedSessionId]: {
						...current,
						turns: mergeTurnsById(
							current.turns.filter((turn) => turn.id !== optimisticTurnId),
							[failedTurn],
							{ preferIncoming: true },
						),
					},
				};
			}
		} finally {
			composer.sending = false;
		}
	}

	function isRestoringSessionScroll(sessionId = activeSessionId) {
		if (!sessionId) return false;
		return (
			scroll.pendingRestoreSessionId === sessionId ||
			scroll.activeAnchorRestore?.sessionId === sessionId
		);
	}

	function clearAnchorRestoreRetry() {
		if (anchorRestoreRetryTimer) {
			clearTimeout(anchorRestoreRetryTimer);
			anchorRestoreRetryTimer = null;
		}
		anchorRestoreWaitStartedAt = 0;
		anchorRestoreRetryStep = 0;
	}

	function beginAnchorRestoreWait() {
		if (anchorRestoreWaitStartedAt === 0) {
			anchorRestoreWaitStartedAt = Date.now();
			anchorRestoreRetryStep = 0;
		}
		scheduleAnchorRestoreRetry();
	}

	function hasActiveAnchorWindowLoad(sessionId: string) {
		for (const key of scrollAnchorWindowLoads) {
			if (key.startsWith(`${sessionId}:`)) return true;
		}
		return false;
	}

	/**
	 * Safety net only: turn merges, markdown renders, and resizes re-run the
	 * reactive restore path. Ticks back off so a stuck restore costs a handful
	 * of cheap checks instead of a polling loop. Expiry is evaluated inside
	 * the timer only — never synchronously from an effect.
	 */
	function scheduleAnchorRestoreRetry() {
		if (anchorRestoreRetryTimer || anchorRestoreWaitStartedAt === 0) return;
		const delay =
			SESSION_SCROLL_RESTORE_RETRY_DELAYS_MS[
				Math.min(
					anchorRestoreRetryStep,
					SESSION_SCROLL_RESTORE_RETRY_DELAYS_MS.length - 1,
				)
			];
		anchorRestoreRetryStep += 1;
		anchorRestoreRetryTimer = setTimeout(() => {
			anchorRestoreRetryTimer = null;
			if (
				Date.now() - anchorRestoreWaitStartedAt >=
				SESSION_SCROLL_RESTORE_TIMEOUT_MS
			) {
				expireAnchorRestore();
				return;
			}
			maybeCompleteAnchorRestore();
			scheduleAnchorRestoreRetry();
		}, delay);
	}

	function expireAnchorRestore() {
		const sessionId =
			scroll.activeAnchorRestore?.sessionId ?? scroll.pendingRestoreSessionId;
		if (!sessionId || activeSessionId !== sessionId) {
			clearAnchorRestoreRetry();
			return;
		}
		const state = sessionStateById[sessionId];
		const dataInFlight = Boolean(
			state?.loading ||
				pendingTailReconcileSessionId === sessionId ||
				pendingTimelineMarkdownRenders > 0 ||
				turnLoading.loadingTurnSequence != null ||
				hasActiveAnchorWindowLoad(sessionId),
		);
		if (dataInFlight) {
			// Turns or markdown are still arriving; keep waiting for the target.
			anchorRestoreWaitStartedAt = Date.now();
			anchorRestoreRetryStep = 0;
			scheduleAnchorRestoreRetry();
			return;
		}
		// The saved target never became restorable: default to the latest turn.
		clearSessionScrollAnchor(sessionId);
		restoreSessionScrollToBottom(sessionId);
	}

	function restoreSessionScrollToBottom(sessionId: string) {
		if (disposed || activeSessionId !== sessionId) return;
		if (!getSessionScrollList(sessionId)) return;
		cancelSessionScrollRestore(sessionId);
		restoringBottomSessionId = sessionId;
		scroll.shouldAutoFollow = true;
		requestAnimationFrame(() => {
			if (restoringBottomSessionId !== sessionId) return;
			scrollToBottomNow();
			if (restoringBottomSessionId === sessionId) {
				restoringBottomSessionId = null;
			}
		});
	}

	function isSameActiveAnchorRestore(
		restore: SessionScrollAnchor & { sessionId: string },
	) {
		const current = scroll.activeAnchorRestore;
		return Boolean(
			current &&
				current.sessionId === restore.sessionId &&
				current.itemKey === restore.itemKey &&
				current.turnSequence === restore.turnSequence &&
				current.kind === restore.kind,
		);
	}

	/** Scroll events fire many times per gesture; capture once per frame. */
	function scheduleScrollAnchorCapture(sessionId: string) {
		if (scrollCaptureFrame != null) return;
		scrollCaptureFrame = requestAnimationFrame(() => {
			scrollCaptureFrame = null;
			if (disposed || activeSessionId !== sessionId) return;
			captureCurrentScrollAnchor(sessionId);
		});
	}

	function cancelSessionScrollRestore(sessionId: string) {
		// No-op when nothing is mid-restore: bumping scrollRestoreGeneration
		// unconditionally re-invalidates the restore effect on every call even
		// when there is no restore to cancel — the same signal-change-without-
		// transition bug clearTurnMarkers had. Only transition when a restore
		// actually exists for this session.
		if (
			scroll.activeAnchorRestore?.sessionId !== sessionId &&
			scroll.pendingRestoreSessionId !== sessionId &&
			restoringBottomSessionId !== sessionId
		) {
			return;
		}
		++scrollRestoreGeneration;
		clearAnchorRestoreRetry();
		if (scroll.activeAnchorRestore?.sessionId === sessionId) {
			scroll.activeAnchorRestore = null;
		}
		if (scroll.pendingRestoreSessionId === sessionId) {
			scroll.pendingRestoreSessionId = null;
		}
		if (restoringBottomSessionId === sessionId) {
			restoringBottomSessionId = null;
		}
	}

	function scrollToBottomNow() {
		if (!activeSessionId) return;
		const list = getSessionScrollList(activeSessionId);
		if (!list) return;
		const bottom = scroll.getTimelineBottomScrollTop();
		// Already pinned: skip the scrollTop write, the metrics refresh and the
		// epoch rAF. During streaming this path is reached from several sources
		// (stream follow, ResizeObserver, markdown rendered) per content change;
		// only the first one after a height change needs to do any work.
		if (Math.abs(list.scrollTop - bottom) <= 1) {
			markSessionFollowingTail(activeSessionId);
			return;
		}
		setProgrammaticScrollTop(bottom);
		markSessionFollowingTail(activeSessionId);
	}

	function requestBottomFollow(options?: { immediate?: boolean }) {
		// Never overwrite a mid-session restore with bottom follow.
		if (isRestoringSessionScroll()) return;
		if (!scroll.shouldPinToBottom(options)) return;
		scrollToBottomNow();
	}

	async function forceScrollToBottom() {
		await tick();
		await new Promise<void>((resolve) => {
			requestAnimationFrame(() => {
				scrollToBottomNow();
				resolve();
			});
		});
	}

	function updateAutoFollow() {
		scroll.updateAutoFollow();
	}

	function updateCurrentTurnSequence() {
		if (!activeSessionId) return;
		const list = getSessionScrollList(activeSessionId);
		if (!list) return;
		const geometry = scroll.getTurnAnchorGeometry(activeSessionId);
		// Same probe as before: ~35% down the viewport, capped at 160px.
		const probe = list.scrollTop + Math.min(160, list.clientHeight * 0.35);
		const next = findCurrentTurnAnchorSequence(geometry, probe);
		if (currentTurnSequence !== next) currentTurnSequence = next;
	}

	function clearProgrammaticScroll() {
		programmaticScrollEpoch += 1;
		programmaticScrollActive = false;
		programmaticScrollTarget = null;
	}

	function setProgrammaticScrollTop(scrollTop: number) {
		if (!activeSessionId) return;
		const list = getSessionScrollList(activeSessionId);
		if (!list) return;
		const nextScrollTop = Math.min(
			Math.max(0, list.scrollHeight - list.clientHeight),
			Math.max(0, scrollTop),
		);
		const epoch = ++programmaticScrollEpoch;
		programmaticScrollActive = true;
		programmaticScrollTarget = nextScrollTop;
		userScrollActive = false;
		list.scrollTop = nextScrollTop;
		updateTimelineScrollMetrics();
		requestAnimationFrame(() => {
			if (programmaticScrollEpoch === epoch) clearProgrammaticScroll();
		});
	}

	function beginUserScroll() {
		if (!activeSessionId) return;
		userScrollActive = true;
		clearProgrammaticScroll();
		cancelSessionScrollRestore(activeSessionId);
	}

	function handleScrollKeydown(event: KeyboardEvent) {
		if (
			event.key === "ArrowDown" ||
			event.key === "ArrowUp" ||
			event.key === "PageDown" ||
			event.key === "PageUp" ||
			event.key === "Home" ||
			event.key === "End" ||
			event.key === " "
		) {
			beginUserScroll();
		}
	}

	function maybeCompleteAnchorRestore() {
		const restore = activeAnchorRestore;
		if (!restore) return;
		if (activeSessionId !== restore.sessionId) return;
		// Cached turns are enough to apply: the authoritative tail only appends
		// content below the anchor, so the saved position stays stable.
		const result = applyActiveAnchorRestore(restore);
		if (result !== "complete") {
			scheduleAnchorRestoreRetry();
			return;
		}
		// Keep re-applying while data or markdown can still shift the layout.
		const state = sessionStateById[restore.sessionId];
		const waitingForLayout =
			Boolean(
				state?.loading || pendingTailReconcileSessionId === restore.sessionId,
			) || pendingTimelineMarkdownRenders > 0;
		if (
			waitingForLayout &&
			anchorRestoreWaitStartedAt > 0 &&
			Date.now() - anchorRestoreWaitStartedAt <
				SESSION_SCROLL_RESTORE_TIMEOUT_MS
		) {
			scheduleAnchorRestoreRetry();
			return;
		}
		if (scroll.activeAnchorRestore?.sessionId !== restore.sessionId) return;
		clearAnchorRestoreRetry();
		if (scroll.pendingRestoreSessionId === restore.sessionId) {
			scroll.pendingRestoreSessionId = null;
		}
		scroll.activeAnchorRestore = null;
		scroll.scheduleTurnMarkerMeasure();
		updateAutoFollow();
		markLatestTurnViewedIfVisible(restore.sessionId);
	}

	function applyActiveAnchorRestore(restore = activeAnchorRestore) {
		if (!restore || activeSessionId !== restore.sessionId) {
			return "missing" as const;
		}
		const list = getSessionScrollList(restore.sessionId);
		const node = findSessionScrollAnchorNode(restore.sessionId, restore);
		if (!list || !node) return "missing" as const;
		const target = resolveSessionScrollRestore({
			anchorTop: getMessageElementAbsoluteTop(node),
			anchorOffset: restore.offset,
			scrollHeight: list.scrollHeight,
			clientHeight: list.clientHeight,
		});
		scroll.shouldAutoFollow = false;
		// A partially rendered timeline can clamp the desired position to zero.
		// Keep the current viewport untouched until the saved target is reachable.
		if (!target.reached) return "pending" as const;
		setProgrammaticScrollTop(target.scrollTop);
		return "complete" as const;
	}

	function areSessionScrollAnchorsEqual(
		current: SessionScrollAnchor | null | undefined,
		next: SessionScrollAnchor | null | undefined,
	) {
		return Boolean(
			current &&
				next &&
				current.itemKey === next.itemKey &&
				current.turnSequence === next.turnSequence &&
				current.kind === next.kind &&
				current.offset === next.offset &&
				current.updatedAt === next.updatedAt,
		);
	}

	function restoreSessionScrollAnchorSoon(sessionId: string) {
		const anchor = getSessionScrollAnchor(sessionId);
		if (!anchor) return;
		const restore = { ...anchor, sessionId };
		if (!isSameActiveAnchorRestore(restore)) {
			scroll.activeAnchorRestore = restore;
		}
		beginAnchorRestoreWait();
		requestAnimationFrame(() => {
			if (activeSessionId !== sessionId) return;
			maybeCompleteAnchorRestore();
		});
	}

	function handleTimelineMarkdownRenderStart() {
		scroll.pendingTimelineMarkdownRenders += 1;
	}

	function handleTimelineMarkdownRendered() {
		if (pendingTimelineMarkdownRenders > 0)
			scroll.pendingTimelineMarkdownRenders -= 1;
		scroll.scheduleTurnMarkerMeasureThrottled();
		if (activeAnchorRestore?.sessionId === activeSessionId) {
			// Keep the leave position pinned while content height settles.
			requestAnimationFrame(() => maybeCompleteAnchorRestore());
			return;
		}
		if (
			activeSessionId &&
			!isRestoringSessionScroll(activeSessionId) &&
			(restoringBottomSessionId === activeSessionId || shouldAutoFollow)
		) {
			requestBottomFollow();
		}
	}

	async function handlePickAttachments(
		files: FileList | File[] | LocalUploadEntry[] | null,
	) {
		await composer.handlePickAttachments(files);
	}

	async function applyBackgroundComposerPayload(
		payload: NewChatComposerApplyPayload,
	) {
		if (typeof payload.prompt === "string") {
			composer.input = payload.prompt;
		}
		if (payload.model && modelsCatalog) {
			const catalogItem = modelsCatalog.find(
				(item) =>
					item.provider === payload.model?.provider &&
					item.id === payload.model?.id,
			);
			if (catalogItem) {
				const selected = {
					provider: catalogItem.provider,
					id: catalogItem.id,
					name: catalogItem.model.name as string | undefined,
				} satisfies SelectedModel;
				draftSessionModel = selected;
				if (activeSessionId) {
					sessionModelById = {
						...sessionModelById,
						[activeSessionId]: selected,
					};
				}
			}
		}
		const imageEntries = (payload.images ?? []).filter(
			(image): image is { url: string; name?: string } =>
				typeof image.url === "string" && image.url.startsWith("https://"),
		);
		if (imageEntries.length > 0) {
			try {
				const files = await Promise.all(
					imageEntries.map(async (image) => {
						const response = await fetch(image.url);
						if (!response.ok) {
							throw new Error(`Failed to load image: ${image.url}`);
						}
						const blob = await response.blob();
						if (!blob.type.startsWith("image/")) {
							throw new Error(`Unsupported image type: ${image.url}`);
						}
						return new File([blob], image.name ?? "image", { type: blob.type });
					}),
				);
				await handlePickAttachments(files);
			} catch (error) {
				console.warn(
					"[NewChat] failed to apply background payload images",
					error,
				);
			}
		}
	}

	function handleRemoveAttachment(id: string) {
		composer.handleRemoveAttachment(id);
	}

	function focusComposerSoon() {
		requestAnimationFrame(() => {
			window.dispatchEvent(new CustomEvent("cohub:composer-focus"));
		});
	}

	async function ingestRealtimeEnvelope(payload: ChannelEnvelope) {
		if (disposed) return;
		try {
			if (payload.type === "space.fs.changed") {
				const eventPayload = payload.payload as SpaceFsChangedPayload;
				if (shouldRefreshAgentCatalogs(eventPayload))
					await loadPromptTemplates({ ensureFresh: true });
				return;
			}
			// Shell owns ports and labels; chat only consumes session events.
			if (
				payload.type === "space.ports.changed" ||
				payload.type === "label.assignments.updated"
			) {
				return;
			}
			if (
				payload.type === "session.created" ||
				payload.type === "session.updated"
			) {
				const session = payload.payload.session as SessionRecord | undefined;
				if (session?.id) applySessionRealtimeRecord(session);
				return;
			}
			const targetSessionId =
				typeof payload.sessionId === "string" ? payload.sessionId : null;
			if (!targetSessionId) return;
			if (typeof payload.spaceId === "string" && payload.spaceId !== spaceId) {
				return;
			}
			const currentActiveSessionId = activeSessionId;
			const isActiveSession = targetSessionId === currentActiveSessionId;
			if (
				payload.type === "session.turn.created" ||
				payload.type === "session.turn.updated" ||
				payload.type === "session.turn.finalized"
			) {
				const turn = payload.payload.turn as SessionTurnRecord | undefined;
				syncSidebarGenerationFromTurn(targetSessionId, turn);
				if (turn?.id && Array.isArray(turn.userContent)) {
					void sessionTurnsRepo
						.mergeTurns(spaceId, targetSessionId, [turn], {
							preferIncoming: true,
							source: "network",
						})
						.catch((error) =>
							console.warn(
								"[session-chat] failed to cache realtime turn",
								error,
							),
						);
				}
			} else if (payload.type === "session.turn.lifecycle") {
				syncSidebarGenerationFromLifecycle(targetSessionId, payload.payload);
			}
			if (payload.type === "session.request.accepted") {
				clearPostSendRecovery(targetSessionId);
				return;
			}
			if (payload.type === "session.request.error") {
				const requestError = payload.payload as {
					code?: string;
					message?: string;
					clientMessageId?: string | null;
					billing?: { conversion?: unknown } | null;
				};
				const message =
					requestError.message?.trim() || "Message request failed";
				const code =
					typeof requestError.code === "string" ? requestError.code : null;
				const conversion =
					extractBillingPayload(requestError)?.conversion ?? null;
				if (conversion) {
					billingConversion.openFromIntent(conversion);
				} else if (isBillingAccessBlockedCode(code)) {
					billingConversion.openFallbackHard();
				}
				failGeneration(targetSessionId, message, { errorCode: code });
				if (isActiveSession) setComposerError(message, code);
				clearPostSendRecovery(targetSessionId);
				return;
			}
			let state = sessionStateById[targetSessionId];
			if (!state) {
				if (payload.type === "session.turn.created") {
					void loadSessionState(targetSessionId);
				}
				if (payload.type === "session.turn.finalized") {
					const turnId =
						typeof (payload.payload.turn as { id?: unknown } | undefined)
							?.id === "string"
							? (payload.payload.turn as { id: string }).id
							: null;
					completeGenerationForTurn(targetSessionId, turnId);
				}
				return;
			}
			if (payload.type === "session.turn.created") {
				const turn = payload.payload.turn as SessionTurnRecord | undefined;
				if (turn?.id) {
					const clientMessageId = getTurnClientMessageId(turn);
					const optimisticTurn = state.turns.find(
						(item) =>
							isOptimisticTurn(item) &&
							isSameClientMessageTurn(item, clientMessageId),
					);
					if (optimisticTurn?.id && optimisticTurn.id !== turn.id) {
						applyAcceptedTurnId({
							sessionId: targetSessionId,
							previousTurnId: optimisticTurn.id,
							nextTurnId: turn.id,
							confirmedTurn: turn,
						});
						state = sessionStateById[targetSessionId] ?? state;
					}
					const current = sessionStateById[targetSessionId] ?? state;
					const reconciled = reconcileOptimisticTurn(current.turns, turn);
					workspace.sessionStateById = {
						...sessionStateById,
						[targetSessionId]: {
							...current,
							turns: normalizeTurnDuplicates(reconciled.turns),
						},
					};
				}
				return;
			}
			if (
				payload.type === "session.turn.finalized" ||
				payload.type === "session.turn.updated"
			) {
				const turnPatch = payload.payload.turn as
					| Partial<SessionTurnRecord>
					| undefined;
				const normalizedTurnPatch = turnPatch
					? {
							...turnPatch,
							finalUsage:
								turnPatch.finalUsage ??
								(turnPatch as { usage?: SessionTurnRecord["finalUsage"] })
									.usage ??
								null,
						}
					: undefined;
				const turnId =
					typeof normalizedTurnPatch?.id === "string"
						? normalizedTurnPatch.id
						: null;
				if (!turnId) return;
				const existingTurn =
					state.turns.find((turn) => turn.id === turnId) ?? null;
				if (existingTurn) {
					const patchedTurn = {
						...existingTurn,
						...normalizedTurnPatch,
					} as SessionTurnRecord;
					workspace.sessionStateById = {
						...sessionStateById,
						[targetSessionId]: {
							...state,
							turns: normalizeTurnDuplicates(
								mergeTurnsById(state.turns, [patchedTurn], {
									preferIncoming: true,
								}),
							),
						},
					};
					clearIntermediateHandoffIfPersisted(targetSessionId, turnId);
					if (
						patchedTurn.executionKind === "direct_generation" &&
						["completed", "failed", "interrupted", "cancelled"].includes(
							patchedTurn.status,
						)
					) {
						completeGenerationForTurn(targetSessionId, turnId);
					}
				}
				const terminalDirectGeneration =
					(normalizedTurnPatch?.executionKind === "direct_generation" ||
						existingTurn?.executionKind === "direct_generation") &&
					["completed", "failed", "interrupted", "cancelled"].includes(
						normalizedTurnPatch?.status ?? "",
					);
				if (
					!existingTurn ||
					payload.type === "session.turn.finalized" ||
					terminalDirectGeneration
				) {
					void hydrateTurnOnce({
						sessionId: targetSessionId,
						turnId,
						reason: "turn.event",
						onHydrated:
							payload.type === "session.turn.finalized" ||
							terminalDirectGeneration
								? () => {
										completeGenerationForTurn(targetSessionId, turnId);
										clearIntermediateHandoffIfPersisted(
											targetSessionId,
											turnId,
										);
									}
								: undefined,
					});
				}
				if (isActiveSession && shouldAutoFollow) {
					await tick();
					requestBottomFollow();
				}
				return;
			}
			return;
		} catch (error) {
			console.error("[WS] handleWsEvent error:", error);
		}
	}
	function handleRemoveViewportContext(id: string) {
		viewport.dismiss(id);
	}

	function handleCreateNewSession() {
		if (!access.canCreateSession) return;
		createSessionError = "";
		void options.router
			.toNewSession()
			.then(() => {
				// Defense in depth: route sync also clears these when entering /new.
				resolvedNewSessionId = null;
				workspace.activeSessionId = null;
				scroll.pendingRestoreSessionId = null;
				scroll.activeAnchorRestore = null;
				pendingTailReconcileSessionId = null;
				clearProgrammaticScroll();
				currentTurnSequence = null;
				showTurnBottomSheet = false;
				scroll.shouldAutoFollow = true;
				focusComposerSoon();
			})
			.catch((error) => {
				createSessionError =
					error instanceof Error ? error.message : "Failed to open new chat";
			});
	}

	function enterSpace(nextSpaceId: string) {
		if (disposed) return;
		// Soft clear: no space selected (e.g. Sessions empty state).
		if (!nextSpaceId) {
			if (activeSessionId) captureCurrentScrollAnchor(activeSessionId);
			if (spaceId) flushActiveComposerDraft();
			spaceId = "";
			resolvedNewSessionId = null;
			createSessionError = "";
			forkingTurnId = null;
			workspace.reset();
			turnLoading.reset();
			turnHydrationInFlight.clear();
			clearAllPostSendRecovery();
			generationPolicy.apply(null);
			generationRealtime.resetForSpaceChange();
			currentTurnSequence = null;
			highlightedTurnSequence = null;
			scroll.resetSessionScrollUi();
			pendingTailReconcileSessionId = null;
			clearAnchorRestoreRetry();
			clearProgrammaticScroll();
			scrollAnchorWindowLoads.clear();
			lastTurnIndexRefreshKey = "";
			showTurnBottomSheet = false;
			appliedRouteTurnKey = null;
			share.reset();
			tasks.reset();
			sessionModelById = {};
			draftSessionModel = null;
			draftSessionModelManuallySelected = false;
			route = { kind: "none" };
			composer.sending = false;
			composer.aborting = false;
			releaseGenerationLease();
			return;
		}
		if (spaceId === nextSpaceId) return;
		const previous = spaceId;
		if (previous && activeSessionId)
			captureCurrentScrollAnchor(activeSessionId);
		if (previous) flushActiveComposerDraft();
		// Multi-host safe: host-local lease tracking; only last leaver resets store.
		acquireGenerationLease(nextSpaceId);
		spaceId = nextSpaceId;
		resolvedNewSessionId = null;
		createSessionError = "";
		forkingTurnId = null;
		composer.sending = false;
		composer.aborting = false;
		workspace.reset();
		turnLoading.reset();
		turnHydrationInFlight.clear();
		clearAllPostSendRecovery();
		generationPolicy.apply(null);
		generationRealtime.resetForSpaceChange();
		currentTurnSequence = null;
		highlightedTurnSequence = null;
		scroll.resetSessionScrollUi();
		pendingTailReconcileSessionId = null;
		clearAnchorRestoreRetry();
		clearProgrammaticScroll();
		scrollAnchorWindowLoads.clear();
		lastTurnIndexRefreshKey = "";
		showTurnBottomSheet = false;
		appliedRouteTurnKey = null;
		share.reset();
		tasks.reset();
		sessionModelById = {};
		draftSessionModel = null;
		draftSessionModelManuallySelected = false;
		promptTemplatesCtrl.restore(nextSpaceId);
		skillsCtrl.restore(nextSpaceId);
		void loadPromptTemplates();
		loadSessionScrollAnchors();
		route = { kind: "none" };
	}

	function isSameAccess(current: SessionChatAccess, next: SessionChatAccess) {
		return (
			current.spaceLoadError === next.spaceLoadError &&
			current.spaceHasMinimalAccess === next.spaceHasMinimalAccess &&
			current.canCreateSession === next.canCreateSession &&
			current.bootstrapping === next.bootstrapping
		);
	}

	function isSameRoute(current: SessionChatRoute, next: SessionChatRoute) {
		if (current.kind !== next.kind) return false;
		if (current.kind === "session" && next.kind === "session") {
			return (
				current.sessionId === next.sessionId &&
				current.turnSequence === next.turnSequence
			);
		}
		return true;
	}

	function syncContext(input: SessionChatContext) {
		if (disposed) return;
		if (input.spaceId !== spaceId) enterSpace(input.spaceId);
		if (!isSameAccess(access, input.access)) {
			access = { ...input.access };
		}
		const prev = route;
		if (!isSameRoute(route, input.route)) {
			route = input.route;
		}

		if (route.kind === "session") {
			if (
				shouldClearResolvedNewSessionOnRoute({
					nextKind: "session",
					prevKind: prev.kind,
				})
			) {
				resolvedNewSessionId = null;
			}
			if (activeSessionId !== route.sessionId) {
				if (activeSessionId) captureCurrentScrollAnchor(activeSessionId);
				prepareRouteSession(route.sessionId);
				void loadSessionState(route.sessionId);
				void loadTurnIndex(route.sessionId);
			} else {
				const state = sessionStateById[route.sessionId];
				if (state && !state.loaded && !state.loading) {
					void loadSessionState(route.sessionId);
				}
			}
			if (route.turnSequence) {
				const key = `${route.sessionId}:${route.turnSequence}`;
				// Only act when the requested turn actually changes. Running this on
				// every syncContext pass cancels the restore (and bumps
				// scrollRestoreGeneration) on a no-op, which re-invalidated the
				// restore effect and drove the effect_update_depth_exceeded loop.
				if (appliedRouteTurnKey !== key) {
					appliedRouteTurnKey = key;
					cancelSessionScrollRestore(route.sessionId);
					scroll.shouldAutoFollow = false;
					void jumpToTurn(route.turnSequence);
				}
			}
			return;
		}

		if (route.kind === "new") {
			// Fresh draft entry (from another route): always clear the previous
			// session so a still-streaming chat cannot paint into the empty draft.
			// Keep resolvedNewSessionId only while we stay on /new after adopt
			// (prompt created a session, URL has not switched to /:id yet).
			if (
				shouldClearResolvedNewSessionOnRoute({
					nextKind: "new",
					prevKind: prev.kind,
				})
			) {
				resolvedNewSessionId = null;
			}
			const draftActiveSessionId = activeSessionId;
			if (
				shouldClearActiveSessionForNewDraft({
					resolvedNewSessionId,
					activeSessionId: draftActiveSessionId,
				}) &&
				draftActiveSessionId
			) {
				captureCurrentScrollAnchor(draftActiveSessionId);
				workspace.activeSessionId = null;
				scroll.pendingRestoreSessionId = null;
				scroll.activeAnchorRestore = null;
				userScrollActive = false;
				clearProgrammaticScroll();
				pendingTailReconcileSessionId = null;
				currentTurnSequence = null;
				showTurnBottomSheet = false;
			}
			appliedRouteTurnKey = null;
			return;
		}

		if (
			shouldClearResolvedNewSessionOnRoute({
				nextKind: "none",
				prevKind: prev.kind,
			})
		) {
			resolvedNewSessionId = null;
		}
		if (activeSessionId) {
			captureCurrentScrollAnchor(activeSessionId);
			workspace.activeSessionId = null;
			scroll.pendingRestoreSessionId = null;
			scroll.activeAnchorRestore = null;
			userScrollActive = false;
			clearProgrammaticScroll();
			pendingTailReconcileSessionId = null;
			currentTurnSequence = null;
			showTurnBottomSheet = false;
		}
		appliedRouteTurnKey = null;
	}

	function onTransportOpen() {
		generationRealtime.onTransportOpen();
	}
	function onConnectionRecovered() {
		void reconnectSync();
	}
	function onVisibilityChanged(visible: boolean) {
		if (!visible) {
			if (activeSessionId) captureCurrentScrollAnchor(activeSessionId);
			return;
		}
		void refreshSessionsList(false);
		if (activeSessionId && sessionStateById[activeSessionId]?.loaded) {
			void reconcileSessionTail(activeSessionId);
		}
	}

	function reportActiveSource(source: ActiveViewportSource) {
		viewport.setActiveSource(source);
	}
	function reportFileVisibleLines(
		path: string,
		range: { start: number; end: number } | null,
	) {
		if (!path) return;
		viewport.setFileVisibleLines(path, range);
	}
	function reportBoardView(state: BoardViewportObservation) {
		viewport.setBoardViewState(state.path, {
			visibleRect: state.visibleRect,
			selectedNodes: state.selectedNodes,
		});
	}

	async function renameActiveSession(title: string) {
		if (!activeSessionId) return null;
		const trimmed = title.trim();
		if (!trimmed) return null;
		const result = await sdk
			.space(spaceId)
			.session(activeSessionId)
			.rename(trimmed);
		workspace.spaceSessions = spaceSessions.map((s) =>
			s.id === activeSessionId ? result.session : s,
		);
		void patchCachedSessionList(spaceId, (current) =>
			current.map((s) => (s.id === activeSessionId ? result.session : s)),
		).catch(() => undefined);
		if (sessionStateById[activeSessionId]) {
			workspace.sessionStateById = {
				...sessionStateById,
				[activeSessionId]: {
					...sessionStateById[activeSessionId],
					session: result.session,
				},
			};
		}
		return result.session;
	}

	function dispose() {
		if (disposed) return;
		disposed = true;
		if (pageHideHandler && typeof window !== "undefined") {
			window.removeEventListener("pagehide", pageHideHandler);
			pageHideHandler = null;
		}
		if (scrollCaptureFrame != null) {
			cancelAnimationFrame(scrollCaptureFrame);
			scrollCaptureFrame = null;
		}
		clearAnchorRestoreRetry();
		if (activeSessionId) captureCurrentScrollAnchor(activeSessionId);
		// Flush any trailing anchor write so a dispose-then-close cannot drop it.
		persistSessionScrollAnchorsNow();
		flushActiveComposerDraft();
		generationRealtime.dispose();
		share.dispose();
		composer.dispose();
		viewport.dispose();
		scroll.stopVimScroll();
		scroll.clearPendingVimG();
		scroll.cancelTurnMarkerMeasure();
		clearAllPostSendRecovery();
		composer.sending = false;
		composer.aborting = false;
		// Release generation lease only if this host still holds it.
		releaseGenerationLease();
	}

	function onLoadToolCalls(input: {
		turn: SessionTurnRecord;
		message: StoredIntermediateMessage;
	}) {
		return loadMessageToolCalls({
			spaceId,
			sessionId: input.turn.sessionId,
			turnId: input.turn.sourceTurnId ?? input.turn.id,
			message: input.message,
		});
	}
	function onLoadIntermediate(turn: SessionTurnRecord) {
		return loadTurnIntermediate({
			spaceId,
			sessionId: turn.sessionId,
			turnId: turn.sourceTurnId ?? turn.id,
			messagesObjectKey: turn.intermediateIndex?.messagesObjectKey ?? null,
		});
	}
	function onRequestIntermediateSync(turn: SessionTurnRecord) {
		return requestIntermediateSyncForTurn(turn.sessionId, turn.id);
	}

	return {
		get spaceId() {
			return spaceId;
		},
		get access() {
			return access;
		},
		get isNewSessionRoute() {
			return isNewSessionRoute;
		},
		get activeSessionId() {
			return activeSessionId;
		},
		get activeSession() {
			return activeSessionState?.session;
		},
		get activeSessionState() {
			return activeSessionState;
		},
		get activeSessionInitialLoadingVisible() {
			return activeSessionInitialLoadingVisible;
		},
		get createSessionError() {
			return createSessionError;
		},
		set createSessionError(v: string) {
			createSessionError = v;
		},
		get timeline() {
			return timeline;
		},
		get activeSessionIsRunning() {
			return activeSessionIsRunning;
		},
		get forkingTurnId() {
			return forkingTurnId;
		},
		get modelsCatalog() {
			return modelsCatalog;
		},
		get activeSessionModel() {
			return activeSessionModel;
		},
		get activeGenerationModel() {
			return activeGenerationModel;
		},
		get createModelId() {
			return activeCreateModelDeclaration?.model ?? null;
		},
		/** Model recorded on the session from server turns (no draft/override). */
		get activeSessionTurnModel() {
			return activeSessionLastTurnModel;
		},
		get activeSessionThinkingLevel() {
			return activeSessionThinkingLevel;
		},
		get activeSessionThinkingLevelLabel() {
			if (!activeSessionThinkingLevel) return null;
			return formatThinkingLevelShort(activeSessionThinkingLevel);
		},
		get generationPolicyLabel() {
			return generationPolicyLabel;
		},
		get composerMode() {
			return composerMode;
		},
		get composerHarness() {
			return composerHarness;
		},
		setComposerHarness,
		loadRuntimeCatalog,
		get runtimeCatalog() {
			return runtimeCatalog;
		},
		get localModel() {
			return localModel;
		},
		setLocalModel(model: SelectedModel | null) {
			localModelsBySession = {
				...localModelsBySession,
				[`${harnessSelectionKey}:${composerHarness}`]: model,
			};
		},
		get generationModelsCatalog() {
			return generationModelsCatalog;
		},
		get generationModelsLoading() {
			return generationPolicy.modelsCatalogLoading;
		},
		get generationModelsLoaded() {
			return generationPolicy.modelsCatalogLoaded;
		},
		get generationModelsError() {
			return generationPolicy.modelsCatalogError;
		},
		get generationPolicyMode() {
			return generationPolicyMode;
		},
		get selectedGenerationModels() {
			return selectedGenerationModels;
		},
		get generationEnumSelections() {
			return generationEnumSelections;
		},
		get generationNumericConstraints() {
			return generationNumericConstraints;
		},
		get generationBooleanConstraints() {
			return generationBooleanConstraints;
		},
		get promptTemplates() {
			return promptTemplates;
		},
		get promptTemplatesLoaded() {
			return promptTemplatesLoaded;
		},
		get quickPromptActions() {
			return quickPromptActions;
		},
		handleQuickPromptAction,
		get skills() {
			return skills;
		},
		get skillsLoaded() {
			return skillsLoaded;
		},
		get input() {
			return composer.input;
		},
		set input(v: string) {
			composer.input = v;
		},
		get attachments() {
			return attachments;
		},
		get sending() {
			return sending;
		},
		get aborting() {
			return aborting;
		},
		get composerNotice() {
			return composerNotice;
		},
		get composerShowsBillingAction() {
			return composerShowsBillingAction;
		},
		get showModelSelector() {
			return showModelSelector;
		},
		set showModelSelector(v: boolean) {
			showModelSelector = v;
		},
		get composerHostEl() {
			return composerHostEl;
		},
		set composerHostEl(v: HTMLDivElement | null) {
			composerHostEl = v;
		},
		get chatChromeEl() {
			return chatChromeEl;
		},
		set chatChromeEl(v: HTMLDivElement | null) {
			chatChromeEl = v;
		},
		get viewportContexts() {
			return viewportContexts;
		},
		get listEl() {
			return scroll.listEl;
		},
		set listEl(v: HTMLDivElement | null) {
			scroll.listEl = v;
		},
		get chatTimelineRef() {
			return scroll.chatTimelineRef;
		},
		set chatTimelineRef(v: unknown) {
			scroll.chatTimelineRef = v as typeof scroll.chatTimelineRef;
		},
		get shouldAutoFollow() {
			return scroll.shouldAutoFollow;
		},
		set shouldAutoFollow(v: boolean) {
			scroll.shouldAutoFollow = v;
		},
		get hasUnread() {
			return hasUnread;
		},
		get composerHeight() {
			return composerHeight;
		},
		set composerHeight(v: number) {
			scroll.composerHeight = v;
		},
		get chatChromeHeight() {
			return chatChromeHeight;
		},
		set chatChromeHeight(v: number) {
			scroll.chatChromeHeight = v;
		},
		get turnMarkerPositions() {
			return turnMarkerPositions;
		},
		get turnMarkerHeights() {
			return turnMarkerHeights;
		},
		get timelineScrollTop() {
			return timelineScrollTop;
		},
		get timelineScrollHeight() {
			return timelineScrollHeight;
		},
		get timelineClientHeight() {
			return timelineClientHeight;
		},
		get activeTurnRailItems() {
			return activeTurnRailItems;
		},
		get unloadedOlderTurnCount() {
			return unloadedOlderTurnCount;
		},
		get unloadedNewerTurnCount() {
			return unloadedNewerTurnCount;
		},
		get currentTurnSequence() {
			return currentTurnSequence;
		},
		get loadingTurnSequence() {
			return loadingTurnSequence;
		},
		get highlightedTurnSequence() {
			return highlightedTurnSequence;
		},
		get showTurnBottomSheet() {
			return showTurnBottomSheet;
		},
		set showTurnBottomSheet(v: boolean) {
			showTurnBottomSheet = v;
		},
		get followupQueue() {
			return followupQueue;
		},
		get pendingFollowupActionIds() {
			return pendingFollowupActionIds;
		},
		// Shell still needs share dialog + vim scroll controllers.
		share,
		scroll,
		enterSpace,
		syncContext,
		ingestRealtimeEnvelope,
		onTransportOpen,
		onConnectionRecovered,
		onVisibilityChanged,
		reportActiveSource,
		reportFileVisibleLines,
		reportBoardView,
		flushComposerDraft: flushActiveComposerDraft,
		refreshSessions: refreshSessionsList,
		renameActiveSession,
		dispose,
		handleSend,
		setComposerMode,
		handleAbort,
		handleForkTurn,
		handleSteerFollowup,
		handleCancelFollowup,
		handlePickAttachments,
		handleRemoveAttachment,
		handleRemoveViewportContext,
		handleFirstVisible,
		handleTimelineMarkdownRenderStart,
		handleTimelineMarkdownRendered,
		jumpToTurn,
		beginUserScroll,
		scrollToBottomNow,
		updateCurrentTurnSequence,
		loadSessionScrollAnchors,
		persistSessionScrollAnchorsNow,
		jumpToTurnAndUpdateUrl,
		setProgrammaticScrollTop,
		snapScrollToNearestTurn,
		forceScrollToBottom,
		loadOlderTurns,
		syncSessionNewer,
		loadTurnIndex,
		loadSessionState,
		prepareRouteSession,
		seedSessions,
		applySessionsSnapshot,
		upsertSessionRecord,
		handleCreateNewSession,
		loadModelsCatalog,
		loadGenerationModelsCatalog,
		loadPromptTemplates,
		handleModelSelect,
		handleCreateModelSelect,
		setGenerationPolicyMode,
		setGenerationModelSelected,
		setGenerationEnumValueSelected,
		setGenerationNumericConstraint,
		setGenerationBooleanConstraint,
		turnPreviewText,
		onLoadToolCalls,
		onLoadIntermediate,
		onRequestIntermediateSync,
		applyBackgroundComposerPayload,
		openShareModal: (sessionId: string) => share.openFor(sessionId),
		openPath: (target: string | WorkspaceFileLinkTarget) =>
			options.openPath(target),
		resolveWorkspaceAsset: options.resolveWorkspaceAsset,
		captureCurrentScrollAnchor,
	};
}

export type SessionChatHost = ReturnType<typeof createSessionChatHost>;
