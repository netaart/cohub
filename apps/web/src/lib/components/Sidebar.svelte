<script lang="ts">
import type {
	AppRecord,
	BillingCreditStatus,
	CheckpointRecord,
	CronJobRecord,
	LabelAssignmentListItem,
	LabelListItem,
	SessionForkRecord,
	SessionRecord,
	SpaceRecord,
	TaskRunRecord,
} from "@neta-art/cohub";
import { taskRunToBoardTaskSnapshot as taskBoardSnapshot } from "@neta-art/cohub/board";
import {
	Activity,
	ArrowLeft,
	BarChart3,
	BookOpen,
	Check,
	ChevronDown,
	Clock,
	CreditCard,
	Download,
	FolderKanban,
	Gift,
	History,
	Keyboard,
	Loader2,
	LogOut,
	MessageSquare,
	Network,
	NotebookPen,
	PanelLeftClose,
	PanelLeftOpen,
	Pencil,
	Plus,
	Rocket,
	Save,
	Search,
	Settings,
	Tags,
	Trash2,
	X,
} from "lucide-svelte";
import { onMount, tick, untrack } from "svelte";
import { goto } from "$app/navigation";
import { page } from "$app/state";
import { floatNear } from "$lib/actions/portal";
import { logtoClient } from "$lib/auth";
import { handleUnauthorizedError } from "$lib/auth-redirect";
import { clearAllIndexedDbCache } from "$lib/cache/clear";
import { canUseUserScopedCache, getCacheUserKey } from "$lib/cache/keys";
import { clearCachedPaletteOverview } from "$lib/command-palette/palette-overview";
import ChannelProviderIcon from "$lib/components/ChannelProviderIcon.svelte";
import NewLabelPopover from "$lib/components/NewLabelPopover.svelte";
import SidebarFlyout from "$lib/components/SidebarFlyout.svelte";
import SpaceAvatar from "$lib/components/SpaceAvatar.svelte";
import SidebarCheckpointRow from "$lib/components/sidebar/SidebarCheckpointRow.svelte";
import SidebarFallbackResourceRow from "$lib/components/sidebar/SidebarFallbackResourceRow.svelte";
import SidebarFileRow from "$lib/components/sidebar/SidebarFileRow.svelte";
import SidebarSessionRow from "$lib/components/sidebar/SidebarSessionRow.svelte";
import UserAvatar from "$lib/components/UserAvatar.svelte";
import { downloadCohubDebugBundle } from "$lib/debugger";
import {
	type CohubResourceDragPayload,
	getCohubResourceDragData,
	getFirstCohubResource,
	hasCohubResourceDragData,
	isLabelAssignableResource,
	type LabelAssignableCohubResource,
	setCohubResourceDragData,
} from "$lib/drag/cohub-resource-drag";
import { pointerDragSource } from "$lib/drag/pointer-drag.svelte";
import {
	APPS_CHANGED_EVENT,
	type AppsChangedDetail,
	createAppMutationBuffer,
	upsertAppSnapshot,
} from "$lib/features/app/app-realtime";
import { appActionName } from "$lib/features/space/modules/task-run-utils";
import { withSidebarMainWindow } from "$lib/features/space/modules/window-route";
import { extractGenerationPromptPreview } from "$lib/generation-task-media";
import { getLocale } from "$lib/i18n/locale.svelte";
import { isComposingKeyboardEvent } from "$lib/keyboard";
import { hydrateLabelItemsById } from "$lib/labels/label-resource-hydrator";
import {
	addResourceToLabel,
	moveResourceToLabel,
	type ResourceLabelMutationResult,
	removeResourceFromLabel,
} from "$lib/labels/resource-label-actions";
import { formatResourceMentionTextForDisplay } from "$lib/mentions/resource";
import { m } from "$lib/paraglide/messages.js";
import { sdk } from "$lib/sdk";
import {
	mergeSessionRecord,
	mergeSessionRecords,
} from "$lib/session-record-merge";
import {
	getSessionSortTime,
	sortSessionsByRecentActivity,
} from "$lib/session-sort";
import {
	buildSessionsRoute,
	buildSpaceActivityRoute,
	buildSpaceAppRoute,
	buildSpaceCheckpointNewRoute,
	buildSpaceCheckpointRoute,
	buildSpaceCronjobNewRoute,
	buildSpaceCronjobRoute,
	buildSpaceLandingRoute,
	buildSpaceNewSessionRoute,
	buildSpaceSessionRoute,
	buildSpaceSettingsRoute,
	buildSpaceTaskRoute,
} from "$lib/space-routes";
import { clearGrantedAppScopes } from "$lib/stores/app-grant-cache";
import { authStore } from "$lib/stores/auth.svelte";
import { billingCatalogStore } from "$lib/stores/billing-catalog.svelte";
import { insertComposerSnippet } from "$lib/stores/composer-insert";
import { modelsCatalogStore } from "$lib/stores/models-catalog.svelte";
import {
	clearRecentSpace,
	getRecentSpace,
	setRecentSpace,
} from "$lib/stores/recent-space";
import {
	fetchSessionDetailWithCache,
	getCachedSessionDetails,
	setCachedSessionDetails,
} from "$lib/stores/session-detail-cache";
import {
	clearAllCachedSessionLists,
	getCachedSessionListSnapshot,
	onSessionListCacheUpdated,
	patchCachedSessionList,
	setCachedSessionList,
} from "$lib/stores/session-list-cache";
import {
	getCachedExpandedLabelIdsSnapshot,
	setCachedExpandedLabelIds,
} from "$lib/stores/sidebar-label-expanded";
import {
	ALL_CHATS_LABEL_ID,
	buildOptimisticWebAppLabelSessionItem,
	findDefaultExpandedLabelId,
	findSessionUserLabel,
	findSessionUserRootLabel,
	findWebAppSourceLabel,
	getDisplayLabels,
	getSourceLabels,
	getSystemChannelLabels,
	getSystemUserLabels,
	isSystemLabel,
	isWebSessionSource,
	SESSION_SOURCE_LABEL_SYSTEM_KEY_PREFIX,
} from "$lib/stores/sidebar-source-labels";
import {
	fetchLabelItemsFirstPageFresh,
	fetchSpaceLabelsFresh,
	flattenLabels,
	flattenLabelsWithRefs,
	getCachedLabelItemsSnapshot,
	getCachedSpaceLabelsSnapshot,
	getLabelChannelInfo,
	getLabelDisplayName,
	getLabelDisplayTitle,
	getLabelRefById,
	getLabelUserProfile,
	hydrateChannelLabelsForLabels,
	hydrateUserProfilesForLabels,
	isSessionChannelLabel,
	isSessionUserLabel,
	LABEL_ITEMS_PAGE_SIZE,
	markLabelItemsStale,
	onChannelLabelDisplayNamesUpdated,
	onSpaceLabelsCacheUpdated,
	onUserLabelProfilesUpdated,
} from "$lib/stores/space-labels";
import {
	clearAllCachedSpaceLists,
	fetchSpaceListWithCache,
	getCachedSpaceList,
	getCachedSpaceListMeta,
	onSpaceListCacheUpdated,
} from "$lib/stores/space-list-cache";
import {
	cacheSpaceRecordSoon,
	getCachedSpaceRecord,
} from "$lib/stores/space-record-cache";
import {
	clearTaskRunsMemoryCache,
	getCachedTaskRuns,
	onTaskRunsCacheUpdated,
	restoreCachedTaskRuns,
	setCachedTaskRuns,
} from "$lib/stores/task-runs-cache";
import { uiState } from "$lib/stores/ui.svelte";
import { formatCompactAbsoluteTime } from "$lib/time-format";
import { clearActivityCache } from "$lib/user-activity";
import { resolveWorkspaceRouteContext } from "$lib/workspace-route";

const {
	isMobile = false,
	onClose,
	mode = "space",
	collapsed = false,
}: {
	isMobile?: boolean;
	onClose?: () => void;
	mode?: "space" | "settings";
	collapsed?: boolean;
} = $props();

const locale = $derived(getLocale());

const SESSION_PAGE_SIZE = 20;
const CHECKPOINT_PAGE_SIZE = 20;
const TASK_PAGE_SIZE = 10;

let sidebarRootEl: HTMLElement | null = $state(null);
let userMenuAnchorEl: HTMLDivElement | null = $state(null);
let expandedUserMenuAnchorEl: HTMLDivElement | null = $state(null);
let showUserMenu = $state(false);
// Hydrate synchronously from the local cache so a freshly mounted sidebar
// (e.g. the mobile drawer, which unmounts on close) can resolve the current
// space on first paint instead of flashing the empty "Select a space" state
// while loadSpaces() awaits auth + IndexedDB + network. Only use a non-guest
// partition when identity is already known; otherwise start empty.
let spaces = $state<SpaceRecord[]>(
	canUseUserScopedCache() ? (getCachedSpaceList() ?? []) : [],
);
let sessions = $state<SessionRecord[]>([]);
type SessionForkSidebarRecord = Partial<SessionForkRecord> & {
	childSessionId: string;
	parentSessionId?: string | null;
	depth: number;
	anchorSequence?: number | null;
	createdAt?: string;
	firstUserTextAfterFork?: string | null;
	parentTitle?: string | null;
};
type SidebarSessionItem = {
	session: SessionRecord;
	depth: number;
	visualDepth: number;
	isFork: boolean;
	parentVisible: boolean;
	isLastVisibleChild: boolean;
	fork: SessionForkSidebarRecord | null;
	displayTitle: string;
	titleText: string | undefined;
	ariaLabel: string;
};
let sessionForks = $state<SessionForkSidebarRecord[]>([]);
let checkpoints = $state<CheckpointRecord[]>([]);
let labels = $state<LabelListItem[]>([]);
let labelItemsBySpace = $state<
	Record<string, Record<string, LabelAssignmentListItem[]>>
>({});
let userLabelProfileVersion = $state(0);
let channelLabelDisplayVersion = $state(0);
let labelSessionDetailsBySpace = $state<
	Record<string, Record<string, SessionRecord>>
>({});
let labelSessionDetailsLoadingBySpace = $state<Record<string, Set<string>>>({});
let labelItemsPageInfoBySpace = $state<
	Record<
		string,
		Record<string, { hasMore: boolean; nextCursor: string | null }>
	>
>({});
let expandedLabelIdsBySpace = $state<Record<string, Set<string>>>({});
let loadingLabelIdsBySpace = $state<Record<string, Set<string>>>({});
/** Per space+label load tokens so stale finally blocks cannot clear a newer load. */
const labelItemsLoadTokens = new Map<string, number>();
/** Hard stop so a hung await never leaves label rows on Loading… forever. */
const LABEL_ITEMS_LOADING_WATCHDOG_MS = 8_000;
const labelItemsLoadingWatchdogs = new Map<
	string,
	ReturnType<typeof setTimeout>
>();
let showNewLabelPopover = $state(false);
let loadingSessions = $state(false);
let loadingSessionsSpaceId = $state<string | null>(null);
let loadingMoreSessions = $state(false);
let refreshingSessions = $state(false);
let sessionsPageInfo = $state<{ hasMore: boolean; nextCursor: string | null }>({
	hasMore: false,
	nextCursor: null,
});
/** Network fetch for All chats is deferred until All is expanded (cache still hydrates first paint). */
let sessionsNetworkEnabledBySpace = $state<Record<string, boolean>>({});
let exhaustedFallbackSessionCursor = $state<string | null>(null);
let loadingCheckpoints = $state(false);
let loadingMoreCheckpoints = $state(false);
let loadingLabels = $state(false);
let refreshingLabels = $state(false);
/** Bumped when the active space changes so in-flight label loads cannot clobber UI. */
let labelsLoadToken = 0;
let loadingCheckpointsSpaceId = $state<string | null>(null);
let checkpointsPageInfo = $state<{
	hasMore: boolean;
	nextCursor: string | null;
}>({ hasMore: false, nextCursor: null });
let billingCredit = $state<BillingCreditStatus | null>(null);
let billingCreditLoading = $state(false);
let billingCreditError = $state<string | null>(null);
let refreshingSpaces = $state(false);
let billingCreditUserId = $state<string | null>(null);
let billingConfigured = $state<boolean | null>(null);
let billingSubscriptionName = $state<string | null>(null);
const modelsCatalog = $derived(modelsCatalogStore.items);

let checkpointsCollapsed = $state(false);
let chatsCollapsed = $state(false);
let labelsCollapsed = $state(false);
let labelDropTargetId = $state<string | null>(null);
let labelDropBusyId = $state<string | null>(null);
let labelDropSuccessId = $state<string | null>(null);
let labelDropErrorId = $state<string | null>(null);
let labelDropErrorMessage = $state<string | null>(null);
type LabelDragOrigin = {
	labelId: string;
	labelRef: string;
	labelName?: string;
};
let activeLabelDragOrigin: LabelDragOrigin | null = null;
let labelAutoExpandTimer: ReturnType<typeof setTimeout> | null = null;
let labelDropFeedbackTimer: ReturnType<typeof setTimeout> | null = null;
let cronjobsCollapsed = $state(false);
let tasksCollapsed = $state(true);
let worksCollapsed = $state(false);
let creatingSession = $state(false);
let createSessionError = $state("");
const sidebarFlyoutPreviewLimit = 24;

// Session rename state
const SESSION_ROW_NAVIGATE_DELAY_MS = 120;
let renamingSessionId = $state<string | null>(null);
let renameTitleValue = $state("");
let renameSaving = $state(false);
let renameInputElement: HTMLInputElement | null = $state(null);
let sessionNavigateClickTimer: ReturnType<typeof setTimeout> | null = null;

// Label rename state
let renamingLabelId = $state<string | null>(null);
let renameLabelValue = $state("");
let renameLabelSaving = $state(false);
let renameLabelInputElement: HTMLInputElement | null = $state(null);
let deletingLabelId = $state<string | null>(null);

let cronjobs = $state<CronJobRecord[]>([]);
let tasks = $state<TaskRunRecord[]>([]);
let apps = $state<AppRecord[]>([]);
/**
 * Realtime mutations seen while a full list request is in flight, replayed onto
 * the response so a publish mid-load cannot hide the Space's other apps.
 */
const appsBuffer = createAppMutationBuffer();
let loadingCronjobs = $state(false);
let refreshingCheckpoints = $state(false);
let loadingCronjobsSpaceId = $state<string | null>(null);
let loadingTasks = $state(false);
let refreshingCronjobs = $state(false);
let loadingTasksSpaceId = $state<string | null>(null);
let refreshingTasks = $state(false);
let loadingMoreTasks = $state(false);
let tasksPageInfo = $state<{ hasMore: boolean; nextCursor: string | null }>({
	hasMore: false,
	nextCursor: null,
});
let loadingApps = $state(false);
let loadingAppsSpaceId = $state<string | null>(null);
let refreshingApps = $state(false);

const currentPath = $derived(page.url.pathname);
const isSessionsRoute = $derived(
	currentPath === "/sessions" || currentPath.startsWith("/sessions/"),
);
const workspaceRoute = $derived(
	resolveWorkspaceRouteContext({
		pathname: currentPath,
		searchParams: page.url.searchParams,
		pageData: page.data as { spaceId?: unknown; sessionId?: unknown },
		params: { id: page.params.id },
	}),
);
const currentSpaceId = $derived(workspaceRoute.spaceId);
const activeSessionId = $derived(workspaceRoute.sessionId);
const activeAppId = $derived(workspaceRoute.appId);
const activeCheckpointId = $derived(workspaceRoute.checkpointId);
const activeCronjobId = $derived(workspaceRoute.cronjobId);
const activeTaskId = $derived(workspaceRoute.taskId);
const activeLabelResource = $derived(workspaceRoute.labelResource);

const activeSession = $derived.by(() => {
	if (!activeSessionId) return null;
	return (
		sessions.find((s) => s.id === activeSessionId) ??
		(currentSpaceId
			? (labelSessionDetailsBySpace[currentSpaceId]?.[activeSessionId] ?? null)
			: null)
	);
});
const activeApp = $derived(apps.find((app) => app.id === activeAppId) ?? null);
const activeCheckpoint = $derived(
	checkpoints.find((checkpoint) => checkpoint.id === activeCheckpointId) ??
		null,
);
const sidebarSessionItems = $derived.by(() =>
	buildSidebarSessionItems(sessions),
);
const activeCronjob = $derived(
	cronjobs.find((job) => job.id === activeCronjobId) ?? null,
);

const currentSpace = $derived(
	currentSpaceId ? (spaces.find((s) => s.id === currentSpaceId) ?? null) : null,
);
const canAssignLabels = $derived(
	Boolean(currentSpace?.access?.permissions?.includes("space.label.assign")),
);
const canManageLabels = $derived(
	Boolean(currentSpace?.access?.permissions?.includes("space.label.manage")),
);
const currentLabelSessionDetails = $derived(
	currentSpaceId ? (labelSessionDetailsBySpace[currentSpaceId] ?? {}) : {},
);
const sessionsById = $derived.by(
	() => new Map(sessions.map((session) => [session.id, session])),
);
const labelSessionsById = $derived.by(() => {
	const byId = new Map<string, SessionRecord>();
	const preferRicher = (
		existing: SessionRecord | undefined,
		incoming: SessionRecord,
	) => {
		if (!existing) return incoming;
		if (sessionIsRicher(incoming, existing)) return incoming;
		if (sessionIsRicher(existing, incoming)) return existing;
		return mergeSessionRecord(existing, incoming);
	};
	for (const session of sessions) byId.set(session.id, session);
	for (const session of Object.values(currentLabelSessionDetails)) {
		byId.set(session.id, preferRicher(byId.get(session.id), session));
	}
	return byId;
});
const checkpointsById = $derived.by(
	() => new Map(checkpoints.map((checkpoint) => [checkpoint.id, checkpoint])),
);
const currentLabelItemsById = $derived.by(() =>
	currentSpaceId
		? hydrateLabelItemsById(
				currentSpaceId,
				labelItemsBySpace[currentSpaceId] ?? {},
				{
					sessions: [...sessions, ...Object.values(currentLabelSessionDetails)],
				},
			)
		: {},
);
const currentLabelItemsPageInfoById = $derived(
	currentSpaceId ? (labelItemsPageInfoBySpace[currentSpaceId] ?? {}) : {},
);
const currentExpandedLabelIds = $derived(
	currentSpaceId
		? (expandedLabelIdsBySpace[currentSpaceId] ?? new Set<string>())
		: new Set<string>(),
);
const currentLoadingLabelIds = $derived(
	currentSpaceId
		? (loadingLabelIdsBySpace[currentSpaceId] ?? new Set<string>())
		: new Set<string>(),
);
const sourceLabels = $derived(getSourceLabels(labels));
const systemChannelLabels = $derived(getSystemChannelLabels(labels));
const systemUserLabels = $derived(getSystemUserLabels(labels));
const displayLabels = $derived(getDisplayLabels(labels));
const userDisplayName = $derived(
	authStore.profile?.displayName?.trim() || m.common_user({}, { locale }),
);

let billingCreditRequest: Promise<boolean> | null = null;
let billingPlanRequest: Promise<void> | null = null;
const showBillingBalanceEntry = $derived(
	billingConfigured !== false &&
		(billingCreditLoading ||
			Boolean(billingCredit) ||
			Boolean(billingCreditError)),
);
const currentSubscriptionName = $derived(billingSubscriptionName);

function clearBillingCredit() {
	billingCredit = null;
	billingCreditLoading = false;
	billingCreditError = null;
	billingCreditUserId = null;
	billingConfigured = null;
	billingSubscriptionName = null;
}

function markBillingUnavailable() {
	billingCredit = null;
	billingCreditLoading = false;
	billingCreditError = null;
	billingCreditUserId = authStore.userUuid;
	billingConfigured = false;
	billingSubscriptionName = null;
}

function formatUsdAmount(value: number | null | undefined) {
	const amount =
		typeof value === "number" && Number.isFinite(value) ? value : 0;
	const sign = amount < 0 ? "-" : "";
	return `${sign}$${Math.abs(amount).toFixed(8)}`;
}

async function refreshBillingCredit() {
	if (billingCreditRequest) return billingCreditRequest;
	billingCreditLoading = true;
	billingCreditError = null;
	billingCreditRequest = (async () => {
		try {
			billingCredit = await sdk.billing.getCredits();
			billingCreditUserId = authStore.userUuid;
			billingConfigured = true;
			return true;
		} catch (error) {
			if (await handleUnauthorizedError(error)) {
				clearBillingCredit();
				return false;
			}
			console.warn("[sidebar] Failed to load billing credit", error);
			billingCreditError = m.sidebar_failed_refresh({}, { locale });
			return false;
		} finally {
			billingCreditLoading = false;
			billingCreditRequest = null;
		}
	})();
	return billingCreditRequest;
}

async function refreshBillingPlan() {
	if (billingPlanRequest) return billingPlanRequest;
	billingPlanRequest = (async () => {
		try {
			const catalog = await billingCatalogStore.load();
			const sub =
				catalog?.currentSubscriptions.find((s) => s.status === "active") ??
				catalog?.currentSubscriptions.find((s) => s.status === "trialing");
			billingSubscriptionName = sub?.productName ?? null;
		} catch (error) {
			if (await handleUnauthorizedError(error)) return;
			console.warn("[sidebar] Failed to load billing plan", error);
		} finally {
			billingPlanRequest = null;
		}
	})();
	return billingPlanRequest;
}

const baseSettingsTabs = $derived([
	{
		id: "general",
		label: m.nav_general({}, { locale }),
		icon: Settings,
		href: "/settings/general",
	},
	{
		id: "activity",
		label: m.nav_activity({}, { locale }),
		icon: Activity,
		href: "/settings/activity",
	},
	{
		id: "referrals",
		label: m.nav_referrals({}, { locale }),
		icon: Gift,
		href: "/settings/referrals",
	},
	{
		id: "billing",
		label: m.nav_billing({}, { locale }),
		icon: CreditCard,
		href: "/settings/billing",
	},
	{
		id: "rules",
		label: m.nav_user_rules({}, { locale }),
		icon: NotebookPen,
		href: "/settings/rules",
	},
	{
		id: "channels",
		label: m.nav_channels({}, { locale }),
		icon: Network,
		href: "/settings/channels",
	},
]);
const settingsTabs = $derived(
	baseSettingsTabs.filter(
		(tab) => tab.id !== "billing" || billingConfigured !== false,
	),
);

function fallbackSettingsReturnTo() {
	// Prefer last visited space over `/` — public home remounts and reloads.
	const userUuid = authStore.userUuid;
	if (userUuid) {
		const recent = getRecentSpace(userUuid);
		if (recent?.spaceId) {
			return recent.sessionId
				? buildSpaceSessionRoute(recent.spaceId, recent.sessionId)
				: buildSpaceLandingRoute(recent.spaceId);
		}
	}
	return "/";
}

const settingsReturnTo = $derived.by(() => {
	const returnTo = page.url.searchParams.get("from");
	if (!returnTo) return fallbackSettingsReturnTo();
	try {
		const decoded = decodeURIComponent(returnTo);
		if (!decoded.startsWith("/") || decoded.startsWith("//"))
			return fallbackSettingsReturnTo();
		if (decoded.startsWith("/settings")) return fallbackSettingsReturnTo();
		return decoded;
	} catch {
		return fallbackSettingsReturnTo();
	}
});

const activeSettingsTab = $derived.by(() => {
	const tab = settingsTabs.find((tab) => currentPath.startsWith(tab.href));
	return tab?.id ?? null;
});

function getTaskRunBadge(status: TaskRunRecord["status"]) {
	if (status === "completed") {
		return { color: "text-status-running", dot: "bg-status-running" };
	}
	if (status === "failed") {
		return { color: "text-status-error", dot: "bg-status-error" };
	}
	if (status === "running") {
		return { color: "text-info", dot: "bg-info" };
	}
	return { color: "text-text-placeholder", dot: "bg-text-placeholder" };
}

function formatTaskRunTime(run: TaskRunRecord) {
	return formatCompactAbsoluteTime(run.createdAt ?? run.scheduledAt) || "—";
}

function asTaskRecord(value: unknown): Record<string, unknown> | null {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

function readTaskString(
	record: Record<string, unknown> | null,
	keys: string[],
) {
	if (!record) return null;
	for (const key of keys) {
		const value = record[key];
		if (typeof value === "string" && value.trim()) return value.trim();
	}
	return null;
}

function compactTaskText(value: string, limit = 72) {
	const compact = value.replace(/\s+/g, " ").trim();
	if (compact.length <= limit) return compact;
	return `${compact.slice(0, Math.max(0, limit - 1)).trimEnd()}…`;
}

function formatTaskTypeLabel(taskType: string | null | undefined) {
	const normalized = taskType?.trim() || "task";
	return normalized
		.split(/[_\s-]+/)
		.filter(Boolean)
		.map((part) => part.charAt(0).toUpperCase() + part.slice(1))
		.join(" ");
}

function getTaskRunPayloadData(run: Pick<TaskRunRecord, "payload">) {
	const payload = asTaskRecord(run.payload);
	return asTaskRecord(payload?.data) ?? payload;
}

function getTaskRunTitle(run: TaskRunRecord) {
	const payload = asTaskRecord(run.payload);
	const data = getTaskRunPayloadData(run);
	const explicitTitle = readTaskString(data, ["title", "name", "description"]);
	if (explicitTitle) return compactTaskText(explicitTitle);
	if (run.taskType === "generation") {
		const prompt = extractGenerationPromptPreview(run.payload);
		return prompt
			? compactTaskText(prompt)
			: m.sidebar_generation({}, { locale });
	}
	if (run.taskType === "send_message") {
		const content = data?.content;
		if (Array.isArray(content)) {
			const text = content
				.filter((block): block is Record<string, unknown> =>
					Boolean(asTaskRecord(block)),
				)
				.map((block) => readTaskString(block, ["text", "content", "value"]))
				.filter(Boolean)
				.join(" ");
			if (text.trim()) return compactTaskText(text);
		}
		return m.sidebar_send_message({}, { locale });
	}
	if (run.taskType === "run_command") {
		const action = appActionName(run);
		if (action) return m.task_type_app_action({ action }, { locale });
		const command = readTaskString(data, ["command", "rawText"]);
		return command
			? compactTaskText(command)
			: m.sidebar_run_command({}, { locale });
	}
	if (run.taskType === "save_checkpoint") {
		return compactTaskText(
			readTaskString(data, ["description"]) ??
				m.sidebar_save_checkpoint({}, { locale }),
		);
	}
	return formatTaskTypeLabel(
		(payload?.type as string | undefined) ?? run.taskType,
	);
}

function getTaskRunMeta(run: TaskRunRecord) {
	return `${formatTaskTypeLabel(run.taskType)} · ${run.status} · ${formatTaskRunTime(run)}`;
}

function handleAppDragStart(event: DragEvent, app: AppRecord) {
	const href = currentSpaceId ? buildSpaceAppRoute(currentSpaceId, app.id) : "";
	setCohubResourceDragData(event.dataTransfer, {
		version: 1,
		resources: [
			{
				type: "app",
				ref: app.slug,
				appId: app.id,
				title: app.slug,
				href,
			},
		],
		origin: { kind: "sidebar-session-list" },
	});
}

function appPointerDragPayload(app: AppRecord) {
	return {
		origin: "apps-sidebar" as const,
		items: [
			{
				type: "app" as const,
				path: "",
				name: app.slug,
				appId: app.id,
				appRef: app.slug,
				appUrl: currentSpaceId
					? buildSpaceAppRoute(currentSpaceId, app.id)
					: "",
			},
		],
	};
}

function handleTaskDragStart(event: DragEvent, run: TaskRunRecord) {
	const uri = `cohub://tasks/${run.id}`;
	setCohubResourceDragData(
		event.dataTransfer,
		{
			version: 1,
			resources: [
				{
					type: "task",
					ref: run.id,
					taskRunId: run.id,
					snapshot: taskBoardSnapshot(run),
				},
			],
			origin: { kind: "task-list" },
			createdAt: Date.now(),
		},
		{ cohubPath: uri, plainText: uri, effectAllowed: "copy" },
	);
}

function getFallbackSessionCursor(sessionList: SessionRecord[]) {
	return sessionList.at(-1)?.lastMessageAt ?? null;
}

function mergeDefinedSpaceRecordFields(
	incoming: SpaceRecord,
	existing: SpaceRecord | null | undefined,
) {
	if (!existing) return incoming;
	const merged: SpaceRecord = { ...existing };
	for (const [key, value] of Object.entries(incoming) as Array<
		[keyof SpaceRecord, SpaceRecord[keyof SpaceRecord]]
	>) {
		if (value !== undefined) {
			merged[key] = value as never;
		}
	}
	return merged;
}

function mergeSpaceIntoSidebarList(space: SpaceRecord) {
	const existing = spaces.find((item) => item.id === space.id);
	const merged = mergeDefinedSpaceRecordFields(space, existing);
	spaces = [merged, ...spaces.filter((item) => item.id !== space.id)];
}

function mergeSpaceListWithCurrent(nextSpaces: SpaceRecord[]) {
	const current = currentSpaceId
		? spaces.find((space) => space.id === currentSpaceId)
		: null;
	const merged = nextSpaces.map((space) =>
		space.id === currentSpaceId
			? mergeDefinedSpaceRecordFields(space, current)
			: space,
	);
	if (!current || nextSpaces.some((space) => space.id === current.id))
		return merged;
	return [current, ...merged];
}

const currentSpaceRefreshes = new Map<string, Promise<void>>();

async function loadCurrentSpaceFromUrl(
	spaceId = currentSpaceId,
	options?: { refresh?: boolean },
) {
	if (!spaceId) return;
	await authStore.ensureLoaded();
	const alreadyLoaded = spaces.some((space) => space.id === spaceId);

	if (!alreadyLoaded) {
		const cached = await getCachedSpaceRecord(spaceId).catch(() => null);
		if (spaceId !== currentSpaceId) return;
		if (cached?.space) mergeSpaceIntoSidebarList(cached.space);
	}

	if (!options?.refresh && currentSpaceRefreshes.has(spaceId)) return;

	let refresh!: Promise<void>;
	refresh = (async () => {
		try {
			const space = await sdk.space(spaceId).get();
			if (spaceId !== currentSpaceId) return;
			mergeSpaceIntoSidebarList(space);
			cacheSpaceRecordSoon(space);
		} catch (error) {
			if (spaceId !== currentSpaceId) return;
			console.warn("[sidebar] Failed to load current space", {
				spaceId,
				error,
			});
		} finally {
			if (currentSpaceRefreshes.get(spaceId) === refresh) {
				currentSpaceRefreshes.delete(spaceId);
			}
		}
	})();

	currentSpaceRefreshes.set(spaceId, refresh);
}

function shouldShowLoadMoreSessions() {
	if (sessionsPageInfo.hasMore && sessionsPageInfo.nextCursor) return true;
	const fallbackCursor = getFallbackSessionCursor(sessions);
	return Boolean(
		sessions.length >= SESSION_PAGE_SIZE &&
			fallbackCursor &&
			fallbackCursor !== exhaustedFallbackSessionCursor,
	);
}

function mergeSessionSnapshotForDisplay(
	currentSessions: SessionRecord[],
	nextSessions: SessionRecord[],
) {
	if (currentSessions.length === 0) return nextSessions;
	return sortSessionsByRecentActivity(
		mergeSessionRecords([...currentSessions, ...nextSessions]),
	);
}

async function loadSpaces(force = false) {
	await authStore.ensureLoaded();
	const requestedSpaceId = currentSpaceId;

	// The current URL is the source of truth for the selected space. Load it
	// directly first so guest-access spaces still render even if the broader
	// space list does not include them (or becomes paginated later).
	await loadCurrentSpaceFromUrl(requestedSpaceId);

	if (!authStore.isAuthenticated) {
		return;
	}

	if (!force) {
		const cached = getCachedSpaceList();
		if (cached && cached.length > 0) {
			spaces = mergeSpaceListWithCurrent(cached);
		}
	}

	const cacheMeta = getCachedSpaceListMeta();
	const shouldFetch = force || !cacheMeta || cacheMeta.isStale;
	if (!shouldFetch) return;

	refreshingSpaces = spaces.length > 0;
	try {
		const listedSpaces = await fetchSpaceListWithCache(
			async () => await sdk.spaces.list(),
			{ force },
		);
		spaces = mergeSpaceListWithCurrent(listedSpaces);
	} catch (error) {
		if (await handleUnauthorizedError(error)) {
			return;
		}
		console.warn("[sidebar] Failed to load spaces", error);
	} finally {
		refreshingSpaces = false;
	}

	await loadCurrentSpaceFromUrl(requestedSpaceId);
}

function isSessionsNetworkEnabled(spaceId: string) {
	return Boolean(sessionsNetworkEnabledBySpace[spaceId]);
}

function enableSessionsNetwork(spaceId: string) {
	if (sessionsNetworkEnabledBySpace[spaceId]) return;
	sessionsNetworkEnabledBySpace = {
		...sessionsNetworkEnabledBySpace,
		[spaceId]: true,
	};
}

async function loadSessionsForSpace(
	spaceId: string,
	options?: { force?: boolean; network?: boolean },
) {
	// Cache keys are user-scoped; wait for auth on cold start.
	await authStore.ensureLoaded();
	if (spaceId !== currentSpaceId) return;
	const force = options?.force ?? false;
	const allowNetwork = options?.network ?? isSessionsNetworkEnabled(spaceId);
	if (!force && loadingSessions && loadingSessionsSpaceId === spaceId) return;

	if (!force) {
		const cached = await getCachedSessionListSnapshot(spaceId);
		if (spaceId !== currentSpaceId) return;
		if (cached && cached.sessions.length > 0) {
			sessions = cached.sessions;
			applySessionForks(cached.forks);
			sessionsPageInfo = cached.pageInfo;
		}
	}

	const cachedSnapshot = await getCachedSessionListSnapshot(spaceId);
	if (spaceId !== currentSpaceId) return;

	// All chats network load is deferred until All is expanded (or explicitly forced).
	// Label rows get sessions/forks from labels/items; this keeps first paint lean.
	const shouldFetch =
		allowNetwork && (force || !cachedSnapshot || cachedSnapshot.stale);
	if (!shouldFetch) {
		loadingSessions = false;
		loadingSessionsSpaceId = null;
		refreshingSessions = false;
		return;
	}

	const shouldShowLoading = sessions.length === 0;
	if (shouldShowLoading) {
		loadingSessions = true;
		loadingSessionsSpaceId = spaceId;
	} else {
		refreshingSessions = true;
	}

	try {
		const result = await sdk.space(spaceId).sessions.list({
			limit: SESSION_PAGE_SIZE,
			includeForks: true,
		});
		if (spaceId !== currentSpaceId) return;
		const nextSessions = result.sessions ?? [];
		const nextPageInfo = result.pageInfo ?? {
			hasMore: false,
			nextCursor: null,
		};
		const nextForks = result.forks ?? [];
		// Merge, never replace: label pages and session list both contribute forks.
		// Replacing caused fork indent/title to flicker when cache/list arrived after
		// labels/items (or when a partial cache write broadcast empty forks).
		applySessionForks(nextForks);
		sessions = nextSessions;
		void setCachedSessionList(
			spaceId,
			nextSessions,
			nextPageInfo,
			// Persist the merged in-memory set so later cache hydration is complete.
			sessionForks,
		).catch((error) =>
			console.warn("[sidebar] Failed to cache sessions", { spaceId, error }),
		);
		if (spaceId !== currentSpaceId) return;
		sessionsPageInfo = nextPageInfo;
	} catch (error) {
		console.warn("[sidebar] Failed to load sessions", { spaceId, error });
	} finally {
		if (loadingSessionsSpaceId === spaceId) {
			loadingSessions = false;
			loadingSessionsSpaceId = null;
		}
		refreshingSessions = false;
	}
}

async function loadMoreSessionsForSpace(spaceId: string) {
	if (loadingMoreSessions) return;
	const cursor =
		sessionsPageInfo.nextCursor ?? getFallbackSessionCursor(sessions);
	if (!cursor || cursor === exhaustedFallbackSessionCursor) return;
	loadingMoreSessions = true;
	try {
		const result = await sdk.space(spaceId).sessions.list({
			limit: SESSION_PAGE_SIZE,
			cursor,
			includeForks: true,
		});
		// A space switch resets `sessions`/`sessionsPageInfo`; drop this page unless
		// the request still belongs to the space on screen.
		if (spaceId !== currentSpaceId) return;
		const moreSessions = result.sessions ?? [];
		const nextPageInfo = result.pageInfo ?? {
			hasMore: false,
			nextCursor: null,
		};
		const forkByChildId = new Map(
			sessionForks.map((fork) => [fork.childSessionId, fork]),
		);
		for (const fork of result.forks ?? [])
			forkByChildId.set(fork.childSessionId, fork);
		sessionForks = Array.from(forkByChildId.values());
		const mergedSessions = [...sessions, ...moreSessions];
		sessions = mergedSessions;
		void setCachedSessionList(
			spaceId,
			moreSessions,
			nextPageInfo,
			sessionForks,
			{ mode: "merge" },
		).catch((error) =>
			console.warn("[sidebar] Failed to cache loaded sessions", {
				spaceId,
				error,
			}),
		);
		sessionsPageInfo = nextPageInfo;
		exhaustedFallbackSessionCursor =
			!nextPageInfo.hasMore && moreSessions.length === 0 ? cursor : null;
	} catch (error) {
		console.warn("[sidebar] Failed to load more sessions", { spaceId, error });
	} finally {
		loadingMoreSessions = false;
	}
}

async function loadCheckpointsForSpace(spaceId: string, force = false) {
	await authStore.ensureLoaded();
	if (spaceId !== currentSpaceId) return;
	if (!force && loadingCheckpoints && loadingCheckpointsSpaceId === spaceId)
		return;
	const shouldShowLoading = checkpoints.length === 0;
	if (shouldShowLoading) {
		loadingCheckpoints = true;
		loadingCheckpointsSpaceId = spaceId;
	} else {
		refreshingCheckpoints = true;
	}
	try {
		const result = await sdk.space(spaceId).checkpoints.list({
			limit: CHECKPOINT_PAGE_SIZE,
		});
		if (spaceId === currentSpaceId) {
			checkpoints = result.checkpoints ?? [];
			checkpointsPageInfo = result.pageInfo ?? {
				hasMore: false,
				nextCursor: null,
			};
		}
	} catch (error) {
		console.warn("[sidebar] Failed to load checkpoints", { spaceId, error });
	} finally {
		if (loadingCheckpointsSpaceId === spaceId) {
			loadingCheckpoints = false;
			loadingCheckpointsSpaceId = null;
		}
		refreshingCheckpoints = false;
	}
}

function getReactiveLabelDisplayName(label: LabelListItem) {
	userLabelProfileVersion;
	channelLabelDisplayVersion;
	return getLabelDisplayName(label, {
		// Icon already conveys provider — keep the row text as the channel name.
		channelIncludeProvider: false,
	});
}

function getReactiveLabelDisplayTitle(label: LabelListItem) {
	userLabelProfileVersion;
	channelLabelDisplayVersion;
	return getLabelDisplayTitle(label);
}

function getReactiveLabelUserProfile(label: LabelListItem) {
	userLabelProfileVersion;
	return getLabelUserProfile(label);
}

function getReactiveLabelChannelInfo(label: LabelListItem) {
	channelLabelDisplayVersion;
	return getLabelChannelInfo(label);
}

function hydrateSystemLabelDisplays(nextLabels: LabelListItem[]) {
	void hydrateUserProfilesForLabels(nextLabels).catch(() => undefined);
	if (!currentSpaceId) return;
	void hydrateChannelLabelsForLabels(currentSpaceId, nextLabels).catch(
		() => undefined,
	);
}

async function loadMoreCheckpointsForSpace(spaceId: string) {
	if (loadingMoreCheckpoints) return;
	const cursor = checkpointsPageInfo.nextCursor;
	if (!cursor) return;
	loadingMoreCheckpoints = true;
	try {
		const result = await sdk.space(spaceId).checkpoints.list({
			limit: CHECKPOINT_PAGE_SIZE,
			cursor,
		});
		if (spaceId !== currentSpaceId) return;
		const byId = new Map(
			checkpoints.map((checkpoint) => [checkpoint.id, checkpoint]),
		);
		for (const checkpoint of result.checkpoints ?? []) {
			byId.set(checkpoint.id, checkpoint);
		}
		checkpoints = Array.from(byId.values()).sort(
			(a, b) =>
				(Date.parse(b.createdAt ?? "") || 0) -
				(Date.parse(a.createdAt ?? "") || 0),
		);
		checkpointsPageInfo = result.pageInfo ?? {
			hasMore: false,
			nextCursor: null,
		};
	} catch (error) {
		console.warn("[sidebar] Failed to load more checkpoints", {
			spaceId,
			error,
		});
	} finally {
		loadingMoreCheckpoints = false;
	}
}

async function loadLabelsForSpace(spaceId: string, force = false) {
	const loadToken = ++labelsLoadToken;
	const isCurrentLoad = () =>
		spaceId === currentSpaceId && loadToken === labelsLoadToken;

	const applyLabels = (nextLabels: LabelListItem[]) => {
		labels = nextLabels;
		pruneExpandedLabelIds(spaceId, nextLabels);
		applyDefaultExpandedLabelId(spaceId, nextLabels);
		hydrateSystemLabelDisplays(nextLabels);
	};

	// Wait for auth before cache-key + network work. On cold start userUuid may
	// still be null (cache key "guest") and the access token may not be ready.
	// All chats defers its network fetch until expand, so it usually works;
	// labels fetch immediately and previously failed silently as empty.
	if (labels.length === 0) loadingLabels = true;
	else refreshingLabels = true;

	try {
		await authStore.ensureLoaded();
		if (!isCurrentLoad()) return;

		if (!force) {
			const cached = await getCachedSpaceLabelsSnapshot(spaceId);
			if (!isCurrentLoad()) return;
			if (cached) {
				applyLabels(cached.labels);
				// Cache drives first paint; always revalidate for cross-client changes.
				refreshingLabels = true;
				loadingLabels = false;
			}
		}

		const next = await fetchSpaceLabelsFresh(spaceId);
		if (!isCurrentLoad()) return;
		applyLabels(next);
		// Expanded rows may have tried to load items before the tree was ready
		// (cold start race). Refresh once labels are available.
		refreshExpandedLabelItems(spaceId);
	} catch (error) {
		console.warn("[sidebar] Failed to load labels", { spaceId, error });
	} finally {
		if (isCurrentLoad()) {
			loadingLabels = false;
			refreshingLabels = false;
		}
	}
}

function labelItemsEqual(
	left: LabelAssignmentListItem[],
	right: LabelAssignmentListItem[],
) {
	if (left.length !== right.length) return false;
	for (let index = 0; index < left.length; index += 1) {
		const a = left[index];
		const b = right[index];
		if (!a || !b) return false;
		if (a.id !== b.id || a.updatedAt !== b.updatedAt || a.rank !== b.rank)
			return false;
	}
	return true;
}

function sessionHasParticipantPayload(session: SessionRecord) {
	// Distinguish "hydrated but empty" from "never hydrated". List/detail
	// hydrate always materializes these fields (even as empty arrays / null).
	return (
		"userProfile" in session ||
		"participantProfiles" in session ||
		"participantUserUuids" in session
	);
}

function sessionNeedsParticipantHydration(
	session: SessionRecord | null | undefined,
) {
	if (!session) return true;
	if (!sessionHasParticipantPayload(session)) return true;
	if (session.userUuid && !session.userProfile) return true;
	const participantIds = session.participantUserUuids ?? [];
	if (participantIds.length > 0 && !session.participantProfiles?.length)
		return true;
	return false;
}

function sessionIsRicher(a: SessionRecord, b: SessionRecord) {
	const aHydrated = !sessionNeedsParticipantHydration(a);
	const bHydrated = !sessionNeedsParticipantHydration(b);
	if (aHydrated !== bHydrated) return aHydrated;
	return false;
}

async function warmLabelSessionDetails(spaceId: string, sessionIds: string[]) {
	// Primary path is labels/items `sessions[]`. This only backfills rare gaps
	// (legacy cache / older servers) without re-fetching already hydrated rows.
	const uniqueIds = Array.from(new Set(sessionIds.filter(Boolean)));
	if (uniqueIds.length === 0) return;

	const inMemoryDetails = labelSessionDetailsBySpace[spaceId] ?? {};
	const localHydrated = uniqueIds
		.map(
			(sessionId) => sessionsById.get(sessionId) ?? inMemoryDetails[sessionId],
		)
		.filter(
			(session): session is SessionRecord =>
				Boolean(session) && !sessionNeedsParticipantHydration(session),
		);
	if (localHydrated.length > 0) {
		void setCachedSessionDetails(spaceId, localHydrated).catch(() => undefined);
	}

	const loading =
		labelSessionDetailsLoadingBySpace[spaceId] ?? new Set<string>();
	const missing = uniqueIds.filter((sessionId) => {
		if (loading.has(sessionId)) return false;
		const local =
			sessionsById.get(sessionId) ?? inMemoryDetails[sessionId] ?? null;
		return sessionNeedsParticipantHydration(local);
	});
	if (missing.length === 0) return;

	const cached = (await getCachedSessionDetails(spaceId, missing).catch(
		() => ({}),
	)) as Awaited<ReturnType<typeof getCachedSessionDetails>>;
	const isCurrentSpace = () => spaceId === currentSpaceId;

	const fromCache: SessionRecord[] = [];
	const needNetwork: string[] = [];
	for (const sessionId of missing) {
		const snapshot = cached[sessionId];
		if (snapshot && !sessionNeedsParticipantHydration(snapshot.session)) {
			fromCache.push(snapshot.session);
			continue;
		}
		needNetwork.push(sessionId);
	}

	if (fromCache.length > 0 && isCurrentSpace()) {
		const currentDetails = labelSessionDetailsBySpace[spaceId] ?? {};
		const nextDetails = { ...currentDetails };
		for (const session of fromCache) {
			nextDetails[session.id] = currentDetails[session.id]
				? mergeSessionRecord(currentDetails[session.id], session)
				: session;
		}
		labelSessionDetailsBySpace = {
			...labelSessionDetailsBySpace,
			[spaceId]: nextDetails,
		};
	}

	if (needNetwork.length === 0) return;

	labelSessionDetailsLoadingBySpace = {
		...labelSessionDetailsLoadingBySpace,
		[spaceId]: new Set([...loading, ...needNetwork]),
	};

	try {
		const refreshed: SessionRecord[] = [];
		const concurrency = 4;
		let cursor = 0;
		async function worker() {
			while (cursor < needNetwork.length) {
				const sessionId = needNetwork[cursor++];
				if (!sessionId) continue;
				try {
					const session = await fetchSessionDetailWithCache(
						spaceId,
						sessionId,
						async () =>
							(await sdk.space(spaceId).session(sessionId).get()).session,
						{
							force: sessionNeedsParticipantHydration(
								cached[sessionId]?.session,
							),
						},
					);
					if (!sessionNeedsParticipantHydration(session))
						refreshed.push(session);
				} catch (error) {
					console.warn("[labels] Failed to warm session detail", {
						spaceId,
						sessionId,
						error,
					});
				}
			}
		}
		await Promise.all(
			Array.from({ length: Math.min(concurrency, needNetwork.length) }, () =>
				worker(),
			),
		);
		if (isCurrentSpace() && refreshed.length > 0) {
			const currentDetails = labelSessionDetailsBySpace[spaceId] ?? {};
			labelSessionDetailsBySpace = {
				...labelSessionDetailsBySpace,
				[spaceId]: {
					...currentDetails,
					...Object.fromEntries(
						refreshed.map((session) => [session.id, session]),
					),
				},
			};
		}
	} finally {
		const latestLoading =
			labelSessionDetailsLoadingBySpace[spaceId] ?? new Set<string>();
		labelSessionDetailsLoadingBySpace = {
			...labelSessionDetailsLoadingBySpace,
			[spaceId]: new Set(
				[...latestLoading].filter((id) => !needNetwork.includes(id)),
			),
		};
	}
}

function patchLabelItems(
	spaceId: string,
	labelId: string,
	items: LabelAssignmentListItem[],
	pageInfo: { hasMore: boolean; nextCursor: string | null },
) {
	const sessionItems = items.filter((item) => item.resourceType === "session");
	if (sessionItems.length > 0)
		void warmLabelSessionDetails(
			spaceId,
			sessionItems.map((item) => item.resourceRef),
		);
	const currentSpaceItems = labelItemsBySpace[spaceId] ?? {};
	const currentItems = currentSpaceItems[labelId] ?? [];
	const currentPageInfo = labelItemsPageInfoBySpace[spaceId]?.[labelId];
	const samePageInfo =
		currentPageInfo?.hasMore === pageInfo.hasMore &&
		currentPageInfo?.nextCursor === pageInfo.nextCursor;
	if (labelItemsEqual(currentItems, items) && samePageInfo) return;

	labelItemsBySpace = {
		...labelItemsBySpace,
		[spaceId]: {
			...currentSpaceItems,
			[labelId]: items,
		},
	};
	labelItemsPageInfoBySpace = {
		...labelItemsPageInfoBySpace,
		[spaceId]: {
			...(labelItemsPageInfoBySpace[spaceId] ?? {}),
			[labelId]: pageInfo,
		},
	};
}

function sessionForkSignature(fork: SessionForkSidebarRecord) {
	return [
		fork.childSessionId,
		fork.parentSessionId ?? "",
		fork.depth ?? 0,
		fork.anchorSequence ?? "",
		fork.parentTitle ?? "",
		fork.firstUserTextAfterFork ?? "",
	].join("|");
}

function mergeSessionForks(
	current: SessionForkSidebarRecord[],
	incoming: SessionForkSidebarRecord[] | null | undefined,
) {
	// Empty / missing incoming is "unknown", not "clear all". Partial cache and
	// label-page pages must never wipe forks already absorbed from another source.
	if (!incoming?.length) return current;
	const byChild = new Map(
		current.map((fork) => [fork.childSessionId, fork] as const),
	);
	let changed = false;
	for (const fork of incoming) {
		if (!fork.childSessionId) continue;
		const existing = byChild.get(fork.childSessionId);
		const merged = existing ? { ...existing, ...fork } : fork;
		if (
			!existing ||
			sessionForkSignature(existing) !== sessionForkSignature(merged)
		) {
			byChild.set(fork.childSessionId, merged);
			changed = true;
		}
	}
	return changed ? Array.from(byChild.values()) : current;
}

function applySessionForks(
	forks: SessionForkSidebarRecord[] | null | undefined,
) {
	const next = mergeSessionForks(sessionForks, forks);
	if (next === sessionForks) return;
	sessionForks = next;
}

function absorbLabelItemForks(
	forks: SessionForkSidebarRecord[] | null | undefined,
) {
	applySessionForks(forks);
}

function absorbLabelItemSessions(
	spaceId: string,
	sessions: SessionRecord[] | null | undefined,
) {
	if (!sessions?.length || spaceId !== currentSpaceId) return;
	const currentDetails = labelSessionDetailsBySpace[spaceId] ?? {};
	const nextDetails = { ...currentDetails };
	const accepted: SessionRecord[] = [];
	for (const session of sessions) {
		const existing = nextDetails[session.id];
		if (existing && sessionIsRicher(existing, session)) continue;
		const merged = existing ? mergeSessionRecord(existing, session) : session;
		nextDetails[session.id] = merged;
		accepted.push(merged);
	}
	if (accepted.length === 0) return;
	labelSessionDetailsBySpace = {
		...labelSessionDetailsBySpace,
		[spaceId]: nextDetails,
	};
	// Best-effort persistence only; in-memory rows already drive the list.
	void setCachedSessionDetails(spaceId, accepted).catch(() => undefined);
}

function labelItemsLoadKey(spaceId: string, labelId: string) {
	return `${spaceId}:${labelId}`;
}

function clearLabelItemsLoadingWatchdog(spaceId: string, labelId: string) {
	const key = labelItemsLoadKey(spaceId, labelId);
	const timer = labelItemsLoadingWatchdogs.get(key);
	if (!timer) return;
	clearTimeout(timer);
	labelItemsLoadingWatchdogs.delete(key);
}

function markLabelItemsLoading(spaceId: string, labelId: string) {
	const key = labelItemsLoadKey(spaceId, labelId);
	const token = (labelItemsLoadTokens.get(key) ?? 0) + 1;
	labelItemsLoadTokens.set(key, token);
	loadingLabelIdsBySpace = {
		...loadingLabelIdsBySpace,
		[spaceId]: new Set([
			...(loadingLabelIdsBySpace[spaceId] ?? new Set<string>()),
			labelId,
		]),
	};
	clearLabelItemsLoadingWatchdog(spaceId, labelId);
	labelItemsLoadingWatchdogs.set(
		key,
		setTimeout(() => {
			labelItemsLoadingWatchdogs.delete(key);
			if (labelItemsLoadTokens.get(key) !== token) return;
			if (spaceId !== currentSpaceId) return;
			console.warn(
				"[sidebar] Label items load timed out; clearing loading state",
				{
					spaceId,
					labelId,
				},
			);
			clearLabelItemsLoading(spaceId, labelId, token);
		}, LABEL_ITEMS_LOADING_WATCHDOG_MS),
	);
	return token;
}

function clearLabelItemsLoading(
	spaceId: string,
	labelId: string,
	token?: number,
) {
	const key = labelItemsLoadKey(spaceId, labelId);
	if (token !== undefined && labelItemsLoadTokens.get(key) !== token) return;
	clearLabelItemsLoadingWatchdog(spaceId, labelId);
	if (spaceId !== currentSpaceId) return;
	const current = loadingLabelIdsBySpace[spaceId];
	if (!current?.has(labelId)) return;
	loadingLabelIdsBySpace = {
		...loadingLabelIdsBySpace,
		[spaceId]: new Set([...current].filter((id) => id !== labelId)),
	};
}

function applyLabelItemsPage(
	spaceId: string,
	labelId: string,
	page: {
		items?: LabelAssignmentListItem[] | null;
		pageInfo: { hasMore: boolean; nextCursor: string | null };
		sessions?: SessionRecord[] | null;
		forks?: SessionForkSidebarRecord[] | null;
	},
	options?: { append?: boolean },
) {
	absorbLabelItemSessions(spaceId, page.sessions);
	absorbLabelItemForks(page.forks);
	const items = page.items ?? [];
	if (options?.append) {
		const latestItems = labelItemsBySpace[spaceId]?.[labelId] ?? [];
		patchLabelItems(
			spaceId,
			labelId,
			[...latestItems, ...items],
			page.pageInfo,
		);
		return;
	}
	patchLabelItems(spaceId, labelId, items, page.pageInfo);
}

async function loadLabelItems(
	labelId: string,
	options?: { force?: boolean; append?: boolean },
) {
	const spaceId = currentSpaceId;
	if (!spaceId) return;
	await authStore.ensureLoaded();
	if (spaceId !== currentSpaceId) return;
	const append = options?.append ?? false;
	const force = options?.force ?? false;
	const spacePageInfo = labelItemsPageInfoBySpace[spaceId] ?? {};
	const hasVisibleItems =
		(labelItemsBySpace[spaceId]?.[labelId]?.length ?? 0) > 0;
	// Empty rows show Loading…; already-populated rows refresh silently.
	const loadToken =
		append || !hasVisibleItems
			? markLabelItemsLoading(spaceId, labelId)
			: undefined;

	try {
		// Cache is optional acceleration. Never let a stuck IDB read block network.
		if (!append && !force) {
			const cached = await getCachedLabelItemsSnapshot(spaceId, labelId).catch(
				(error) => {
					console.warn("[sidebar] Failed to read cached label items", {
						spaceId,
						labelId,
						error,
					});
					return null;
				},
			);
			if (spaceId !== currentSpaceId) return;
			if (cached) {
				applyLabelItemsPage(spaceId, labelId, cached);
				if (!cached.stale) return;
			}
		}

		// Prefer in-memory tree (already on screen) over cache/network label lookup.
		const labelRef =
			labelRefForId(labelId) ?? (await getLabelRefById(spaceId, labelId));
		if (!labelRef) {
			console.warn("[sidebar] Missing label ref for items load", {
				spaceId,
				labelId,
			});
			return;
		}
		if (append) {
			const result = await sdk.space(spaceId).labels.listItems(labelRef, {
				limit: LABEL_ITEMS_PAGE_SIZE,
				cursor: spacePageInfo[labelId]?.nextCursor,
			});
			if (spaceId !== currentSpaceId) return;
			applyLabelItemsPage(spaceId, labelId, result, { append: true });
			return;
		}

		const result = await fetchLabelItemsFirstPageFresh(
			spaceId,
			labelId,
			labelRef,
		);
		if (spaceId !== currentSpaceId) return;
		applyLabelItemsPage(spaceId, labelId, result);
	} catch (error) {
		console.warn("[sidebar] Failed to load label items", {
			spaceId,
			labelId,
			error,
		});
	} finally {
		if (loadToken !== undefined) {
			clearLabelItemsLoading(spaceId, labelId, loadToken);
		}
	}
}

function toggleLabelExpanded(labelId: string) {
	if (!currentSpaceId) return;
	const spaceId = currentSpaceId;
	const next = new Set(expandedLabelIdsBySpace[spaceId] ?? new Set<string>());
	if (next.has(labelId)) next.delete(labelId);
	else {
		next.add(labelId);
		if (labelId === ALL_CHATS_LABEL_ID) {
			enableSessionsNetwork(spaceId);
			void loadSessionsForSpace(spaceId, { network: true });
		} else {
			void loadLabelItems(labelId);
		}
	}
	expandedLabelIdsBySpace = {
		...expandedLabelIdsBySpace,
		[spaceId]: next,
	};
	setCachedExpandedLabelIds(spaceId, next);
}

function isSessionActivityLabel(label: LabelListItem) {
	return (
		isSessionUserLabel(label) ||
		isSessionChannelLabel(label) ||
		label.systemKey?.startsWith(SESSION_SOURCE_LABEL_SYSTEM_KEY_PREFIX)
	);
}

function didSessionActivityChange(
	previous: SessionRecord | undefined,
	next: SessionRecord,
) {
	if (!previous) return true;
	return (
		previous.lastMessageAt !== next.lastMessageAt ||
		previous.updatedAt !== next.updatedAt ||
		previous.latestMessageText !== next.latestMessageText ||
		previous.status !== next.status ||
		previous.title !== next.title
	);
}

function refreshExpandedSessionActivityLabels(spaceId: string) {
	const expanded = expandedLabelIdsBySpace[spaceId];
	if (!expanded || spaceId !== currentSpaceId) return;
	for (const label of flattenLabels(labels)) {
		if (!expanded.has(label.id) || !isSessionActivityLabel(label)) continue;
		void loadLabelItems(label.id, { force: true });
	}
}

function optimisticPrependWebAppLabelSession(
	spaceId: string,
	session: SessionRecord,
) {
	if (!isWebSessionSource(session)) return;
	const labelId = findWebAppSourceLabel(labels)?.id ?? null;
	if (!labelId || !currentExpandedLabelIds.has(labelId)) return;
	const existingItems = labelItemsBySpace[spaceId]?.[labelId] ?? [];
	if (
		existingItems.some(
			(item) =>
				item.resourceType === "session" && item.resourceRef === session.id,
		)
	)
		return;
	patchLabelItems(
		spaceId,
		labelId,
		[
			buildOptimisticWebAppLabelSessionItem({ spaceId, labelId, session }),
			...existingItems,
		],
		currentLabelItemsPageInfoById[labelId] ?? {
			hasMore: false,
			nextCursor: null,
		},
	);
}

function restoreExpandedLabelIds(spaceId: string) {
	const expanded = getCachedExpandedLabelIdsSnapshot(spaceId);
	// Empty cache means "no remembered preference" — leave room for the default.
	if (!expanded?.size) return;
	expandedLabelIdsBySpace = {
		...expandedLabelIdsBySpace,
		[spaceId]: expanded,
	};
	if (expanded.has(ALL_CHATS_LABEL_ID)) enableSessionsNetwork(spaceId);
	for (const labelId of expanded) {
		if (labelId !== ALL_CHATS_LABEL_ID) void loadLabelItems(labelId);
	}
}

function applyDefaultExpandedLabelId(
	spaceId: string,
	nextLabels: LabelListItem[],
) {
	// Only honor a non-empty remembered preference. An empty cached set is a bad
	// state for first paint (collapsed-all / pruned-away labels) and should not
	// permanently block All from opening.
	const cached = getCachedExpandedLabelIdsSnapshot(spaceId);
	if (cached && cached.size > 0) return;
	if (expandedLabelIdsBySpace[spaceId]?.size) return;
	const labelId = findDefaultExpandedLabelId(nextLabels);
	const expanded = new Set([labelId]);
	expandedLabelIdsBySpace = {
		...expandedLabelIdsBySpace,
		[spaceId]: expanded,
	};
	setCachedExpandedLabelIds(spaceId, expanded);
	if (labelId === ALL_CHATS_LABEL_ID) {
		enableSessionsNetwork(spaceId);
		void loadSessionsForSpace(spaceId, { network: true });
	} else {
		void loadLabelItems(labelId);
	}
}

function pruneExpandedLabelIds(spaceId: string, nextLabels: LabelListItem[]) {
	const expanded = expandedLabelIdsBySpace[spaceId];
	if (!expanded?.size) return;
	const validIds = new Set([
		...flattenLabels(nextLabels).map((label) => label.id),
		ALL_CHATS_LABEL_ID,
	]);
	const next = new Set(
		[...expanded].filter((labelId) => validIds.has(labelId)),
	);
	if (next.size === expanded.size) return;
	expandedLabelIdsBySpace = {
		...expandedLabelIdsBySpace,
		[spaceId]: next,
	};
	setCachedExpandedLabelIds(spaceId, next);
	// If every remembered id is gone, re-apply the default so the chats section
	// does not stay fully collapsed after labels change.
	if (next.size === 0) applyDefaultExpandedLabelId(spaceId, nextLabels);
}

function refreshExpandedLabelItems(spaceId: string) {
	const expanded = expandedLabelIdsBySpace[spaceId];
	if (!expanded || spaceId !== currentSpaceId) return;
	for (const labelId of expanded) {
		if (labelId !== ALL_CHATS_LABEL_ID)
			void loadLabelItems(labelId, { force: true });
	}
}

function ensureLabelExpanded(labelId: string) {
	if (!currentSpaceId) return false;
	const spaceId = currentSpaceId;
	const next = new Set(expandedLabelIdsBySpace[spaceId] ?? new Set<string>());
	if (next.has(labelId)) return false;
	next.add(labelId);
	expandedLabelIdsBySpace = {
		...expandedLabelIdsBySpace,
		[spaceId]: next,
	};
	setCachedExpandedLabelIds(spaceId, next);
	return true;
}

function expandLabelAndLoadItems(labelId: string) {
	const wasExpanded = currentExpandedLabelIds.has(labelId);
	ensureLabelExpanded(labelId);
	if (wasExpanded) {
		// Already open — refresh silently so sessions stay current.
		void loadLabelItems(labelId, { force: true });
		return;
	}
	void loadLabelItems(labelId);
}

function findOwnSessionUserLabel() {
	return findSessionUserLabel(labels, authStore.userUuid);
}

function ensureChatsSectionVisible() {
	chatsCollapsed = false;
}

function ensureSidebarVisibleForLabelFocus() {
	if (collapsed) uiState.setLeftSidebarCollapsed(false);
}

function scrollSidebarLabelIntoView(labelId: string, attempt = 0) {
	const selector = `[data-sidebar-label-id="${CSS.escape(labelId)}"]`;
	const scoped =
		(sidebarRootEl?.querySelector(selector) as HTMLElement | null) ??
		(document.querySelector(selector) as HTMLElement | null);
	if (!scoped) {
		// Collapsed rail → full sidebar remounts the tree; retry a few frames.
		if (attempt < 8) {
			requestAnimationFrame(() =>
				scrollSidebarLabelIntoView(labelId, attempt + 1),
			);
		}
		return;
	}
	scoped.scrollIntoView({ block: "nearest", behavior: "smooth" });
	try {
		scoped.focus({ preventScroll: true });
	} catch {
		scoped.focus();
	}
}

function focusOwnSessionUserLabel() {
	if (mode !== "space" || !currentSpaceId) return false;
	const ownLabel = findOwnSessionUserLabel();
	if (!ownLabel) return false;
	const userRoot = findSessionUserRootLabel(labels);
	ensureSidebarVisibleForLabelFocus();
	ensureChatsSectionVisible();
	if (userRoot) ensureLabelExpanded(userRoot.id);
	expandLabelAndLoadItems(ownLabel.id);
	void tick().then(() => {
		requestAnimationFrame(() => {
			scrollSidebarLabelIntoView(ownLabel.id);
		});
	});
	return true;
}

function focusOwnSessionUserLabelOrFallback() {
	if (focusOwnSessionUserLabel()) return;
	ensureSidebarVisibleForLabelFocus();
	ensureChatsSectionVisible();
	void authStore.ensureLoaded().then(async () => {
		if (!currentSpaceId) return;
		if (labels.length === 0) {
			await loadLabelsForSpace(currentSpaceId, true);
		}
		if (focusOwnSessionUserLabel()) return;
		// No participant label yet — expand User root so the section is reachable.
		const userRoot = findSessionUserRootLabel(labels);
		if (!userRoot) return;
		ensureLabelExpanded(userRoot.id);
		void tick().then(() => {
			requestAnimationFrame(() => {
				scrollSidebarLabelIntoView(userRoot.id);
			});
		});
	});
}

function clearLabelAutoExpandTimer() {
	if (!labelAutoExpandTimer) return;
	clearTimeout(labelAutoExpandTimer);
	labelAutoExpandTimer = null;
}

function scheduleLabelAutoExpand(labelId: string) {
	clearLabelAutoExpandTimer();
	if (currentExpandedLabelIds.has(labelId)) return;
	labelAutoExpandTimer = setTimeout(() => {
		ensureLabelExpanded(labelId);
		void loadLabelItems(labelId);
		labelAutoExpandTimer = null;
	}, 600);
}

function setLabelDropFeedback(
	kind: "success" | "error",
	labelId: string,
	message?: string,
) {
	if (labelDropFeedbackTimer) clearTimeout(labelDropFeedbackTimer);
	labelDropSuccessId = kind === "success" ? labelId : null;
	labelDropErrorId = kind === "error" ? labelId : null;
	labelDropErrorMessage =
		kind === "error"
			? (message ?? m.sidebar_failed_update_label({}, { locale }))
			: null;
	labelDropFeedbackTimer = setTimeout(
		() => {
			labelDropSuccessId = null;
			labelDropErrorId = null;
			labelDropErrorMessage = null;
			labelDropFeedbackTimer = null;
		},
		kind === "error" ? 2400 : 900,
	);
}

function refreshAffectedLabelItems(result: ResourceLabelMutationResult) {
	if (!currentSpaceId) return;
	for (const labelId of result.affectedLabelIds) {
		if (currentExpandedLabelIds.has(labelId)) {
			void loadLabelItems(labelId, { force: true });
		}
	}
}

function getDropResource(event: DragEvent): {
	payload: CohubResourceDragPayload;
	resource: LabelAssignableCohubResource;
} | null {
	const payload = getCohubResourceDragData(event.dataTransfer);
	if (!payload) return null;
	const resource = getFirstCohubResource(payload);
	if (!isLabelAssignableResource(resource)) return null;
	return { payload, resource };
}

function canAssignResourceToLabel(label: LabelListItem) {
	return canAssignLabels && !isSystemLabel(label, labels);
}

function handleLabelDragOver(event: DragEvent, label: LabelListItem) {
	if (
		!canAssignResourceToLabel(label) ||
		!hasCohubResourceDragData(event.dataTransfer)
	)
		return;
	event.preventDefault();
	event.stopPropagation();
	labelDropTargetId = label.id;
	if (event.dataTransfer) {
		event.dataTransfer.dropEffect = activeLabelDragOrigin ? "move" : "copy";
	}
	scheduleLabelAutoExpand(label.id);
}

function labelRefForId(labelId: string) {
	return (
		flattenLabelsWithRefs(labels).find((label) => label.id === labelId)?.ref ??
		null
	);
}

function replaceLabelInTree(
	items: LabelListItem[],
	labelId: string,
	updater: (label: LabelListItem) => LabelListItem,
): LabelListItem[] {
	return items.map((item) => {
		const nextItem = item.id === labelId ? updater(item) : item;
		if (!nextItem.children?.length) return nextItem;
		return {
			...nextItem,
			children: replaceLabelInTree(nextItem.children, labelId, updater),
		};
	});
}

function handleLabelDragLeave(event: DragEvent, label: LabelListItem) {
	const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
	const { clientX: x, clientY: y } = event;
	if (x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom)
		return;
	if (labelDropTargetId === label.id) labelDropTargetId = null;
	clearLabelAutoExpandTimer();
}

async function handleLabelDrop(event: DragEvent, label: LabelListItem) {
	if (!canAssignResourceToLabel(label) || !currentSpaceId) return;
	const spaceId = currentSpaceId;
	const drop = getDropResource(event);
	if (!drop) return;
	event.preventDefault();
	event.stopPropagation();
	clearLabelAutoExpandTimer();
	labelDropTargetId = null;
	labelDropBusyId = label.id;
	try {
		const targetLabelRef = labelRefForId(label.id);
		if (!targetLabelRef) return;
		const result =
			drop.payload.origin?.kind === "label-items"
				? await moveResourceToLabel({
						spaceId,
						resource: drop.resource,
						sourceLabelRef: drop.payload.origin.labelRef,
						targetLabelRef,
					})
				: await addResourceToLabel({
						spaceId,
						resource: drop.resource,
						targetLabelRef,
					});
		if (currentSpaceId !== spaceId) return;
		ensureLabelExpanded(label.id);
		void loadLabelItems(label.id, { force: true });
		refreshAffectedLabelItems(result);
		setLabelDropFeedback("success", label.id);
	} catch (error) {
		console.warn("[labels] Failed to update resource labels", {
			labelId: label.id,
			resource: drop.resource,
			error,
		});
		if (currentSpaceId === spaceId) {
			setLabelDropFeedback(
				"error",
				label.id,
				m.sidebar_could_not_update_label({}, { locale }),
			);
		}
	} finally {
		if (currentSpaceId === spaceId) labelDropBusyId = null;
	}
}

function handleSessionDragStart(
	event: DragEvent,
	session: SessionRecord,
	title: string,
) {
	const path = `/sessions/${session.id}.jsonl`;
	setCohubResourceDragData(
		event.dataTransfer,
		{
			version: 1,
			resources: [
				{
					type: "session",
					ref: session.id,
					title,
					href: currentSpaceId
						? buildSpaceSessionRoute(currentSpaceId, session.id)
						: undefined,
					path,
				},
			],
			origin: { kind: "sidebar-session-list" },
			createdAt: Date.now(),
		},
		{ cohubPath: path, plainText: path, effectAllowed: "copyMove" },
	);
}

function isDraggableLabelItem(
	item: LabelAssignmentListItem,
): item is LabelAssignmentListItem & {
	resourceType: "session" | "checkpoint" | "file";
} {
	return (
		item.resourceType === "session" ||
		item.resourceType === "checkpoint" ||
		item.resourceType === "file"
	);
}

function handleLabelItemDragStart(
	event: DragEvent,
	label: LabelListItem,
	item: LabelAssignmentListItem,
) {
	if (!isDraggableLabelItem(item)) {
		event.preventDefault();
		return;
	}
	const sourceLabelRef = canAssignResourceToLabel(label)
		? (labelRefForId(label.id) ?? label.name)
		: null;
	const resource: LabelAssignableCohubResource = {
		type: item.resourceType,
		ref: item.resourceRef,
		title: item.resource?.title ?? item.resourceRef,
		subtitle: item.resource?.subtitle,
		href: item.href,
		path: item.resourceType === "file" ? item.resourceRef : undefined,
	};
	setCohubResourceDragData(
		event.dataTransfer,
		{
			version: 1,
			resources: [resource],
			origin: sourceLabelRef
				? {
						kind: "label-items",
						labelRef: sourceLabelRef,
						labelName: getReactiveLabelDisplayName(label),
					}
				: undefined,
			createdAt: Date.now(),
		},
		{
			cohubPath:
				item.resourceType === "file"
					? item.resourceRef
					: item.resourceType === "session"
						? `/sessions/${item.resourceRef}.jsonl`
						: undefined,
			plainText: item.resourceRef,
			effectAllowed: "copyMove",
		},
	);
	activeLabelDragOrigin = sourceLabelRef
		? {
				labelId: label.id,
				labelRef: sourceLabelRef,
				labelName: getReactiveLabelDisplayName(label),
			}
		: null;
}

function handleResourceDragEnd() {
	activeLabelDragOrigin = null;
	labelDropTargetId = null;
	clearLabelAutoExpandTimer();
}

async function removeLabelAssignment(
	label: LabelListItem,
	item: LabelAssignmentListItem,
) {
	if (!canAssignResourceToLabel(label) || !currentSpaceId) return;
	if (!isDraggableLabelItem(item)) return;
	const spaceId = currentSpaceId;
	const sourceLabelRef = labelRefForId(label.id);
	if (!sourceLabelRef) return;
	labelDropBusyId = label.id;
	try {
		const result = await removeResourceFromLabel({
			spaceId,
			resource: {
				type: item.resourceType,
				ref: item.resourceRef,
				title: item.resource?.title ?? item.resourceRef,
				subtitle: item.resource?.subtitle,
				href: item.href,
				path: item.resourceType === "file" ? item.resourceRef : undefined,
			},
			sourceLabelRef,
		});
		if (currentSpaceId !== spaceId) return;
		refreshAffectedLabelItems(result);
		setLabelDropFeedback("success", label.id);
	} catch (error) {
		console.warn("[labels] Failed to remove resource label", {
			labelId: label.id,
			resourceType: item.resourceType,
			resourceRef: item.resourceRef,
			error,
		});
		if (currentSpaceId === spaceId) {
			setLabelDropFeedback(
				"error",
				label.id,
				m.sidebar_could_not_remove_label({}, { locale }),
			);
		}
	} finally {
		if (currentSpaceId === spaceId) labelDropBusyId = null;
	}
}

function labelAssignmentHref(item: LabelAssignmentListItem) {
	return item.href;
}

function decodeRoutePath(path: string) {
	try {
		return path
			.split("/")
			.map((segment) => decodeURIComponent(segment))
			.join("/");
	} catch {
		return path;
	}
}

function normalizeFileRef(path: string) {
	return decodeRoutePath(path).replace(/^\/+/, "");
}

function isLabelAssignmentActive(item: LabelAssignmentListItem) {
	if (!activeLabelResource || item.resourceType !== activeLabelResource.type) {
		return false;
	}
	if (item.resourceType === "file") {
		return (
			normalizeFileRef(item.resourceRef) ===
			normalizeFileRef(activeLabelResource.ref)
		);
	}
	return item.resourceRef === activeLabelResource.ref;
}

async function loadCronjobsForSpace(spaceId: string, force = false) {
	await authStore.ensureLoaded();
	if (spaceId !== currentSpaceId) return;
	if (!force && loadingCronjobs && loadingCronjobsSpaceId === spaceId) return;
	const shouldShowLoading = cronjobs.length === 0;
	if (shouldShowLoading) {
		loadingCronjobs = true;
		loadingCronjobsSpaceId = spaceId;
	} else {
		refreshingCronjobs = true;
	}
	try {
		const result = await sdk.cronJobs.list(spaceId);
		if (spaceId === currentSpaceId) cronjobs = result.jobs ?? [];
	} catch (error) {
		console.warn("[sidebar] Failed to load cronjobs", { spaceId, error });
	} finally {
		if (loadingCronjobsSpaceId === spaceId) {
			loadingCronjobs = false;
			loadingCronjobsSpaceId = null;
		}
		refreshingCronjobs = false;
	}
}

async function restoreTasksForSpace(spaceId: string) {
	const cachedRuns = getCachedTaskRuns(spaceId);
	if (cachedRuns.length > 0 && spaceId === currentSpaceId) {
		tasks = cachedRuns.slice(0, TASK_PAGE_SIZE);
	}
	try {
		const restoredRuns = await restoreCachedTaskRuns(spaceId);
		if (spaceId === currentSpaceId)
			tasks = restoredRuns.slice(0, TASK_PAGE_SIZE);
	} catch (error) {
		console.warn("[sidebar] Failed to restore cached tasks", {
			spaceId,
			error,
		});
	}
}

async function loadTasksForSpace(spaceId: string, force = false) {
	await authStore.ensureLoaded();
	if (spaceId !== currentSpaceId) return;
	if (!force && loadingTasks && loadingTasksSpaceId === spaceId) return;
	const shouldShowLoading = tasks.length === 0;
	if (shouldShowLoading) {
		loadingTasks = true;
		loadingTasksSpaceId = spaceId;
	} else {
		refreshingTasks = true;
	}
	try {
		const result = await sdk.tasks.list({ spaceId, limit: TASK_PAGE_SIZE });
		if (spaceId === currentSpaceId) {
			tasks = result.runs ?? [];
			tasksPageInfo = result.pageInfo ?? { hasMore: false, nextCursor: null };
			setCachedTaskRuns(spaceId, tasks);
		}
	} catch (error) {
		console.warn("[sidebar] Failed to load tasks", { spaceId, error });
	} finally {
		if (loadingTasksSpaceId === spaceId) {
			loadingTasks = false;
			loadingTasksSpaceId = null;
		}
		refreshingTasks = false;
	}
}

async function loadMoreTasksForSpace(spaceId: string) {
	if (loadingMoreTasks) return;
	const cursor = tasksPageInfo.nextCursor;
	if (!cursor) return;
	loadingMoreTasks = true;
	try {
		const result = await sdk.tasks.list({
			spaceId,
			limit: TASK_PAGE_SIZE,
			cursor,
		});
		if (spaceId !== currentSpaceId) return;
		const moreRuns = result.runs ?? [];
		const runById = new Map(tasks.map((run) => [run.id, run]));
		for (const run of moreRuns) runById.set(run.id, run);
		tasks = Array.from(runById.values()).sort(
			(a, b) =>
				(Date.parse(b.createdAt ?? b.updatedAt ?? "") || 0) -
				(Date.parse(a.createdAt ?? a.updatedAt ?? "") || 0),
		);
		tasksPageInfo = result.pageInfo ?? { hasMore: false, nextCursor: null };
		setCachedTaskRuns(spaceId, tasks);
	} catch (error) {
		console.warn("[sidebar] Failed to load more tasks", { spaceId, error });
	} finally {
		loadingMoreTasks = false;
	}
}

/** Fold buffered realtime mutations onto a freshly fetched list. */
async function loadAppsForSpace(spaceId: string, force = false) {
	await authStore.ensureLoaded();
	if (spaceId !== currentSpaceId) return;
	if (!force && loadingApps && loadingAppsSpaceId === spaceId) return;
	const shouldShowLoading = apps.length === 0;
	if (shouldShowLoading) {
		loadingApps = true;
		loadingAppsSpaceId = spaceId;
	} else {
		refreshingApps = true;
	}
	appsBuffer.reset();
	try {
		const result = await sdk.apps.listBySpace(spaceId);
		if (spaceId === currentSpaceId) {
			apps = appsBuffer.apply(result.apps ?? []);
		}
	} catch (error) {
		console.warn("[sidebar] Failed to load apps", { spaceId, error });
	} finally {
		if (loadingAppsSpaceId === spaceId) {
			loadingApps = false;
			loadingAppsSpaceId = null;
		}
		refreshingApps = false;
	}
}

function currentAppLocation() {
	return `${page.url.pathname}${page.url.search}${page.url.hash}`;
}

function withSettingsReturn(href: string) {
	const target = new URL(href, page.url);
	if (target.pathname.startsWith("/settings")) {
		const current = currentAppLocation();
		if (!current.startsWith("/settings")) {
			target.searchParams.set("from", current);
		} else {
			const from = page.url.searchParams.get("from");
			if (from && !target.searchParams.has("from")) {
				target.searchParams.set("from", from);
			}
		}
	}
	return target.pathname + target.search + target.hash;
}

async function handleNavigate(
	href: string,
	options?: { keepSettingsReturn?: boolean; replaceState?: boolean },
) {
	onClose?.();
	const targetHref =
		options?.keepSettingsReturn && mode === "settings"
			? withSettingsReturn(href)
			: href;
	await goto(targetHref, {
		replaceState: options?.replaceState,
	});
}

function openSettings() {
	showUserMenu = false;
	// Entering settings always pushes once; subsequent tab moves replace.
	void handleNavigate(withSettingsReturn("/settings/general"));
}

function openBillingSettings() {
	showUserMenu = false;
	void handleNavigate(withSettingsReturn("/settings/billing"), {
		replaceState: mode === "settings",
	});
}

function openReferralsSettings() {
	showUserMenu = false;
	void handleNavigate(withSettingsReturn("/settings/referrals"), {
		replaceState: mode === "settings",
	});
}

function returnFromSettings() {
	onClose?.();
	// When we opened settings in-app, `from` is set and tab switches use
	// replaceState — so one history.back() restores the previous page.
	// Avoid bare history.back() without `from` (bookmark / hard entry).
	const hasReturn = Boolean(page.url.searchParams.get("from"));
	if (hasReturn && typeof window !== "undefined" && window.history.length > 1) {
		window.history.back();
		return;
	}
	void goto(settingsReturnTo);
}

function openHelpPanel() {
	showUserMenu = false;
	onClose?.();
	window.dispatchEvent(new CustomEvent("cohub:open-help-panel"));
}

function openCommandPalette() {
	onClose?.();
	window.dispatchEvent(new CustomEvent("cohub:open-command-palette"));
}

function openSpacePalette() {
	onClose?.();
	window.dispatchEvent(
		new CustomEvent("cohub:open-command-palette", {
			detail: {
				title: m.sidebar_switch_space_title({}, { locale }),
				query: "a: ",
				placeholder: m.sidebar_search_spaces({}, { locale }),
				refreshSpaces: true,
			},
		}),
	);
}

function mainRouteWithWindow(pathname: string) {
	return withSidebarMainWindow(pathname, { isMobile });
}

function buildPreferredSessionRoute(spaceId: string, sessionId: string) {
	return mainRouteWithWindow(buildSpaceSessionRoute(spaceId, sessionId));
}

async function handleNavigateToSession(sessionId: string) {
	if (sessionNavigateClickTimer) {
		clearTimeout(sessionNavigateClickTimer);
		sessionNavigateClickTimer = null;
	}
	onClose?.();
	if (!currentSpaceId) return;
	await goto(buildPreferredSessionRoute(currentSpaceId, sessionId));
}

async function handleNavigateToCheckpoint(checkpointId: string) {
	onClose?.();
	if (!currentSpaceId) return;
	await goto(
		mainRouteWithWindow(
			buildSpaceCheckpointRoute(currentSpaceId, checkpointId),
		),
	);
}

async function handleNavigateToNewCheckpoint() {
	onClose?.();
	if (!currentSpaceId) return;
	await goto(mainRouteWithWindow(buildSpaceCheckpointNewRoute(currentSpaceId)));
}

async function handleNavigateToCronjob(cronjobId: string) {
	onClose?.();
	if (!currentSpaceId) return;
	await goto(
		mainRouteWithWindow(buildSpaceCronjobRoute(currentSpaceId, cronjobId)),
	);
}

async function handleNavigateToNewCronjob() {
	onClose?.();
	if (!currentSpaceId) return;
	await goto(mainRouteWithWindow(buildSpaceCronjobNewRoute(currentSpaceId)));
}

async function handleNavigateToTask(taskId: string) {
	onClose?.();
	if (!currentSpaceId) return;
	await goto(mainRouteWithWindow(buildSpaceTaskRoute(currentSpaceId, taskId)));
}

function getCurrentSpaceOwnerUsername() {
	return (
		currentSpace?.ownerProfile?.username ??
		(currentSpace?.userUuid === authStore.userUuid
			? authStore.profile?.username
			: null)
	);
}

async function handleNavigateToApp(appId: string) {
	onClose?.();
	if (!currentSpaceId) return;
	await goto(mainRouteWithWindow(buildSpaceAppRoute(currentSpaceId, appId)));
}

function handleWorksChanged(event: Event) {
	const detail = (event as CustomEvent<AppsChangedDetail>).detail;
	if (!currentSpaceId || detail?.spaceId !== currentSpaceId) return;
	if (detail.app) {
		appsBuffer.upsert(detail.app);
		apps = upsertAppSnapshot(apps, detail.app);
		return;
	}
	if (detail.deletedAppId) {
		appsBuffer.remove(detail.deletedAppId);
		apps = apps.filter((app) => app.id !== detail.deletedAppId);
		return;
	}
	void loadAppsForSpace(currentSpaceId, true);
}

async function handleCreateNewSession() {
	if (!currentSpaceId || creatingSession) return;
	createSessionError = "";
	try {
		await goto(mainRouteWithWindow(buildSpaceNewSessionRoute(currentSpaceId)), {
			keepFocus: true,
			noScroll: true,
		});
		onClose?.();
		requestAnimationFrame(() => {
			window.dispatchEvent(new CustomEvent("cohub:composer-focus"));
		});
	} catch (error) {
		createSessionError =
			error instanceof Error
				? error.message
				: m.sidebar_failed_open_chat({}, { locale });
	}
}

function insertPathReference(path: string) {
	insertComposerSnippet(` \`${path}\` `);
	onClose?.();
}

// ── Session rename ──────────────────────────────────────────────────────

function startRenameSession(session: SessionRecord) {
	renamingSessionId = session.id;
	renameTitleValue = session.title ?? getSessionTitle(session, 0);
	void tick().then(() => {
		renameInputElement?.focus();
		renameInputElement?.select();
	});
}

function scheduleSessionRowNavigate(sessionId: string) {
	if (sessionNavigateClickTimer) clearTimeout(sessionNavigateClickTimer);
	sessionNavigateClickTimer = setTimeout(() => {
		sessionNavigateClickTimer = null;
		void handleNavigateToSession(sessionId);
	}, SESSION_ROW_NAVIGATE_DELAY_MS);
}

function handleSessionRowDoubleClick(
	event: MouseEvent,
	session: SessionRecord,
) {
	event.preventDefault();
	event.stopPropagation();
	if (sessionNavigateClickTimer) {
		clearTimeout(sessionNavigateClickTimer);
		sessionNavigateClickTimer = null;
	}
	startRenameSession(session);
}

function cancelRenameSession() {
	renamingSessionId = null;
	renameTitleValue = "";
}

async function submitRenameSession(session: SessionRecord) {
	if (renameSaving || !currentSpaceId) return;
	const trimmed = renameTitleValue.trim();
	if (!trimmed) {
		cancelRenameSession();
		return;
	}
	if (trimmed === (session.title ?? getSessionTitle(session, 0))) {
		cancelRenameSession();
		return;
	}
	renameSaving = true;
	try {
		await sdk.space(currentSpaceId).session(session.id).rename(trimmed);
		const renamedSession = { ...session, title: trimmed };
		sessions = sessions.map((s) =>
			s.id === session.id ? { ...s, title: trimmed } : s,
		);
		if (labelSessionDetailsBySpace[currentSpaceId]?.[session.id]) {
			labelSessionDetailsBySpace = {
				...labelSessionDetailsBySpace,
				[currentSpaceId]: {
					...labelSessionDetailsBySpace[currentSpaceId],
					[session.id]: renamedSession,
				},
			};
		}
		void setCachedSessionDetails(currentSpaceId, [renamedSession]).catch(
			() => undefined,
		);
		void patchCachedSessionList(currentSpaceId, (current) =>
			current.map((s) => (s.id === session.id ? { ...s, title: trimmed } : s)),
		).catch(() => undefined);
	} catch {
		// Silently fail
	} finally {
		renameSaving = false;
		cancelRenameSession();
	}
}

function isUserLabel(label: LabelListItem) {
	return label.source === "user";
}

function canManageUserLabel(label: LabelListItem) {
	return canManageLabels && isUserLabel(label);
}

function canRenameLabel(label: LabelListItem) {
	return canManageUserLabel(label);
}

function canDeleteLabel(label: LabelListItem) {
	return canManageUserLabel(label);
}

function startRenameLabel(label: LabelListItem) {
	if (!canRenameLabel(label)) return;
	renamingLabelId = label.id;
	renameLabelValue = label.name;
	void tick().then(() => {
		renameLabelInputElement?.focus();
		renameLabelInputElement?.select();
	});
}

function cancelRenameLabel() {
	renamingLabelId = null;
	renameLabelValue = "";
}

async function deleteLabel(label: LabelListItem) {
	if (deletingLabelId || !currentSpaceId || !canDeleteLabel(label)) return;
	if (label.children?.length) {
		window.alert(m.sidebar_delete_child_labels_first({}, { locale }));
		return;
	}
	const labelRef = labelRefForId(label.id);
	if (!labelRef) {
		window.alert(m.sidebar_label_not_found({}, { locale }));
		return;
	}
	const confirmed = window.confirm(
		m.sidebar_delete_label_confirm({ label: label.name }, { locale }),
	);
	if (!confirmed) return;

	deletingLabelId = label.id;
	try {
		if (renamingLabelId === label.id) cancelRenameLabel();
		await sdk.space(currentSpaceId).labels.delete(labelRef);
		labels = await fetchSpaceLabelsFresh(currentSpaceId);
		const nextExpanded = new Set(currentExpandedLabelIds);
		nextExpanded.delete(label.id);
		expandedLabelIdsBySpace = {
			...expandedLabelIdsBySpace,
			[currentSpaceId]: nextExpanded,
		};
		setCachedExpandedLabelIds(currentSpaceId, nextExpanded);
	} catch (error) {
		console.warn("[labels] Failed to delete label", {
			labelId: label.id,
			error,
		});
		window.alert(
			error instanceof Error
				? error.message
				: m.sidebar_failed_delete_label({}, { locale }),
		);
	} finally {
		deletingLabelId = null;
	}
}

async function submitRenameLabel(label: LabelListItem) {
	if (renameLabelSaving || !currentSpaceId || !canRenameLabel(label)) return;
	const trimmed = renameLabelValue.trim();
	if (!trimmed || trimmed === label.name) {
		cancelRenameLabel();
		return;
	}
	const labelRef = labelRefForId(label.id);
	if (!labelRef) {
		cancelRenameLabel();
		return;
	}

	renameLabelSaving = true;
	try {
		await sdk.space(currentSpaceId).labels.update(labelRef, { name: trimmed });
		labels = replaceLabelInTree(labels, label.id, (item) => ({
			...item,
			name: trimmed,
		}));
		labels = await fetchSpaceLabelsFresh(currentSpaceId);
	} catch (error) {
		console.warn("[labels] Failed to rename label", {
			labelId: label.id,
			error,
		});
	} finally {
		renameLabelSaving = false;
		cancelRenameLabel();
	}
}

function handleLabelRowClick(label: LabelListItem) {
	if (renamingLabelId === label.id) return;
	toggleLabelExpanded(label.id);
}

function handleLabelRowKeydown(event: KeyboardEvent, label: LabelListItem) {
	if (renamingLabelId === label.id) return;
	if (event.key !== "Enter" && event.key !== " ") return;
	event.preventDefault();
	toggleLabelExpanded(label.id);
}

function handleLabelRenameKeydown(event: KeyboardEvent, label: LabelListItem) {
	if (
		event.key === "Enter" &&
		!renameLabelSaving &&
		!isComposingKeyboardEvent(event)
	) {
		event.preventDefault();
		void submitRenameLabel(label);
		return;
	}
	if (event.key === "Escape" && !renameLabelSaving) {
		event.preventDefault();
		cancelRenameLabel();
	}
}

function normalizeSessionDisplayText(value: string | null | undefined) {
	return formatResourceMentionTextForDisplay(value ?? "")
		.replace(/\s+/g, " ")
		.replace(/^[:\-\s]+/, "")
		.trim();
}

function getSessionTitle(session: SessionRecord, _index: number) {
	const candidates = [session.title, session.latestMessageText];
	for (const candidate of candidates) {
		const normalized = normalizeSessionDisplayText(candidate);
		if (normalized) return normalized.slice(0, 36);
	}
	return m.sidebar_new_chat({}, { locale });
}

function isLikelyDefaultForkTitle(
	session: SessionRecord,
	fork: SessionForkSidebarRecord | null,
) {
	if (!fork) return false;
	const childTitle = normalizeSessionDisplayText(session.title);
	if (!childTitle) return true;
	const parentTitle = normalizeSessionDisplayText(fork.parentTitle);
	return Boolean(parentTitle && childTitle === parentTitle);
}

function buildForkTitle(
	session: SessionRecord,
	fork: SessionForkSidebarRecord | null,
) {
	const forkText = normalizeSessionDisplayText(fork?.firstUserTextAfterFork);
	if (forkText && isLikelyDefaultForkTitle(session, fork))
		return forkText.slice(0, 48);
	return getSessionTitle(session, 0);
}

function getSessionRowStyle(item: SidebarSessionItem) {
	if (!item.isFork)
		return isMobile
			? "-webkit-touch-callout: none; user-select: none;"
			: undefined;
	const depth = isMobile ? Math.min(item.visualDepth, 1) : item.visualDepth;
	const indent = Math.min(depth, 3) * (isMobile ? 10 : 12);
	const base = `--fork-indent: ${indent}px;`;
	return isMobile
		? `${base} -webkit-touch-callout: none; user-select: none;`
		: base;
}

function getSessionActiveTime(session: SessionRecord) {
	return getSessionSortTime(session);
}

function buildSidebarSessionItems(
	sessionList: SessionRecord[],
): SidebarSessionItem[] {
	const sessionById = new Map(
		sessionList.map((session) => [session.id, session]),
	);
	const forkByChildId = new Map(
		sessionForks.map((fork) => [fork.childSessionId, fork]),
	);
	const childrenByParentId = new Map<string, SessionRecord[]>();
	const childIndexById = new Map<string, number>();
	const childCountByParentId = new Map<string, number>();

	for (const session of sessionList) {
		const fork = forkByChildId.get(session.id);
		if (!fork?.parentSessionId || !sessionById.has(fork.parentSessionId))
			continue;
		const siblings = childrenByParentId.get(fork.parentSessionId) ?? [];
		siblings.push(session);
		childrenByParentId.set(fork.parentSessionId, siblings);
	}

	const groupActiveTime = new Map<string, number>();
	const getGroupActiveTime = (
		session: SessionRecord,
		seen = new Set<string>(),
	) => {
		const cachedActiveTime = groupActiveTime.get(session.id);
		if (cachedActiveTime !== undefined) return cachedActiveTime;
		if (seen.has(session.id)) return getSessionActiveTime(session);
		seen.add(session.id);
		let activeTime = getSessionActiveTime(session);
		for (const child of childrenByParentId.get(session.id) ?? []) {
			activeTime = Math.max(activeTime, getGroupActiveTime(child, seen));
		}
		seen.delete(session.id);
		groupActiveTime.set(session.id, activeTime);
		return activeTime;
	};

	const compareSessions = (a: SessionRecord, b: SessionRecord) => {
		const activeDelta = getGroupActiveTime(b) - getGroupActiveTime(a);
		if (activeDelta !== 0) return activeDelta;
		return b.id.localeCompare(a.id);
	};

	for (const [parentId, children] of childrenByParentId) {
		const sortedChildren = children.sort(compareSessions);
		childCountByParentId.set(parentId, sortedChildren.length);
		sortedChildren.forEach((child, index) => {
			childIndexById.set(child.id, index);
		});
	}

	const roots = sessionList
		.filter((session) => {
			const fork = forkByChildId.get(session.id);
			return !fork?.parentSessionId || !sessionById.has(fork.parentSessionId);
		})
		.sort(compareSessions);

	const items: SidebarSessionItem[] = [];
	const appendSession = (
		session: SessionRecord,
		visualDepth: number,
		seen = new Set<string>(),
	) => {
		if (seen.has(session.id)) return;
		seen.add(session.id);
		const fork = forkByChildId.get(session.id) ?? null;
		const parentVisible = Boolean(
			fork?.parentSessionId && sessionById.has(fork.parentSessionId),
		);
		const connectedFork = parentVisible ? fork : null;
		const displayTitle = connectedFork
			? buildForkTitle(session, connectedFork)
			: getSessionTitle(session, 0);
		const source = connectedFork?.parentTitle
			? m.sidebar_forked_from(
					{ title: normalizeSessionDisplayText(connectedFork.parentTitle) },
					{ locale },
				)
			: m.sidebar_forked_from_chat({}, { locale });
		const turn = connectedFork?.anchorSequence
			? ` at turn #${connectedFork.anchorSequence}`
			: "";
		const tooltip = connectedFork ? `${source}${turn}` : undefined;
		const childIndex = childIndexById.get(session.id);
		const childCount = fork?.parentSessionId
			? childCountByParentId.get(fork.parentSessionId)
			: undefined;
		const isLastVisibleChild = Boolean(
			connectedFork &&
				childIndex !== undefined &&
				childCount !== undefined &&
				childIndex === childCount - 1,
		);
		items.push({
			session,
			depth: connectedFork?.depth ?? 0,
			visualDepth: connectedFork ? visualDepth : 0,
			isFork: Boolean(connectedFork),
			parentVisible,
			isLastVisibleChild,
			fork: connectedFork,
			displayTitle,
			titleText: tooltip,
			ariaLabel: tooltip ? `${displayTitle}, ${tooltip}` : displayTitle,
		});

		const children = childrenByParentId.get(session.id) ?? [];
		for (const child of children) appendSession(child, visualDepth + 1, seen);
		seen.delete(session.id);
	};

	for (const root of roots) appendSession(root, 0);
	return items;
}

function buildLabelSessionItems(items: LabelAssignmentListItem[]) {
	const labelSessions = items
		.filter((item) => item.resourceType === "session")
		.map((item) => labelSessionsById.get(item.resourceRef))
		.filter((session): session is SessionRecord => Boolean(session));
	return buildSidebarSessionItems(labelSessions);
}

function orderLabelItemsBySessionTree(
	items: LabelAssignmentListItem[],
	sessionItems: SidebarSessionItem[],
) {
	const sessionItemByRef = new Map(
		items
			.filter((item) => item.resourceType === "session")
			.map((item) => [item.resourceRef, item]),
	);
	const orderedSessionItems = sessionItems
		.map((sessionItem) => sessionItemByRef.get(sessionItem.session.id))
		.filter((item): item is LabelAssignmentListItem => Boolean(item));
	const orderedSessionRefs = new Set(
		orderedSessionItems.map((item) => item.resourceRef),
	);
	const remainingSessionItems = items.filter(
		(item) =>
			item.resourceType === "session" &&
			!orderedSessionRefs.has(item.resourceRef),
	);
	const sessionQueue = [...orderedSessionItems, ...remainingSessionItems];
	return items.map((item) =>
		item.resourceType === "session" ? (sessionQueue.shift() ?? item) : item,
	);
}

async function handleLogout() {
	onClose?.();
	const commandPaletteRecentKey = `cohub:command-palette:recent:${encodeURIComponent(getCacheUserKey())}`;
	try {
		localStorage.removeItem(commandPaletteRecentKey);
	} catch {
		// Ignore storage cleanup failures during logout.
	}
	clearAllCachedSpaceLists();
	clearCachedPaletteOverview();
	clearTaskRunsMemoryCache();
	await clearAllIndexedDbCache().catch((error) => {
		console.warn("[sidebar] Failed to clear IndexedDB cache", error);
	});
	const userUuid = authStore.userUuid;
	if (userUuid) clearActivityCache(userUuid);
	if (userUuid) clearRecentSpace(userUuid);
	if (userUuid) clearGrantedAppScopes(userUuid);
	authStore.reset();
	try {
		await logtoClient.signOut(`${window.location.origin}/`);
	} catch (error) {
		console.error("[sidebar] Failed to sign out", error);
	}
}

function saveDebugLog() {
	showUserMenu = false;
	onClose?.();
	downloadCohubDebugBundle();
}

function handleGlobalSidebarKeydown(event: KeyboardEvent) {
	if (isComposingKeyboardEvent(event)) return;
	const key = event.key.toLowerCase();
	// Chord shortcuts (⌘O / ⌘⇧U) should work while the composer is focused —
	// same as New Chat. They don't insert characters, so no typing conflict.
	const isNewChatShortcut =
		(event.metaKey || event.ctrlKey) &&
		!event.shiftKey &&
		!event.altKey &&
		key === "o";
	if (isNewChatShortcut) {
		event.preventDefault();
		void handleCreateNewSession();
		return;
	}
	const isOwnChatsShortcut =
		(event.metaKey || event.ctrlKey) &&
		event.shiftKey &&
		!event.altKey &&
		key === "u";
	if (!isOwnChatsShortcut) return;
	if (mode !== "space" || !currentSpaceId) return;
	event.preventDefault();
	focusOwnSessionUserLabelOrFallback();
}

onMount(() => {
	void modelsCatalogStore.load().catch((error) => {
		console.error("Failed to load models catalog:", error);
	});
	let offSpaceListCacheUpdated = () => {};
	let offSessionListCacheUpdated = () => {};
	let offSpaceLabelsCacheUpdated = () => {};
	let offUserLabelProfilesUpdated = () => {};
	let offChannelLabelDisplayNamesUpdated = () => {};
	let offTaskRunsCacheUpdated = () => {};
	if (mode === "space") {
		offSpaceListCacheUpdated = onSpaceListCacheUpdated(
			({ spaces: nextSpaces }) => {
				if (!authStore.isAuthenticated) return;
				spaces = mergeSpaceListWithCurrent(nextSpaces);
			},
		);
		offSessionListCacheUpdated = onSessionListCacheUpdated(
			({ spaceId, sessions: nextSessions, forks, pageInfo }) => {
				if (spaceId !== currentSpaceId) return;
				const previousSessionsById = new Map(
					sessions.map((session) => [session.id, session]),
				);
				const shouldPreserveLoadedPageInfo =
					sessions.length > nextSessions.length;
				let shouldRefreshActivityLabels = false;
				sessions = mergeSessionSnapshotForDisplay(sessions, nextSessions);
				for (const session of nextSessions) {
					const previous = previousSessionsById.get(session.id);
					if (!previous) {
						optimisticPrependWebAppLabelSession(spaceId, session);
						continue;
					}
					if (didSessionActivityChange(previous, session)) {
						shouldRefreshActivityLabels = true;
					}
				}
				if (shouldRefreshActivityLabels)
					refreshExpandedSessionActivityLabels(spaceId);
				applySessionForks(forks);
				if (pageInfo && !shouldPreserveLoadedPageInfo)
					sessionsPageInfo = pageInfo;
				exhaustedFallbackSessionCursor = null;
			},
		);
		offSpaceLabelsCacheUpdated = onSpaceLabelsCacheUpdated(
			({ spaceId, labels: nextLabels }) => {
				if (spaceId !== currentSpaceId) return;
				labels = nextLabels;
				pruneExpandedLabelIds(spaceId, nextLabels);
				hydrateSystemLabelDisplays(nextLabels);
			},
		);
		offUserLabelProfilesUpdated = onUserLabelProfilesUpdated(() => {
			userLabelProfileVersion += 1;
		});
		offChannelLabelDisplayNamesUpdated = onChannelLabelDisplayNamesUpdated(
			() => {
				channelLabelDisplayVersion += 1;
			},
		);
		hydrateSystemLabelDisplays(labels);
		offTaskRunsCacheUpdated = onTaskRunsCacheUpdated(({ spaceId, runs }) => {
			if (spaceId !== currentSpaceId) return;
			tasks = runs;
		});
		// Desktop sidebar owns space shortcuts (⌘O / ⌘⇧U). Mobile has no keyboard surface.
		if (!isMobile) {
			window.addEventListener("keydown", handleGlobalSidebarKeydown);
		}
		window.addEventListener(
			APPS_CHANGED_EVENT,
			handleWorksChanged as EventListener,
		);
		void (async () => {
			await loadSpaces();
			hydrateSystemLabelDisplays(labels);

			window.addEventListener(
				"cohub:space-created",
				handleSpaceCreated as EventListener,
			);
			window.addEventListener(
				"cohub:checkpoints-updated",
				handleCheckpointsUpdated as EventListener,
			);
			window.addEventListener(
				"cohub:cronjobs-updated",
				handleCronjobsUpdated as EventListener,
			);
			window.addEventListener(
				"cohub:label-assignments-updated",
				handleLabelAssignmentsUpdated as EventListener,
			);
		})();
	}

	function handleSpaceCreated() {
		void loadSpaces(true);
	}

	function handleCheckpointsUpdated(e: Event) {
		const custom = e as CustomEvent;
		if (custom.detail?.spaceId === currentSpaceId && currentSpaceId) {
			void loadCheckpointsForSpace(currentSpaceId, true);
		}
	}

	function handleCronjobsUpdated(e: Event) {
		const custom = e as CustomEvent;
		if (custom.detail?.spaceId === currentSpaceId && currentSpaceId) {
			void loadCronjobsForSpace(currentSpaceId, true);
		}
	}

	function handleLabelAssignmentsUpdated(e: Event) {
		const custom = e as CustomEvent<{
			spaceId?: string;
			affectedLabelIds?: string[];
		}>;
		const spaceId = custom.detail?.spaceId;
		if (!spaceId || spaceId !== currentSpaceId) return;
		const expanded = expandedLabelIdsBySpace[spaceId];
		if (!expanded) return;
		for (const labelId of custom.detail?.affectedLabelIds ?? []) {
			if (expanded.has(labelId)) void loadLabelItems(labelId, { force: true });
			else void markLabelItemsStale(spaceId, labelId);
		}
	}

	function handleClickOutside(e: MouseEvent) {
		const target = e.target;
		if (!(target instanceof Element)) return;
		if (!target.closest("[data-user-menu]")) {
			showUserMenu = false;
		}
		if (
			renamingSessionId &&
			!renameSaving &&
			!target.closest("[data-session-rename]")
		) {
			cancelRenameSession();
		}
	}
	document.addEventListener("click", handleClickOutside);

	return () => {
		offSpaceListCacheUpdated();
		offSessionListCacheUpdated();
		offSpaceLabelsCacheUpdated();
		offUserLabelProfilesUpdated();
		offChannelLabelDisplayNamesUpdated();
		offTaskRunsCacheUpdated();
		document.removeEventListener("click", handleClickOutside);
		if (mode === "space") {
			if (!isMobile) {
				window.removeEventListener("keydown", handleGlobalSidebarKeydown);
			}
			window.removeEventListener(
				APPS_CHANGED_EVENT,
				handleWorksChanged as EventListener,
			);
			window.removeEventListener(
				"cohub:space-created",
				handleSpaceCreated as EventListener,
			);
			window.removeEventListener(
				"cohub:checkpoints-updated",
				handleCheckpointsUpdated as EventListener,
			);
			window.removeEventListener(
				"cohub:cronjobs-updated",
				handleCronjobsUpdated as EventListener,
			);
			window.removeEventListener(
				"cohub:label-assignments-updated",
				handleLabelAssignmentsUpdated as EventListener,
			);
		}
	};
});

// Always load the space addressed by the current URL directly. The global
// space list is only a switcher data source and may omit guest-access spaces.
$effect(() => {
	const userId = authStore.userUuid;
	if (!authStore.isAuthenticated || !userId) {
		clearBillingCredit();
		return;
	}
	if (billingCreditUserId && billingCreditUserId !== userId) {
		clearBillingCredit();
	}
	if (!showUserMenu) return;
	untrack(() => {
		void refreshBillingCredit();
		void refreshBillingPlan();
	});
});

$effect(() => {
	if (mode !== "space") return;
	const id = currentSpaceId;
	if (!id) return;

	untrack(() => {
		void loadCurrentSpaceFromUrl(id);
	});
});

$effect(() => {
	if (mode !== "space") return;
	const id = currentSpaceId;
	if (id) {
		sessions = [];
		sessionForks = [];
		labels = [];
		checkpoints = [];
		cronjobs = [];
		tasks = [];
		apps = [];
		sessionsPageInfo = { hasMore: false, nextCursor: null };
		exhaustedFallbackSessionCursor = null;
		loadingSessions = false;
		loadingSessionsSpaceId = null;
		refreshingSessions = false;
		// Keep the labels section in a loading state until cache/network settles
		// so cold entry does not flash "No labels yet".
		labelsLoadToken += 1;
		loadingLabels = true;
		refreshingLabels = false;
		loadingCheckpoints = false;
		loadingCheckpointsSpaceId = null;
		refreshingCheckpoints = false;
		loadingCronjobs = false;
		loadingCronjobsSpaceId = null;
		refreshingCronjobs = false;
		loadingTasks = false;
		loadingTasksSpaceId = null;
		refreshingTasks = false;
		loadingMoreTasks = false;
		tasksPageInfo = { hasMore: false, nextCursor: null };
		loadingApps = false;
		loadingAppsSpaceId = null;
		refreshingApps = false;
		labelDropTargetId = null;
		labelDropBusyId = null;
		labelDropErrorMessage = null;
		activeLabelDragOrigin = null;
		cancelRenameLabel();
		clearLabelAutoExpandTimer();
		untrack(() => {
			restoreExpandedLabelIds(id);
			// Cache-first only; network waits until All chats is expanded.
			void loadSessionsForSpace(id, {
				network: isSessionsNetworkEnabled(id),
			});
			void loadLabelsForSpace(id);
			void loadCheckpointsForSpace(id, true);
			void loadCronjobsForSpace(id, true);
			void loadAppsForSpace(id, true);
		});
	} else {
		sessions = [];
		sessionForks = [];
		labels = [];
		sessionsPageInfo = { hasMore: false, nextCursor: null };
		exhaustedFallbackSessionCursor = null;
		checkpoints = [];
		cronjobs = [];
		tasks = [];
		apps = [];
		loadingSessions = false;
		loadingSessionsSpaceId = null;
		refreshingSessions = false;
		labelsLoadToken += 1;
		loadingLabels = false;
		refreshingLabels = false;
		loadingCheckpoints = false;
		loadingCheckpointsSpaceId = null;
		refreshingCheckpoints = false;
		loadingCronjobs = false;
		loadingCronjobsSpaceId = null;
		refreshingCronjobs = false;
		loadingTasks = false;
		loadingTasksSpaceId = null;
		refreshingTasks = false;
		loadingMoreTasks = false;
		tasksPageInfo = { hasMore: false, nextCursor: null };
		labelDropTargetId = null;
		labelDropBusyId = null;
		labelDropErrorMessage = null;
		activeLabelDragOrigin = null;
		cancelRenameLabel();
		clearLabelAutoExpandTimer();
	}
});

// Track the most recently visited space in localStorage. Visiting a space is
// a device-local signal the palette already folds into its first frame, so it
// must NOT invalidate the overview snapshot — doing so forced a server
// refetch on the next palette open. Cross-device recency is picked up by the
// freshness window and the focus/visibility revalidation instead.
$effect(() => {
	if (mode !== "space") return;
	const userUuid = authStore.userUuid;
	if (!userUuid || !currentSpaceId) return;
	untrack(() => {
		const sessionId = activeSession?.id ?? null;
		setRecentSpace(userUuid, currentSpaceId, sessionId);
	});
});
</script>

{#snippet syncSpinner(active: boolean, className = "")}
	{#if active}
		<Loader2 class={`h-3 w-3 animate-spin text-text-placeholder ${className}`} aria-label={m.sidebar_syncing({}, { locale })} />
	{/if}
{/snippet}

{#snippet sidebarEmptyState(message: string, loading = false)}
	<div class="flex min-h-8 items-center gap-2 rounded-[var(--sidebar-item-radius)] px-1.5 py-2 text-[12px] text-text-placeholder">
		{#if loading}
			<Loader2 class="h-3 w-3 animate-spin text-text-tertiary" />
		{/if}
		<span>{message}</span>
	</div>
{/snippet}

{#snippet labelAssignmentRows(label: LabelListItem, depth: number)}
	{@const items = currentLabelItemsById[label.id] ?? []}
	{@const hasChildLabels = Boolean(label.children?.length)}
	{#if currentExpandedLabelIds.has(label.id)}
		{@const useSessionTreeOrder = isSessionActivityLabel(label)}
		{@const labelSessionItems = useSessionTreeOrder ? buildLabelSessionItems(items) : []}
		{@const labelSessionItemById = new Map(labelSessionItems.map((item) => [item.session.id, item]))}
		{@const orderedItems = useSessionTreeOrder ? orderLabelItemsBySessionTree(items, labelSessionItems) : items}
		{@const canEditLabelItems = canAssignResourceToLabel(label)}
		{@const itemIndentPx = Math.max(0, depth) * 16}
		{@const itemIndentStyle = itemIndentPx > 0 ? `padding-left: ${itemIndentPx}px` : undefined}
		{#if items.length === 0 && !hasChildLabels}
			{#if currentLoadingLabelIds.has(label.id)}
				<div class="flex min-h-8 items-center gap-2 rounded-[var(--sidebar-item-radius)] px-1.5 py-2 text-[12px] text-text-placeholder" style={itemIndentStyle}><Loader2 class="h-3 w-3 animate-spin text-text-tertiary" /> {m.sidebar_loading_items({}, { locale })}</div>
			{:else}
				<div class="flex min-h-8 items-center rounded-[var(--sidebar-item-radius)] px-1.5 py-2 text-[12px] text-text-placeholder" style={itemIndentStyle}>{m.sidebar_no_items({}, { locale })}</div>
			{/if}
		{:else if orderedItems.length > 0}
			<div class="space-y-[1px]" style={itemIndentStyle}>
				{#each orderedItems as item (item.id)}
					{@const isActive = isLabelAssignmentActive(item)}
					{@const itemDraggable = isDraggableLabelItem(item)}
					{@const canRemoveItem = canEditLabelItems && item.source !== "system"}
					{@const labelRemoveTitle = m.sidebar_remove_from_label({ label: getReactiveLabelDisplayName(label) }, { locale })}
					{#if item.resourceType === "session" && labelSessionsById.get(item.resourceRef)}
						{@const session = labelSessionsById.get(item.resourceRef)!}
						{@const sessionItem = labelSessionItemById.get(session.id)}
						<SidebarSessionRow
							{session}
							title={sessionItem?.displayTitle ?? getSessionTitle(session, 0)}
							href={buildPreferredSessionRoute(currentSpaceId!, session.id)}
							active={isActive}
							{isMobile}
							modelsCatalog={modelsCatalog ?? undefined}
							renaming={renamingSessionId === session.id}
							renameValue={renameTitleValue}
							renameSaving={renameSaving}
							rowState={sessionItem
								? {
										isFork: sessionItem.isFork,
										isLastVisibleChild: sessionItem.isLastVisibleChild,
										style: getSessionRowStyle(sessionItem),
										titleText: sessionItem.titleText || undefined,
										ariaLabel: sessionItem.ariaLabel,
									}
								: undefined}
							draggable={itemDraggable}
							removeLabelTitle={canRemoveItem ? labelRemoveTitle : undefined}
							removeLabelDisabled={labelDropBusyId === label.id}
							onNavigate={(target) => void handleNavigateToSession(target.id)}
							onDoubleClick={handleSessionRowDoubleClick}
							onInsert={insertPathReference}
							onRename={startRenameSession}
							onRenameValueChange={(value) => { renameTitleValue = value; }}
							onSubmitRename={(target) => void submitRenameSession(target)}
							onCancelRename={cancelRenameSession}
							onRemoveLabel={canRemoveItem ? () => void removeLabelAssignment(label, item) : undefined}
							onDragStart={(event) => handleLabelItemDragStart(event, label, item)}
							onDragEnd={handleResourceDragEnd}
						/>
					{:else if item.resourceType === "checkpoint" && checkpointsById.get(item.resourceRef)}
						{@const checkpoint = checkpointsById.get(item.resourceRef)!}
						<SidebarCheckpointRow
							{checkpoint}
							href={buildSpaceCheckpointRoute(currentSpaceId!, checkpoint.id)}
							active={isActive}
							removeLabelTitle={canRemoveItem ? labelRemoveTitle : undefined}
							removeLabelDisabled={labelDropBusyId === label.id}
							onNavigate={(target) => void handleNavigateToCheckpoint(target.id)}
							onRemoveLabel={canRemoveItem ? () => void removeLabelAssignment(label, item) : undefined}
						/>
					{:else if item.resourceType === "file"}
						<SidebarFileRow
							path={item.resourceRef}
							title={item.resource?.title ?? item.resourceRef.split("/").filter(Boolean).at(-1) ?? item.resourceRef}
							subtitle={item.resource?.subtitle ?? null}
							href={labelAssignmentHref(item)}
							active={isActive}
							{isMobile}
							removeLabelTitle={canRemoveItem ? labelRemoveTitle : undefined}
							removeLabelDisabled={labelDropBusyId === label.id}
							onNavigate={() => void handleNavigate(labelAssignmentHref(item))}
							onInsert={insertPathReference}
							onRemoveLabel={canRemoveItem ? () => void removeLabelAssignment(label, item) : undefined}
						/>
					{:else}
						<SidebarFallbackResourceRow
							{item}
							active={isActive}
							removeLabelTitle={canRemoveItem ? labelRemoveTitle : undefined}
							removeLabelDisabled={labelDropBusyId === label.id}
							onNavigate={(href) => void handleNavigate(href)}
							onRemoveLabel={canRemoveItem ? () => void removeLabelAssignment(label, item) : undefined}
						/>
					{/if}
				{/each}
			</div>
			{#if currentLabelItemsPageInfoById[label.id]?.hasMore}
				<button
					type="button"
					class="mt-0.5 flex w-full items-center rounded-[5px] px-2 py-1 text-left text-[11px] text-text-tertiary transition-colors hover:bg-bg-hover hover:text-text-secondary disabled:opacity-60"
					style={itemIndentStyle}
					disabled={currentLoadingLabelIds.has(label.id)}
					onclick={() => void loadLabelItems(label.id, { append: true })}
				>
					{#if currentLoadingLabelIds.has(label.id)}{m.common_loading({}, { locale })}{:else}{m.sidebar_show_more({}, { locale })}{/if}
				</button>
			{/if}
		{/if}
	{/if}
{/snippet}

{#snippet labelTreeRows(labelItems: LabelListItem[])}
	{#each labelItems as label (label.id)}
		<div
			role="button"
			tabindex="0"
			data-sidebar-label-id={label.id}
			class="label-tree-row group/label"
			class:drop-target={labelDropTargetId === label.id}
			class:drop-busy={labelDropBusyId === label.id}
			class:drop-success={labelDropSuccessId === label.id}
			class:drop-error={labelDropErrorId === label.id}
			class:renaming={renamingLabelId === label.id}
			onclick={() => handleLabelRowClick(label)}
			onkeydown={(event) => handleLabelRowKeydown(event, label)}
			ondragover={(event) => handleLabelDragOver(event, label)}
			ondragleave={(event) => handleLabelDragLeave(event, label)}
			ondrop={(event) => handleLabelDrop(event, label)}
		>
			<ChevronDown class="h-3 w-3 shrink-0 transition-transform {currentExpandedLabelIds.has(label.id) ? '' : '-rotate-90'}" />
			{#if renamingLabelId === label.id}
				<input
					bind:this={renameLabelInputElement}
					bind:value={renameLabelValue}
					class="label-rename-input"
					disabled={renameLabelSaving}
					onclick={(event) => event.stopPropagation()}
					onkeydown={(event) => handleLabelRenameKeydown(event, label)}
				/>
				<span class="ml-auto inline-flex shrink-0 items-center gap-0.5">
					<button type="button" class="rounded p-0.5 text-text-tertiary transition-colors hover:bg-bg-hover-strong hover:text-text-primary disabled:opacity-50" title={m.common_save({}, { locale })} disabled={renameLabelSaving} onclick={(event) => { event.preventDefault(); event.stopPropagation(); void submitRenameLabel(label); }}>
						{#if renameLabelSaving}<Loader2 class="h-3.5 w-3.5 animate-spin" />{:else}<Check class="h-3.5 w-3.5" />{/if}
					</button>
					<button type="button" class="rounded p-0.5 text-text-tertiary transition-colors hover:bg-bg-hover-strong hover:text-text-primary disabled:opacity-50" title={m.common_cancel({}, { locale })} disabled={renameLabelSaving} onclick={(event) => { event.preventDefault(); event.stopPropagation(); cancelRenameLabel(); }}>
						<X class="h-3.5 w-3.5" />
					</button>
				</span>
			{:else}
				{@const labelProfile = getReactiveLabelUserProfile(label)}
				{@const labelChannel = getReactiveLabelChannelInfo(label)}
				{#if labelProfile || isSessionUserLabel(label)}
					<UserAvatar name={getReactiveLabelDisplayName(label)} avatarUrl={labelProfile?.avatarUrl} size="xxs" class="border-0 bg-bg-elevated" />
				{:else if labelChannel || isSessionChannelLabel(label)}
					<ChannelProviderIcon provider={labelChannel?.provider} size="xxs" />
				{/if}
				<span class="min-w-0 flex-1 truncate" title={getReactiveLabelDisplayTitle(label)}>{getReactiveLabelDisplayName(label)}</span>
				{#if canManageUserLabel(label)}
					<span class="label-row-actions">
						<button type="button" class="rounded p-0.5 text-text-tertiary transition-colors hover:bg-bg-hover-strong hover:text-text-primary disabled:opacity-50" draggable="false" title={m.common_edit({}, { locale })} disabled={deletingLabelId === label.id} onclick={(event) => { event.preventDefault(); event.stopPropagation(); startRenameLabel(label); }}>
							<Pencil class="h-3.5 w-3.5" />
						</button>
						<button type="button" class="rounded p-0.5 text-text-tertiary transition-colors hover:bg-bg-hover-strong hover:text-status-error disabled:opacity-50" draggable="false" title={m.common_delete({}, { locale })} disabled={deletingLabelId === label.id} onclick={(event) => { event.preventDefault(); event.stopPropagation(); void deleteLabel(label); }}>
							{#if deletingLabelId === label.id}<Loader2 class="h-3.5 w-3.5 animate-spin" />{:else}<Trash2 class="h-3.5 w-3.5" />{/if}
						</button>
					</span>
				{/if}
			{/if}
		</div>
		{@render labelAssignmentRows(label, 0)}
		{#if currentExpandedLabelIds.has(label.id)}
			{#each label.children ?? [] as child (child.id)}
				<div
					role="button"
					tabindex="0"
					data-sidebar-label-id={child.id}
					class="label-tree-row child group/label"
					class:drop-target={labelDropTargetId === child.id}
					class:drop-busy={labelDropBusyId === child.id}
					class:drop-success={labelDropSuccessId === child.id}
					class:drop-error={labelDropErrorId === child.id}
					class:renaming={renamingLabelId === child.id}
					onclick={() => handleLabelRowClick(child)}
					onkeydown={(event) => handleLabelRowKeydown(event, child)}
					ondragover={(event) => handleLabelDragOver(event, child)}
					ondragleave={(event) => handleLabelDragLeave(event, child)}
					ondrop={(event) => handleLabelDrop(event, child)}
				>
					<ChevronDown class="h-3 w-3 shrink-0 transition-transform {currentExpandedLabelIds.has(child.id) ? '' : '-rotate-90'}" />
					{#if renamingLabelId === child.id}
						<input
							bind:this={renameLabelInputElement}
							bind:value={renameLabelValue}
							class="label-rename-input"
							disabled={renameLabelSaving}
							onclick={(event) => event.stopPropagation()}
							onkeydown={(event) => handleLabelRenameKeydown(event, child)}
						/>
						<span class="ml-auto inline-flex shrink-0 items-center gap-0.5">
							<button type="button" class="rounded p-0.5 text-text-tertiary transition-colors hover:bg-bg-hover-strong hover:text-text-primary disabled:opacity-50" title={m.common_save({}, { locale })} disabled={renameLabelSaving} onclick={(event) => { event.preventDefault(); event.stopPropagation(); void submitRenameLabel(child); }}>
								{#if renameLabelSaving}<Loader2 class="h-3.5 w-3.5 animate-spin" />{:else}<Check class="h-3.5 w-3.5" />{/if}
							</button>
							<button type="button" class="rounded p-0.5 text-text-tertiary transition-colors hover:bg-bg-hover-strong hover:text-text-primary disabled:opacity-50" title={m.common_cancel({}, { locale })} disabled={renameLabelSaving} onclick={(event) => { event.preventDefault(); event.stopPropagation(); cancelRenameLabel(); }}>
								<X class="h-3.5 w-3.5" />
							</button>
						</span>
					{:else}
						{@const childProfile = getReactiveLabelUserProfile(child)}
						{@const childChannel = getReactiveLabelChannelInfo(child)}
						{#if childProfile || isSessionUserLabel(child)}
							<UserAvatar name={getReactiveLabelDisplayName(child)} avatarUrl={childProfile?.avatarUrl} size="xxs" class="border-0 bg-bg-elevated" />
						{:else if childChannel || isSessionChannelLabel(child)}
							<ChannelProviderIcon provider={childChannel?.provider} size="xxs" />
						{/if}
						<span class="min-w-0 flex-1 truncate" title={getReactiveLabelDisplayTitle(child)}>{getReactiveLabelDisplayName(child)}</span>
						{#if canManageUserLabel(child)}
							<span class="label-row-actions">
								<button type="button" class="rounded p-0.5 text-text-tertiary transition-colors hover:bg-bg-hover-strong hover:text-text-primary disabled:opacity-50" draggable="false" title={m.common_edit({}, { locale })} disabled={deletingLabelId === child.id} onclick={(event) => { event.preventDefault(); event.stopPropagation(); startRenameLabel(child); }}>
									<Pencil class="h-3.5 w-3.5" />
								</button>
								<button type="button" class="rounded p-0.5 text-text-tertiary transition-colors hover:bg-bg-hover-strong hover:text-status-error disabled:opacity-50" draggable="false" title={m.common_delete({}, { locale })} disabled={deletingLabelId === child.id} onclick={(event) => { event.preventDefault(); event.stopPropagation(); void deleteLabel(child); }}>
									{#if deletingLabelId === child.id}<Loader2 class="h-3.5 w-3.5 animate-spin" />{:else}<Trash2 class="h-3.5 w-3.5" />{/if}
								</button>
							</span>
						{/if}
					{/if}
				</div>
				{@render labelAssignmentRows(child, 1)}
			{/each}
		{/if}
	{/each}
{/snippet}

{#snippet labelsSection(showHeader = true)}
	<div class={showHeader ? "mt-2" : "mt-0"}>
		{#if showHeader}
			<div
				class="flex w-full cursor-pointer items-center gap-2 rounded-[6px] px-1.5 py-1.5 text-left transition-colors duration-100 hover:bg-bg-hover"
				onclick={() => { labelsCollapsed = !labelsCollapsed; }}
				title={labelsCollapsed ? m.sidebar_expand_labels({}, { locale }) : m.sidebar_collapse_labels({}, { locale })}
				role="button"
				tabindex="0"
				onkeydown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); labelsCollapsed = !labelsCollapsed; } }}
			>
				<ChevronDown class="h-3 w-3 shrink-0 text-text-tertiary transition-transform duration-150 {labelsCollapsed ? 'rotate-180' : ''}" />
				<Tags class="h-3.5 w-3.5 shrink-0 text-text-placeholder" />
				<span class="text-[11px] text-text-placeholder select-none">{m.sidebar_labels({}, { locale })}</span>
				{@render syncSpinner(refreshingLabels, canManageLabels ? "ml-auto" : "ml-auto")}
				{#if canManageLabels}
					<span
						class="{refreshingLabels ? '' : 'ml-auto'} rounded p-0.5 text-text-placeholder transition-colors hover:bg-bg-hover hover:text-text-secondary"
						title={m.sidebar_new_label({}, { locale })}
						onclick={(event) => { event.stopPropagation(); showNewLabelPopover = true; }}
						onkeydown={(event) => { if (event.key === "Enter" || event.key === " ") { event.stopPropagation(); event.preventDefault(); showNewLabelPopover = true; } }}
						role="button"
						tabindex="0"
					>
						<Plus class="h-3 w-3" />
					</span>
				{/if}
			</div>
		{/if}
		{#if labelDropErrorMessage}
			<div class="label-drop-message" role="status">{labelDropErrorMessage}</div>
		{/if}
		{#if !showHeader || !labelsCollapsed}
			<div class="mt-1 space-y-[1px]">
				{#if loadingLabels && labels.length === 0}
					{@render sidebarEmptyState(m.sidebar_loading_labels({}, { locale }), true)}
				{:else if displayLabels.length === 0}
					<div class="px-6 py-1.5 text-[12px] text-text-tertiary">{m.sidebar_no_labels({}, { locale })}</div>
				{:else}
					{@render labelTreeRows(displayLabels)}
				{/if}
			</div>
		{/if}
	</div>
{/snippet}

{#snippet sourceLabelRows()}
	{#each sourceLabels as label (label.id)}
		<div
			role="button"
			tabindex="0"
			class="label-tree-row group/label"
			class:drop-target={labelDropTargetId === label.id}
			class:drop-busy={labelDropBusyId === label.id}
			class:drop-success={labelDropSuccessId === label.id}
			class:drop-error={labelDropErrorId === label.id}
			onclick={() => handleLabelRowClick(label)}
			onkeydown={(event) => handleLabelRowKeydown(event, label)}
			ondragover={(event) => handleLabelDragOver(event, label)}
			ondragleave={(event) => handleLabelDragLeave(event, label)}
			ondrop={(event) => handleLabelDrop(event, label)}
		>
			<ChevronDown class="h-3 w-3 shrink-0 transition-transform {currentExpandedLabelIds.has(label.id) ? '' : '-rotate-90'}" />
			<span class="min-w-0 flex-1 truncate" title={m.sidebar_source_label({ label: getReactiveLabelDisplayTitle(label) }, { locale })}>{getReactiveLabelDisplayName(label)}</span>
		</div>
		{@render labelAssignmentRows(label, 0)}
	{/each}
{/snippet}

{#snippet chatsSection(showHeader = true)}
	<div class={showHeader ? "mt-2" : "mt-0"}>
		{#if showHeader}
			<div
				class="flex w-full cursor-pointer items-center gap-2 rounded-[6px] px-1.5 py-1.5 text-left transition-colors duration-100 hover:bg-bg-hover"
				onclick={() => { chatsCollapsed = !chatsCollapsed; }}
				title={chatsCollapsed ? m.sidebar_expand_chats({}, { locale }) : m.sidebar_collapse_chats({}, { locale })}
				role="button"
				tabindex="0"
				onkeydown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); chatsCollapsed = !chatsCollapsed; } }}
			>
				<ChevronDown class="h-3 w-3 shrink-0 text-text-tertiary transition-transform duration-150 {chatsCollapsed ? 'rotate-180' : ''}" />
				<MessageSquare class="h-3.5 w-3.5 shrink-0 text-text-placeholder" />
				<span class="text-[11px] text-text-placeholder select-none">{m.sidebar_chats({}, { locale })}</span>
				{@render syncSpinner(refreshingSessions, "ml-auto")}
			</div>
		{/if}
		{#if !showHeader || !chatsCollapsed}
			<div class="mt-1 space-y-[1px]">
				{#if loadingLabels && labels.length === 0 && loadingSessions && sessions.length === 0}
					{@render sidebarEmptyState(m.sidebar_loading_chats({}, { locale }), true)}
				{:else}
					{@render sourceLabelRows()}
					{@render labelTreeRows(systemChannelLabels)}
					{@render labelTreeRows(systemUserLabels)}
					{@render allChatsLabelRow()}
				{/if}
			</div>
		{/if}
	</div>
{/snippet}

{#snippet allChatsLabelRow()}
	<div
		role="button"
		tabindex="0"
		class="label-tree-row group/label mt-1"
		onclick={() => toggleLabelExpanded(ALL_CHATS_LABEL_ID)}
		onkeydown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); toggleLabelExpanded(ALL_CHATS_LABEL_ID); } }}
	>
		<ChevronDown class="h-3 w-3 shrink-0 transition-transform {currentExpandedLabelIds.has(ALL_CHATS_LABEL_ID) ? '' : '-rotate-90'}" />
		<span class="min-w-0 flex-1 truncate" title={m.sidebar_all_chats({}, { locale })}>{m.sidebar_all({}, { locale })}</span>
		{@render syncSpinner(refreshingSessions, "ml-auto")}
	</div>
	{#if currentExpandedLabelIds.has(ALL_CHATS_LABEL_ID)}
		<div class="mt-1">
			{@render allChatsList(false)}
		</div>
	{/if}
{/snippet}

{#snippet allChatsList(preview = true)}
	{#if loadingSessions && sessions.length === 0}
		{@render sidebarEmptyState(m.sidebar_loading_chats({}, { locale }), true)}
	{:else if sessions.length === 0}
		{@render sidebarEmptyState(m.sidebar_no_chats({}, { locale }))}
	{:else}
		{@const chatItems = preview ? sidebarSessionItems.slice(0, sidebarFlyoutPreviewLimit) : sidebarSessionItems}
		<div class="space-y-[2px]">
			{#each chatItems as item (item.session.id)}
				{@const session = item.session}
				{@const isActive = activeSession?.id === session.id}
				<SidebarSessionRow
					{session}
					title={item.displayTitle}
					href={buildPreferredSessionRoute(currentSpaceId!, session.id)}
					active={isActive}
					{isMobile}
					modelsCatalog={modelsCatalog ?? undefined}
					showSourceBadge={true}
					renaming={renamingSessionId === session.id}
					renameValue={renameTitleValue}
					renameSaving={renameSaving}
					rowState={{
						isFork: item.isFork,
						isLastVisibleChild: item.isLastVisibleChild,
						style: getSessionRowStyle(item),
						titleText: item.titleText || undefined,
						ariaLabel: item.ariaLabel,
					}}
					draggable={!isMobile}
					onNavigate={(target) => scheduleSessionRowNavigate(target.id)}
					onDoubleClick={handleSessionRowDoubleClick}
					onInsert={insertPathReference}
					onRename={startRenameSession}
					onRenameValueChange={(value) => { renameTitleValue = value; }}
					onSubmitRename={(target) => void submitRenameSession(target)}
					onCancelRename={cancelRenameSession}
					onDragStart={(event, target, title) => handleSessionDragStart(event, target, title)}
					onDragEnd={handleResourceDragEnd}
				/>
			{/each}
			{#if shouldShowLoadMoreSessions()}
				<button type="button" class="mt-1 flex w-full items-center justify-center gap-2 rounded-[6px] px-2 py-1.5 text-[12px] text-text-tertiary transition-colors hover:bg-bg-hover hover:text-text-secondary disabled:opacity-60" disabled={loadingMoreSessions} onclick={() => currentSpaceId && void loadMoreSessionsForSpace(currentSpaceId)}>
					{#if loadingMoreSessions}<Loader2 class="h-3 w-3 animate-spin" /> {m.common_loading({}, { locale })}{:else}{m.sidebar_show_more({}, { locale })}{/if}
				</button>
			{/if}
		</div>
	{/if}
{/snippet}

{#snippet checkpointsFlyoutList()}
	{#if loadingCheckpoints && checkpoints.length === 0}
		{@render sidebarEmptyState(m.sidebar_loading_saves({}, { locale }), true)}
	{:else if checkpoints.length === 0}
		{@render sidebarEmptyState(m.sidebar_no_saves({}, { locale }))}
	{:else}
		<div class="space-y-[2px]">
			{#each checkpoints.slice(0, sidebarFlyoutPreviewLimit) as checkpoint (checkpoint.id)}
				<SidebarCheckpointRow
					{checkpoint}
					href={buildSpaceCheckpointRoute(currentSpaceId!, checkpoint.id)}
					active={activeCheckpointId === checkpoint.id}
					onNavigate={(target) => void handleNavigateToCheckpoint(target.id)}
				/>
			{/each}
		</div>
	{/if}
{/snippet}

{#snippet cronjobsFlyoutList()}
	<div class="mb-1 flex justify-end">
		<button type="button" class="inline-flex items-center gap-1 rounded-[5px] px-2 py-1 text-[11px] font-medium text-text-tertiary transition-colors hover:bg-bg-hover hover:text-text-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/35" onclick={handleNavigateToNewCronjob}>
			<Plus class="h-3 w-3" /> {m.sidebar_new_scheduled({}, { locale })}
		</button>
	</div>
	{#if loadingCronjobs && cronjobs.length === 0}
		{@render sidebarEmptyState(m.sidebar_loading_scheduled({}, { locale }), true)}
	{:else if cronjobs.length === 0}
		{@render sidebarEmptyState(m.sidebar_no_scheduled({}, { locale }))}
	{:else}
		<div class="space-y-[2px]">
			{#each cronjobs.slice(0, sidebarFlyoutPreviewLimit) as job (job.id)}
				{@const isActive = activeCronjobId === job.id}
				<a href={buildSpaceCronjobRoute(currentSpaceId!, job.id)} class="sidebar-flyout-item flex items-center gap-2 rounded-[var(--sidebar-item-radius)] px-1.5 py-1.5 text-[13px] {isActive ? 'bg-[var(--sidebar-item-active-bg)] font-medium text-[var(--sidebar-item-active-fg)]' : 'text-text-tertiary hover:bg-[var(--sidebar-item-hover-bg)] hover:text-text-secondary'}" onclick={(e) => { e.preventDefault(); handleNavigateToCronjob(job.id); }}>
					<div class="min-w-0 flex-1"><div class="truncate leading-tight">{job.title}</div></div>
					<span class="h-1.5 w-1.5 shrink-0 rounded-full {job.enabled ? 'bg-status-running' : 'bg-text-placeholder'}"></span>
				</a>
			{/each}
		</div>
	{/if}
{/snippet}

{#snippet appsFlyoutList()}
	{#if loadingApps && apps.length === 0}
		{@render sidebarEmptyState(m.sidebar_loading_apps({}, { locale }), true)}
	{:else if apps.length === 0}
		{@render sidebarEmptyState(m.sidebar_no_apps({}, { locale }))}
	{:else}
		<div class="space-y-[2px]">
			{#each apps.slice(0, sidebarFlyoutPreviewLimit) as app (app.id)}
				{@const manageHref = currentSpaceId ? buildSpaceAppRoute(currentSpaceId, app.id) : "#"}
				{@const isActive = activeApp?.id === app.id}
				<a href={manageHref} draggable={!isMobile} use:pointerDragSource={{ enabled: isMobile, getPayload: () => appPointerDragPayload(app) }} ondragstart={(event) => handleAppDragStart(event, app)} class="sidebar-flyout-item flex items-center gap-2 rounded-[var(--sidebar-item-radius)] px-1.5 py-1.5 text-[13px] {isActive ? 'bg-[var(--sidebar-item-active-bg)] font-medium text-[var(--sidebar-item-active-fg)]' : 'text-text-tertiary hover:bg-[var(--sidebar-item-hover-bg)] hover:text-text-secondary'}" onclick={(e) => { e.preventDefault(); void handleNavigateToApp(app.id); }}>
					<div class="min-w-0 flex-1"><div class="truncate font-mono leading-tight">{app.slug}</div></div>
				</a>
			{/each}
		</div>
	{/if}
{/snippet}

{#snippet tasksFlyoutList()}
	{#if loadingTasks && tasks.length === 0}
		{@render sidebarEmptyState(m.sidebar_loading_tasks({}, { locale }), true)}
	{:else if tasks.length === 0}
		{@render sidebarEmptyState(m.sidebar_no_tasks({}, { locale }))}
	{:else}
		<div class="space-y-[2px]">
			{#each tasks.slice(0, sidebarFlyoutPreviewLimit) as run (run.id)}
				{@const isActive = activeTaskId === run.id}
				{@const badge = getTaskRunBadge(run.status)}
				<a href={buildSpaceTaskRoute(currentSpaceId!, run.id)} draggable={!isMobile} class="sidebar-flyout-item flex items-center gap-2 rounded-[var(--sidebar-item-radius)] px-1.5 py-1.5 text-[13px] {isActive ? 'bg-[var(--sidebar-item-active-bg)] font-medium text-[var(--sidebar-item-active-fg)]' : 'text-text-tertiary hover:bg-[var(--sidebar-item-hover-bg)] hover:text-text-secondary'}" onclick={(e) => { e.preventDefault(); handleNavigateToTask(run.id); }} ondragstart={(event) => handleTaskDragStart(event, run)}>
					<div class="min-w-0 flex-1"><div class="truncate text-[12px] capitalize leading-tight {badge.color}">{run.status}</div><div class="mt-0.5 text-[10px] text-text-placeholder">{formatTaskRunTime(run)}</div></div>
					<span class="h-1.5 w-1.5 shrink-0 rounded-full {badge.dot}"></span>
				</a>
			{/each}
		</div>
	{/if}
{/snippet}

{#if collapsed && !isMobile}
  <aside class="h-screen w-[52px] shrink-0 overflow-visible bg-[var(--sidebar-bg)]">
    <div class="flex h-full flex-col items-center overflow-visible border-r border-border-subtle/70 px-2 py-2">
      <a
        href="/"
        class="flex h-8 w-8 shrink-0 items-center justify-center rounded-[7px] bg-brand text-[11px] font-bold text-brand-contrast-fg transition-colors duration-100 hover:bg-brand-hover"
        aria-label={m.sidebar_cohub_home({}, { locale })}
        title={m.sidebar_home({}, { locale })}
      >
        C
      </a>
      <button
        type="button"
        class="mt-1 flex h-8 w-8 items-center justify-center rounded-[6px] text-text-tertiary transition-colors duration-100 hover:bg-bg-hover hover:text-text-secondary"
        onclick={() => uiState.setLeftSidebarCollapsed(false)}
        aria-label={m.sidebar_expand({}, { locale })}
        title={m.sidebar_expand_shortcut({}, { locale })}
      >
        <PanelLeftOpen class="h-4 w-4" />
      </button>
      <button
        type="button"
        class="mt-1 flex h-8 w-8 items-center justify-center rounded-[6px] text-text-tertiary transition-colors duration-100 hover:bg-bg-hover hover:text-text-secondary"
        onclick={openCommandPalette}
        aria-label={m.sidebar_search_everywhere({}, { locale })}
        title={m.sidebar_search_everywhere_shortcut({}, { locale })}
      >
        <Search class="h-4 w-4" />
      </button>
      <a
        href={buildSessionsRoute()}
        class="mt-1 flex h-8 w-8 items-center justify-center rounded-[6px] transition-colors duration-100 {isSessionsRoute ? 'bg-bg-active text-text-primary' : 'text-text-tertiary hover:bg-bg-hover hover:text-text-secondary'}"
        aria-label={m.sidebar_chats({}, { locale })}
        title={m.sidebar_chats({}, { locale })}
        onclick={(event) => {
          event.preventDefault();
          void handleNavigate(buildSessionsRoute());
        }}
      >
        <MessageSquare class="h-4 w-4" />
      </a>

      <div class="mt-2 h-px w-6 bg-border-subtle/70"></div>

      {#if mode === "space"}
        <div class="mt-2 flex w-full flex-col items-center gap-1">
          <button
            type="button"
            class="flex h-8 w-8 items-center justify-center overflow-hidden rounded-[6px] text-text-tertiary transition-colors duration-100 hover:bg-bg-hover hover:text-text-secondary"
            onclick={openSpacePalette}
            aria-label={currentSpace ? m.sidebar_switch_space({ space: currentSpace.name || currentSpace.title || currentSpace.id }, { locale }) : m.sidebar_select_space({}, { locale })}
            title={currentSpace ? currentSpace.name || currentSpace.title || currentSpace.id : m.sidebar_select_space({}, { locale })}
          >
            {#if currentSpace}
              <SpaceAvatar name={currentSpace.name || currentSpace.title || currentSpace.id} profile={currentSpace.publicProfile} size="sm" />
            {:else}
              <FolderKanban class="h-4 w-4" />
            {/if}
          </button>
          {#if currentSpace}
            <button
              type="button"
              class="new-chat-collapsed relative flex h-8 w-8 items-center justify-center rounded-[6px] text-brand transition-colors duration-100 hover:bg-brand-muted hover:text-brand"
              onclick={() => { void handleCreateNewSession(); }}
              disabled={creatingSession}
              aria-label={m.sidebar_new_chat({}, { locale })}
              title={m.sidebar_new_chat_shortcut({}, { locale })}
            >
              {#if creatingSession}
                <Loader2 class="h-4 w-4 animate-spin" />
              {:else}
                <Plus class="h-4 w-4" />
              {/if}
            </button>
            <button
              type="button"
              class="flex h-8 w-8 items-center justify-center rounded-[6px] transition-colors duration-100 {currentPath === buildSpaceSettingsRoute(currentSpaceId!) ? 'bg-bg-active text-text-primary' : 'text-text-tertiary hover:bg-bg-hover hover:text-text-secondary'}"
              onclick={() => { void handleNavigate(buildSpaceSettingsRoute(currentSpaceId!)); }}
              aria-label={m.sidebar_space_settings({}, { locale })}
              title={m.sidebar_space_settings({}, { locale })}
            >
              <Settings class="h-4 w-4" />
            </button>
            <button
              type="button"
              class="flex h-8 w-8 items-center justify-center rounded-[6px] transition-colors duration-100 {currentPath === buildSpaceActivityRoute(currentSpaceId!) ? 'bg-bg-active text-text-primary' : 'text-text-tertiary hover:bg-bg-hover hover:text-text-secondary'}"
              onclick={() => { void handleNavigate(buildSpaceActivityRoute(currentSpaceId!)); }}
              aria-label={m.nav_activity({}, { locale })}
              title={m.nav_activity({}, { locale })}
            >
              <Activity class="h-4 w-4" />
            </button>
            <button
              type="button"
              class="flex h-8 w-8 items-center justify-center rounded-[6px] text-text-tertiary transition-colors duration-100 hover:bg-bg-hover hover:text-text-secondary"
              onclick={handleNavigateToNewCheckpoint}
              aria-label={m.sidebar_new_save({}, { locale })}
              title={m.sidebar_new_save({}, { locale })}
            >
              <Save class="h-4 w-4" />
            </button>
          {/if}
        </div>

        {#if currentSpace}
          <div class="mt-2 h-px w-6 bg-border-subtle/70"></div>
          <nav class="mt-2 flex w-full flex-1 flex-col items-center gap-1 overflow-visible">
            <SidebarFlyout label={m.sidebar_labels({}, { locale })} active={Boolean(activeLabelResource)} onTriggerClick={() => uiState.setLeftSidebarCollapsed(false)}>
              {#snippet trigger()}
                <Tags class="h-4 w-4" />
              {/snippet}
              {#if canManageLabels}
                {#snippet headerAction()}
                  <button
                    type="button"
                    class="inline-flex h-6 w-6 items-center justify-center rounded-[5px] text-text-placeholder transition-colors hover:bg-bg-hover hover:text-text-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/35"
                    title={m.sidebar_new_label({}, { locale })}
                    aria-label={m.sidebar_new_label({}, { locale })}
                    onclick={(event) => { event.stopPropagation(); showNewLabelPopover = true; }}
                  >
                    <Plus class="h-3.5 w-3.5" />
                  </button>
                {/snippet}
              {/if}
              {@render labelsSection(false)}
            </SidebarFlyout>
            <SidebarFlyout label={m.sidebar_chats({}, { locale })} active={Boolean(activeSession)} onTriggerClick={() => uiState.setLeftSidebarCollapsed(false)}>
              {#snippet trigger()}
                <MessageSquare class="h-4 w-4" />
              {/snippet}
              {@render chatsSection(false)}
            </SidebarFlyout>
            <SidebarFlyout label={m.sidebar_apps({}, { locale })} active={Boolean(activeApp)} onTriggerClick={() => uiState.setLeftSidebarCollapsed(false)}>
              {#snippet trigger()}
                <Rocket class="h-4 w-4" />
              {/snippet}
              {@render appsFlyoutList()}
            </SidebarFlyout>
            <SidebarFlyout label={m.sidebar_saves({}, { locale })} active={Boolean(activeCheckpointId)} onTriggerClick={() => uiState.setLeftSidebarCollapsed(false)}>
              {#snippet trigger()}
                <History class="h-4 w-4" />
              {/snippet}
              {@render checkpointsFlyoutList()}
            </SidebarFlyout>
            <SidebarFlyout label={m.sidebar_scheduled({}, { locale })} active={Boolean(activeCronjobId)} onTriggerClick={() => uiState.setLeftSidebarCollapsed(false)}>
              {#snippet trigger()}
                <Clock class="h-4 w-4" />
              {/snippet}
              {@render cronjobsFlyoutList()}
            </SidebarFlyout>
            <SidebarFlyout label={m.sidebar_tasks({}, { locale })} active={Boolean(activeTaskId)} onTriggerClick={() => uiState.setLeftSidebarCollapsed(false)}>
              {#snippet trigger()}
                <Activity class="h-4 w-4" />
              {/snippet}
              {@render tasksFlyoutList()}
            </SidebarFlyout>
          </nav>
        {:else}
          <div class="flex-1"></div>
        {/if}
      {:else}
        <nav class="mt-3 flex w-full flex-1 flex-col items-center gap-1 overflow-y-auto">
          <button type="button" class="rail-button text-text-tertiary" onclick={returnFromSettings} aria-label={m.nav_back({}, { locale })} title={m.nav_back({}, { locale })}>
            <ArrowLeft class="h-4 w-4" />
          </button>
          {#each settingsTabs as tab (tab.id)}
            {@const isActive = activeSettingsTab === tab.id}
            <a
              href={tab.href}
              class="rail-button {isActive ? 'bg-bg-active text-text-primary' : 'text-text-tertiary'}"
              title={tab.label}
              aria-label={tab.label}
              onclick={(e) => { e.preventDefault(); void handleNavigate(tab.href, { keepSettingsReturn: true, replaceState: true }); }}
            >
              <tab.icon class="h-4 w-4" />
            </a>
          {/each}
        </nav>
      {/if}

      <div class="relative mt-auto w-full pt-2" bind:this={userMenuAnchorEl}>
        {#if showUserMenu}
          <div
            data-user-menu
            class="w-56 overflow-hidden rounded-md border border-border-subtle bg-bg-primary py-1 shadow-lg"
            use:floatNear={{
              getAnchor: () => userMenuAnchorEl,
              placement: "top-start",
              gap: 4,
              width: 224,
              zIndex: 90,
            }}
          >
            {#if billingConfigured !== false}
              <div class="border-b border-border-subtle">
                <a href={currentSubscriptionName ? "/settings/billing" : "/pricing"} class="rail-menu-item" title={currentSubscriptionName ? m.sidebar_open_billing({}, { locale }) : m.sidebar_view_plans({}, { locale })} onclick={(e) => { e.preventDefault(); if (currentSubscriptionName) openBillingSettings(); else { showUserMenu = false; handleNavigate('/pricing'); } }}>
                  <CreditCard class="h-3.5 w-3.5" />
                  <span>{currentSubscriptionName ?? m.sidebar_free_plan({}, { locale })}</span>
                  {#if showBillingBalanceEntry}
                    <span class="ml-auto font-mono text-[11px] {billingCredit && billingCredit.netUsd < 0 ? 'text-error-soft' : 'text-text-secondary'}">
                      {#if billingCreditLoading || (!billingCredit && !billingCreditError)}
                        <Loader2 class="h-3.5 w-3.5 animate-spin text-text-tertiary" />
                      {:else if billingCredit}
                        {formatUsdAmount(billingCredit.netUsd)}
                      {:else}
                        <span class="text-text-placeholder">—</span>
                      {/if}
                    </span>
                  {:else if !currentSubscriptionName}
                    <span class="ml-auto text-[10px] font-medium text-brand">{m.sidebar_upgrade({}, { locale })}</span>
                  {/if}
                </a>
                {#if showBillingBalanceEntry && billingCreditError}
                  <div class="px-2.5 pb-1 text-[11px] text-text-placeholder">{billingCreditError}</div>
                {/if}
              </div>
            {/if}
            <a href="/settings/referrals" class="rail-menu-item" onclick={(e) => { e.preventDefault(); openReferralsSettings(); }}><Gift class="h-3.5 w-3.5" /><span>{m.nav_referrals({}, { locale })}</span></a>
            {#if mode === "space"}
              <a href="/settings" class="rail-menu-item" onclick={(e) => { e.preventDefault(); openSettings(); }}><Settings class="h-3.5 w-3.5" /><span>{m.nav_settings({}, { locale })}</span></a>
            {:else}
              <a href={settingsReturnTo} class="rail-menu-item" onclick={(e) => { e.preventDefault(); showUserMenu = false; returnFromSettings(); }}><FolderKanban class="h-3.5 w-3.5" /><span>{m.nav_spaces({}, { locale })}</span></a>
            {/if}
            <a href="/trending" class="rail-menu-item" onclick={(e) => { e.preventDefault(); showUserMenu = false; handleNavigate('/trending'); }}><BarChart3 class="h-3.5 w-3.5" /><span>{m.sidebar_trending({}, { locale })}</span></a>
            <button type="button" class="rail-menu-item w-full" onclick={openHelpPanel}><Keyboard class="h-3.5 w-3.5" /><span>{m.sidebar_help({}, { locale })}</span></button>
            <button type="button" class="rail-menu-item w-full" onclick={saveDebugLog}><Download class="h-3.5 w-3.5" /><span>{m.sidebar_save_debug_log({}, { locale })}</span></button>
            <button type="button" class="rail-menu-item w-full hover:text-error-soft" onclick={() => { showUserMenu = false; void handleLogout(); }}><LogOut class="h-3.5 w-3.5" /><span>{m.sidebar_sign_out({}, { locale })}</span></button>
          </div>
        {/if}
        <button
          type="button"
          data-user-menu
          class="flex h-8 w-8 items-center justify-center overflow-hidden rounded-full bg-bg-hover-strong transition-colors duration-100 hover:bg-bg-hover"
          onclick={() => { showUserMenu = !showUserMenu; }}
          aria-label={userDisplayName}
          title={userDisplayName}
        >
          <UserAvatar name={userDisplayName} avatarUrl={authStore.profile?.avatarUrl} size="md" class="h-full w-full border-0" />
        </button>
      </div>
    </div>
  </aside>
{:else}
<aside
  bind:this={sidebarRootEl}
  class="{isMobile ? 'h-full w-full' : 'h-screen w-full'} flex flex-col bg-[var(--sidebar-bg)]"
>
  <!-- Brand Header -->
  <div class="flex h-[48px] shrink-0 items-center justify-between gap-2 border-b border-border-subtle px-3">
    <a href="/" class="flex min-w-0 items-center gap-2 group" aria-label="Cohub">
      <div class="w-7 h-7 bg-brand rounded-[6px] flex items-center justify-center font-bold text-[11px] text-brand-contrast-fg group-hover:bg-brand-hover transition-colors shrink-0">
        C
      </div>
      <span class="font-semibold text-[13px] text-text-primary tracking-tight truncate">Cohub</span>
    </a>
    <div class="flex shrink-0 items-center gap-1">
      <button
        type="button"
        class="group/search flex h-7 shrink-0 items-center gap-1.5 rounded-[6px] bg-bg-surface px-2 text-[11px] text-text-tertiary transition-colors duration-100 hover:bg-bg-hover hover:text-text-secondary"
        onclick={openCommandPalette}
        title={m.sidebar_search_everywhere_shortcut({}, { locale })}
        aria-label={m.sidebar_search_everywhere({}, { locale })}
      >
        <Search class="h-3.5 w-3.5 text-text-placeholder transition-colors group-hover/search:text-brand" />
        <span class="hidden font-mono tracking-[0.02em] sm:inline">⌘K</span>
      </button>
      <a
        href={buildSessionsRoute()}
        class="flex h-7 w-7 shrink-0 items-center justify-center rounded-[5px] transition-colors duration-100 {isSessionsRoute ? 'bg-bg-active text-text-primary' : 'text-text-tertiary hover:bg-bg-hover hover:text-text-secondary'}"
        title={m.sidebar_chats({}, { locale })}
        aria-label={m.sidebar_chats({}, { locale })}
        onclick={(event) => {
          event.preventDefault();
          void handleNavigate(buildSessionsRoute());
        }}
      >
        <MessageSquare class="h-3.5 w-3.5" />
      </a>
      {#if !isMobile}
        <button
          type="button"
          class="flex h-7 w-7 shrink-0 items-center justify-center rounded-[5px] text-text-tertiary transition-colors duration-100 hover:bg-bg-hover hover:text-text-secondary"
          onclick={() => uiState.setLeftSidebarCollapsed(true)}
          title={m.sidebar_collapse_shortcut({}, { locale })}
          aria-label={m.sidebar_collapse({}, { locale })}
        >
          <PanelLeftClose class="h-4 w-4" />
        </button>
      {/if}
    </div>
  </div>

  {#if mode === "space"}
    <!-- Space Switcher -->
    <div class="px-1.5 py-1 shrink-0 border-b border-border-subtle">
      <button
        type="button"
        class="w-full flex items-center gap-1.5 px-1.5 py-1.5 rounded-[5px] hover:bg-bg-hover transition-colors duration-100 cursor-pointer group"
        onclick={openSpacePalette}
      >
        {#if currentSpace}
          <SpaceAvatar name={currentSpace.name || currentSpace.title || currentSpace.id} profile={currentSpace.publicProfile} size="sm" />
          <span class="flex-1 text-[13px] font-medium text-text-primary truncate text-left">{currentSpace.name || currentSpace.title || currentSpace.id.slice(0, 12)}</span>
          {@render syncSpinner(refreshingSpaces)}
        {:else}
          <span class="flex-1 text-[13px] text-text-placeholder truncate text-left">{m.sidebar_select_space({}, { locale })}</span>
        {/if}
        <ChevronDown class="w-3.5 h-3.5 text-text-tertiary shrink-0 transition-transform duration-150 group-hover:text-text-secondary" />
      </button>
    </div>

    <!-- Action Buttons -->
    {#if currentSpace}
      <div class="px-1.5 py-1.5 shrink-0 space-y-[2px]">
        <button
          type="button"
          class="flex w-full items-center gap-2 rounded-[var(--sidebar-primary-action-radius)] border border-[color:var(--sidebar-primary-action-border)] bg-[var(--sidebar-primary-action-bg)] px-1.5 py-1.5 text-[var(--sidebar-primary-action-fg)] transition-colors duration-100 hover:bg-[var(--sidebar-primary-action-bg-hover)] disabled:cursor-not-allowed disabled:opacity-50"
          onclick={() => { void handleCreateNewSession(); }}
          disabled={creatingSession}
          title={m.sidebar_new_chat_shortcut({}, { locale })}
          aria-label={m.sidebar_new_chat_shortcut({}, { locale })}
        >
          {#if creatingSession}
            <Loader2 class="w-3.5 h-3.5 animate-spin shrink-0" />
            <span class="text-[12px] font-medium">{m.sidebar_creating({}, { locale })}</span>
          {:else}
            <Plus class="w-3.5 h-3.5 shrink-0" />
            <span class="text-[12px] font-medium">{m.sidebar_new_chat({}, { locale })}</span>
            <span class="new-chat-shortcut ml-auto hidden rounded-[4px] border border-brand/20 bg-bg-primary/70 px-1.5 py-px font-mono text-[10px] text-brand/80 xl:inline">⌘O</span>
          {/if}
        </button>
        <button
          type="button"
          class="flex items-center gap-2 w-full px-1.5 py-1.5 rounded-[5px] text-text-tertiary hover:text-text-primary hover:bg-bg-hover transition-colors duration-100 disabled:opacity-50"
          onclick={() => { void handleNavigate(buildSpaceSettingsRoute(currentSpaceId!)); }}
          title={m.sidebar_space_settings({}, { locale })}
        >
          <Settings class="w-3.5 h-3.5 shrink-0" />
          <span class="text-[12px] font-medium">{m.nav_settings({}, { locale })}</span>
        </button>
        <button
          type="button"
          class="flex items-center gap-2 w-full px-1.5 py-1.5 rounded-[5px] text-text-tertiary hover:text-text-primary hover:bg-bg-hover transition-colors duration-100 disabled:opacity-50"
          onclick={() => { void handleNavigate(buildSpaceActivityRoute(currentSpaceId!)); }}
          title={m.nav_activity({}, { locale })}
        >
          <Activity class="w-3.5 h-3.5 shrink-0" />
          <span class="text-[12px] font-medium">{m.nav_activity({}, { locale })}</span>
        </button>
        <button
          type="button"
          class="flex items-center gap-2 w-full px-1.5 py-1.5 rounded-[5px] text-text-tertiary hover:text-text-primary hover:bg-bg-hover transition-colors duration-100 disabled:opacity-50"
          onclick={handleNavigateToNewCheckpoint}
          title={m.sidebar_new_save({}, { locale })}
        >
          <Save class="w-3.5 h-3.5 shrink-0" />
          <span class="text-[12px] font-medium">{m.sidebar_new_save({}, { locale })}</span>
        </button>
        {#if createSessionError}
          <div class="px-2 py-1 text-[11px] text-error-soft">{createSessionError}</div>
        {/if}
      </div>
    {/if}

    <!-- Sessions / Checkpoints -->
    {#if currentSpace}
      <div class="flex-1 overflow-y-auto px-1.5 pb-2 pt-1 min-h-0">
        {#if loadingSessions && sessions.length === 0 && loadingCheckpoints && checkpoints.length === 0}
          {@render sidebarEmptyState(m.common_loading({}, { locale }), true)}
        {:else}
          {@render labelsSection()}
          {@render chatsSection()}

          <!-- Apps -->
          <div class="mt-3">
            <button
              type="button"
              class="flex items-center gap-2 px-1.5 py-1.5 w-full text-left hover:bg-bg-hover transition-colors duration-100 rounded-[6px]"
              onclick={() => { worksCollapsed = !worksCollapsed; }}
              title={worksCollapsed ? m.sidebar_expand_apps({}, { locale }) : m.sidebar_collapse_apps({}, { locale })}
            >
              <ChevronDown class="w-3 h-3 text-text-tertiary shrink-0 transition-transform duration-150 {worksCollapsed ? 'rotate-180' : ''}" />
              <Rocket class="w-3.5 h-3.5 shrink-0 text-text-placeholder" />
              <span class="text-[11px] text-text-placeholder select-none">{m.sidebar_apps({}, { locale })}</span>
              {@render syncSpinner(refreshingApps, "ml-auto")}
            </button>

            {#if !worksCollapsed}
              {#if loadingApps && apps.length === 0}
                {@render sidebarEmptyState(m.sidebar_loading_apps({}, { locale }), true)}
              {:else if apps.length === 0}
                {@render sidebarEmptyState(m.sidebar_no_apps({}, { locale }))}
              {:else}
                <div class="space-y-[2px] mt-1">
                  {#each apps as app (app.id)}
                    {@const manageHref = currentSpaceId ? buildSpaceAppRoute(currentSpaceId, app.id) : "#"}
                    {@const isActive = activeApp?.id === app.id}
                    <a
                      href={manageHref}
                      draggable={!isMobile}
                      use:pointerDragSource={{ enabled: isMobile, getPayload: () => appPointerDragPayload(app) }}
                      ondragstart={(event) => handleAppDragStart(event, app)}
                      class="flex items-center gap-2 rounded-[var(--sidebar-item-radius)] px-1.5 py-1.5 text-[13px] transition-colors duration-100 {isActive ? 'bg-[var(--sidebar-item-active-bg)] font-medium text-[var(--sidebar-item-active-fg)]' : 'text-text-tertiary hover:bg-[var(--sidebar-item-hover-bg)] hover:text-text-secondary'}"
                      onclick={(e) => { e.preventDefault(); void handleNavigateToApp(app.id); }}
                    >
                      <div class="min-w-0 flex-1">
                        <div class="truncate font-mono leading-tight">{app.slug}</div>
                      </div>
                    </a>
                  {/each}
                </div>
              {/if}
            {:else if activeApp}
              {@const manageHref = currentSpaceId ? buildSpaceAppRoute(currentSpaceId, activeApp.id) : "#"}
              <a
                href={manageHref}
                class="mt-1 flex items-center gap-2 rounded-[var(--sidebar-item-radius)] bg-[var(--sidebar-item-active-bg)] px-1.5 py-1.5 text-[13px] font-medium text-[var(--sidebar-item-active-fg)] transition-colors duration-100"
                onclick={(e) => { e.preventDefault(); void handleNavigateToApp(activeApp.id); }}
              >
                <div class="min-w-0 flex-1">
                  <div class="truncate font-mono leading-tight">{activeApp.slug}</div>
                </div>
              </a>
            {/if}
          </div>

          <div class="mt-3">
            <button
              type="button"
              class="flex items-center gap-2 px-1.5 py-1.5 w-full text-left hover:bg-bg-hover transition-colors duration-100 rounded-[6px]"
              onclick={() => { checkpointsCollapsed = !checkpointsCollapsed; }}
              title={checkpointsCollapsed ? m.sidebar_expand_saves({}, { locale }) : m.sidebar_collapse_saves({}, { locale })}
            >
              <ChevronDown class="w-3 h-3 text-text-tertiary shrink-0 transition-transform duration-150 {checkpointsCollapsed ? 'rotate-180' : ''}" />
              <History class="w-3.5 h-3.5 shrink-0 text-text-placeholder" />
              <span class="text-[11px] text-text-placeholder select-none">{m.sidebar_saves({}, { locale })}</span>
              {@render syncSpinner(refreshingCheckpoints, "ml-auto")}
            </button>

            {#if !checkpointsCollapsed}
              {#if loadingCheckpoints && checkpoints.length === 0}
                {@render sidebarEmptyState(m.sidebar_loading_saves({}, { locale }), true)}
              {:else if checkpoints.length === 0}
                {@render sidebarEmptyState(m.sidebar_no_saves({}, { locale }))}
              {:else}
                <div class="space-y-[2px] mt-1">
                  {#each checkpoints as checkpoint (checkpoint.id)}
                    <SidebarCheckpointRow
                      {checkpoint}
                      href={buildSpaceCheckpointRoute(currentSpaceId!, checkpoint.id)}
                      active={activeCheckpointId === checkpoint.id}
                      onNavigate={(target) => void handleNavigateToCheckpoint(target.id)}
                    />
                  {/each}
                  {#if checkpointsPageInfo.hasMore && checkpointsPageInfo.nextCursor}
                    <button
                      type="button"
                      class="mt-1 flex w-full items-center justify-center gap-1.5 rounded-[6px] px-1.5 py-1.5 text-[11px] text-text-placeholder transition-colors hover:bg-bg-hover hover:text-text-secondary disabled:cursor-not-allowed disabled:opacity-60"
                      disabled={loadingMoreCheckpoints}
                      onclick={() => currentSpaceId && void loadMoreCheckpointsForSpace(currentSpaceId)}
                    >
                      {#if loadingMoreCheckpoints}
                        <Loader2 class="h-3 w-3 animate-spin" />
                        {m.common_loading({}, { locale })}
                      {:else}
                        {m.sidebar_show_more({}, { locale })}
                      {/if}
                    </button>
                  {/if}
                </div>
              {/if}
            {:else if activeCheckpoint}
              <div class="mt-1">
                <SidebarCheckpointRow
                  checkpoint={activeCheckpoint}
                  href={buildSpaceCheckpointRoute(currentSpaceId!, activeCheckpoint.id)}
                  active={true}
                  onNavigate={(target) => void handleNavigateToCheckpoint(target.id)}
                />
              </div>
            {/if}
          </div>


          <!-- Scheduled Jobs -->
          <div class="mt-3">
            <div
              class="flex items-center gap-2 px-1.5 py-1.5 w-full text-left hover:bg-bg-hover transition-colors duration-100 rounded-[6px] cursor-pointer"
              onclick={() => { cronjobsCollapsed = !cronjobsCollapsed; }}
              title={cronjobsCollapsed ? m.sidebar_expand_scheduled({}, { locale }) : m.sidebar_collapse_scheduled({}, { locale })}
              role="button"
              tabindex="0"
              onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); cronjobsCollapsed = !cronjobsCollapsed; } }}
            >
              <ChevronDown class="w-3 h-3 text-text-tertiary shrink-0 transition-transform duration-150 {cronjobsCollapsed ? 'rotate-180' : ''}" />
              <Clock class="w-3.5 h-3.5 shrink-0 text-text-placeholder" />
              <span class="text-[11px] text-text-placeholder select-none">{m.sidebar_scheduled({}, { locale })}</span>
              {@render syncSpinner(refreshingCronjobs, "ml-auto")}
              <span
                class="{refreshingCronjobs ? '' : 'ml-auto'} p-0.5 rounded hover:bg-bg-hover text-text-placeholder hover:text-text-secondary transition-colors cursor-pointer"
                onclick={(e) => { e.stopPropagation(); handleNavigateToNewCronjob(); }}
                onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.stopPropagation(); e.preventDefault(); handleNavigateToNewCronjob(); } }}
                title={m.sidebar_new_scheduled({}, { locale })}
                role="button"
                tabindex="0"
              >
                <Plus class="w-3 h-3" />
              </span>
            </div>

            {#if !cronjobsCollapsed}
              {#if loadingCronjobs && cronjobs.length === 0}
                {@render sidebarEmptyState(m.sidebar_loading_scheduled({}, { locale }), true)}
              {:else if cronjobs.length === 0}
                {@render sidebarEmptyState(m.sidebar_no_scheduled({}, { locale }))}
              {:else}
                <div class="space-y-[2px] mt-1">
                  {#each cronjobs as job (job.id)}
                    {@const isActive = activeCronjobId === job.id}
                    <a
                      href={buildSpaceCronjobRoute(currentSpaceId!, job.id)}
                      class="flex items-center gap-2 px-1.5 py-1.5 rounded-[var(--sidebar-item-radius)] text-[13px] transition-colors duration-100 {isActive ? 'text-[var(--sidebar-item-active-fg)] bg-[var(--sidebar-item-active-bg)] font-medium' : 'text-text-tertiary hover:text-text-secondary hover:bg-[var(--sidebar-item-hover-bg)]'}"
                      onclick={(e) => { e.preventDefault(); handleNavigateToCronjob(job.id); }}
                    >
                      <div class="min-w-0 flex-1">
                        <div class="truncate leading-tight">{job.title}</div>
                      </div>
                      <span class="w-[6px] h-[6px] rounded-full shrink-0 {job.enabled ? 'bg-status-running' : 'bg-text-placeholder'}"></span>
                    </a>
                  {/each}
                </div>
              {/if}
            {:else if activeCronjob}
              <a
                href={buildSpaceCronjobRoute(currentSpaceId!, activeCronjob.id)}
                class="flex items-center gap-2 px-1.5 py-1.5 mt-1 rounded-[var(--sidebar-item-radius)] text-[13px] transition-colors duration-100 text-[var(--sidebar-item-active-fg)] bg-[var(--sidebar-item-active-bg)] font-medium"
                onclick={(e) => { e.preventDefault(); handleNavigateToCronjob(activeCronjob.id); }}
              >
                <div class="min-w-0 flex-1">
                  <div class="truncate leading-tight">{activeCronjob.title}</div>
                </div>
                <span class="w-[6px] h-[6px] rounded-full shrink-0 {activeCronjob.enabled ? 'bg-status-running' : 'bg-text-placeholder'}"></span>
              </a>
            {/if}
          </div>

          <!-- Tasks -->
          <div class="mt-3">
            <button
              type="button"
              class="flex items-center gap-2 px-1.5 py-1.5 w-full text-left hover:bg-bg-hover transition-colors duration-100 rounded-[6px]"
              onclick={() => {
                const nextCollapsed = !tasksCollapsed;
                tasksCollapsed = nextCollapsed;
                if (!nextCollapsed && currentSpaceId) {
                  void restoreTasksForSpace(currentSpaceId);
                  void loadTasksForSpace(currentSpaceId);
                }
              }}
              title={tasksCollapsed ? m.sidebar_expand_tasks({}, { locale }) : m.sidebar_collapse_tasks({}, { locale })}
            >
              <ChevronDown class="w-3 h-3 text-text-tertiary shrink-0 transition-transform duration-150 {tasksCollapsed ? 'rotate-180' : ''}" />
              <Activity class="w-3.5 h-3.5 shrink-0 text-text-placeholder" />
              <span class="text-[11px] text-text-placeholder select-none">{m.sidebar_tasks({}, { locale })}</span>
              {@render syncSpinner(refreshingTasks, "ml-auto")}
            </button>

            {#if !tasksCollapsed}
              {#if loadingTasks && tasks.length === 0}
                {@render sidebarEmptyState(m.sidebar_loading_tasks({}, { locale }), true)}
              {:else if tasks.length === 0}
                {@render sidebarEmptyState(m.sidebar_no_tasks({}, { locale }))}
              {:else}
                <div class="space-y-[2px] mt-1">
                  {#each tasks as run (run.id)}
                    {@const isActive = activeTaskId === run.id}
                    {@const badge = getTaskRunBadge(run.status)}
                    <a
                      href={buildSpaceTaskRoute(currentSpaceId!, run.id)}
                      draggable={!isMobile}
                      class="flex items-center gap-2 px-1.5 py-1.5 rounded-[var(--sidebar-item-radius)] text-[13px] transition-colors duration-100 {isActive ? 'text-[var(--sidebar-item-active-fg)] bg-[var(--sidebar-item-active-bg)] font-medium' : 'text-text-tertiary hover:text-text-secondary hover:bg-[var(--sidebar-item-hover-bg)]'}"
                      onclick={(e) => { e.preventDefault(); handleNavigateToTask(run.id); }}
                      ondragstart={(event) => handleTaskDragStart(event, run)}
                      title={getTaskRunMeta(run)}
                    >
                      <div class="min-w-0 flex-1">
                        <div class="truncate leading-tight text-[12px] text-text-secondary">{getTaskRunTitle(run)}</div>
                        <div class="mt-0.5 truncate text-[10px] {badge.color}">{getTaskRunMeta(run)}</div>
                      </div>
                      <span class="w-[6px] h-[6px] rounded-full shrink-0 {badge.dot}"></span>
                    </a>
                  {/each}
                  {#if tasksPageInfo.hasMore && tasksPageInfo.nextCursor}
                    <button
                      type="button"
                      class="mt-1 flex w-full items-center justify-center gap-1.5 rounded-[6px] px-1.5 py-1.5 text-[11px] text-text-placeholder transition-colors hover:bg-bg-hover hover:text-text-secondary disabled:cursor-not-allowed disabled:opacity-60"
                      disabled={loadingMoreTasks}
                      onclick={() => currentSpaceId && void loadMoreTasksForSpace(currentSpaceId)}
                    >
                      {#if loadingMoreTasks}
                        <Loader2 class="h-3 w-3 animate-spin" />
                        {m.common_loading({}, { locale })}
                      {:else}
                        {m.sidebar_show_more({}, { locale })}
                      {/if}
                    </button>
                  {/if}
                </div>
              {/if}
            {:else if activeTaskId}
              <a
                href={buildSpaceTaskRoute(currentSpaceId!, activeTaskId)}
                class="flex items-center gap-2 px-1.5 py-1.5 mt-1 rounded-[var(--sidebar-item-radius)] text-[13px] transition-colors duration-100 text-[var(--sidebar-item-active-fg)] bg-[var(--sidebar-item-active-bg)] font-medium"
                onclick={(e) => { e.preventDefault(); handleNavigateToTask(activeTaskId); }}
              >
                <div class="min-w-0 flex-1">
                  <div class="truncate leading-tight text-[12px]">{m.sidebar_task_run({}, { locale })}</div>
                </div>
              </a>
            {/if}
          </div>
        {/if}
      </div>
    {:else}
      <div class="flex-1 overflow-y-auto px-1.5 pb-2 pt-1 min-h-0">
        <div class="px-1 py-6 text-[12px] text-text-placeholder text-center">
          {m.sidebar_select_space_for_chats({}, { locale })}
        </div>
      </div>
    {/if}
  {:else}
    <div class="px-1.5 pt-2 pb-1">
      <button
        type="button"
        class="flex w-full items-center gap-2 rounded-[5px] px-1.5 py-2 text-[13px] text-text-tertiary transition-colors duration-100 hover:bg-bg-hover hover:text-text-secondary"
        onclick={returnFromSettings}
      >
        <ArrowLeft class="w-[15px] h-[15px] shrink-0" />
        <span class="truncate">{m.nav_back({}, { locale })}</span>
      </button>
    </div>
    <nav class="flex-1 overflow-y-auto px-1.5 py-2 space-y-[2px]">
      {#each settingsTabs as tab (tab.id)}
        {@const isActive = activeSettingsTab === tab.id}
        <a
          href={tab.href}
          class="flex items-center gap-2.5 px-1.5 py-2 rounded-[5px] text-[13px] transition-colors duration-100 cursor-pointer {
            isActive
              ? 'bg-bg-active text-text-primary font-medium'
              : 'text-text-tertiary hover:text-text-secondary hover:bg-bg-hover'
          }"
          onclick={(e) => { e.preventDefault(); void handleNavigate(tab.href, { keepSettingsReturn: true, replaceState: true }); }}
        >
          <tab.icon class="w-[15px] h-[15px] shrink-0" />
          <span>{tab.label}</span>
        </a>
      {/each}
    </nav>
  {/if}

  <!-- User Menu -->
  <div class="border-t border-border-subtle p-1.5 shrink-0 relative" bind:this={expandedUserMenuAnchorEl}>
    {#if showUserMenu}
      <div
        data-user-menu
        class="w-[calc(100%-0px)] overflow-hidden rounded-md border border-border-subtle bg-bg-primary py-0 shadow-lg"
        use:floatNear={{
          getAnchor: () => expandedUserMenuAnchorEl,
          placement: "top-start",
          gap: 4,
          width: Math.max(200, (expandedUserMenuAnchorEl?.clientWidth ?? 220) - 0),
          zIndex: 90,
        }}
      >
        {#if billingConfigured !== false}
          <div class="border-b border-border-subtle">
            <a
              href={currentSubscriptionName ? "/settings/billing" : "/pricing"}
              class="flex w-full items-center gap-2 px-2.5 py-[7px] text-[12px] text-text-tertiary transition-colors duration-100 hover:bg-bg-hover hover:text-text-secondary"
              title={currentSubscriptionName ? m.sidebar_open_billing({}, { locale }) : m.sidebar_view_plans({}, { locale })}
              onclick={(e) => { e.preventDefault(); if (currentSubscriptionName) openBillingSettings(); else { showUserMenu = false; handleNavigate('/pricing'); } }}
            >
              <CreditCard class="w-3.5 h-3.5" />
              <span>{currentSubscriptionName ?? m.sidebar_free_plan({}, { locale })}</span>
              {#if showBillingBalanceEntry}
                <span class="ml-auto font-mono text-[11px] {billingCredit && billingCredit.netUsd < 0 ? 'text-error-soft' : 'text-text-secondary'}">
                  {#if billingCreditLoading || (!billingCredit && !billingCreditError)}
                    <Loader2 class="h-3.5 w-3.5 animate-spin text-text-tertiary" />
                  {:else if billingCredit}
                    {formatUsdAmount(billingCredit.netUsd)}
                  {:else}
                    <span class="text-text-placeholder">—</span>
                  {/if}
                </span>
              {:else if !currentSubscriptionName}
                <span class="ml-auto text-[10px] font-medium text-brand">{m.sidebar_upgrade({}, { locale })}</span>
              {/if}
            </a>
            {#if showBillingBalanceEntry && billingCreditError}
              <div class="px-2.5 pb-2 text-[11px] text-text-placeholder">{billingCreditError}</div>
            {/if}
          </div>
        {/if}
        <a
          href="/settings/referrals"
          class="flex items-center gap-2 px-2.5 py-[7px] text-[12px] text-text-tertiary hover:text-text-secondary hover:bg-bg-hover transition-colors duration-100"
          onclick={(e) => { e.preventDefault(); openReferralsSettings(); }}
        >
          <Gift class="w-3.5 h-3.5" />
          <span>{m.nav_referrals({}, { locale })}</span>
        </a>
        {#if mode === "space"}
          <a
            href="/settings"
            class="flex items-center gap-2 px-2.5 py-[7px] text-[12px] text-text-tertiary hover:text-text-secondary hover:bg-bg-hover transition-colors duration-100"
            onclick={(e) => { e.preventDefault(); openSettings(); }}
          >
            <Settings class="w-3.5 h-3.5" />
            <span>{m.nav_settings({}, { locale })}</span>
          </a>
        {:else}
          <a
            href={settingsReturnTo}
            class="flex items-center gap-2 px-2.5 py-[7px] text-[12px] text-text-tertiary hover:text-text-secondary hover:bg-bg-hover transition-colors duration-100"
            onclick={(e) => { e.preventDefault(); showUserMenu = false; returnFromSettings(); }}
          >
            <FolderKanban class="w-3.5 h-3.5" />
            <span>{m.nav_spaces({}, { locale })}</span>
          </a>
        {/if}
        <a
          href="/trending"
          class="flex items-center gap-2 px-2.5 py-[7px] text-[12px] text-text-tertiary hover:text-text-secondary hover:bg-bg-hover transition-colors duration-100"
          onclick={(e) => { e.preventDefault(); showUserMenu = false; handleNavigate('/trending'); }}
        >
          <BarChart3 class="w-3.5 h-3.5" />
          <span>{m.sidebar_trending({}, { locale })}</span>
        </a>
	        <button
	          type="button"
	          class="flex items-center gap-2 w-full px-2.5 py-[7px] text-[12px] text-text-tertiary hover:text-text-secondary hover:bg-bg-hover transition-colors duration-100"
	          onclick={openHelpPanel}
        >
          <Keyboard class="w-3.5 h-3.5" />
	          <span>{m.sidebar_help({}, { locale })}</span>
	          <span class="ml-auto rounded-[4px] border border-border-subtle bg-bg-surface px-1.5 py-px font-mono text-[10px] leading-4 text-text-placeholder">?</span>
	        </button>
        <a
          href={locale === "zh-CN" ? "/zh/docs" : "/docs"}
          class="flex items-center gap-2 px-2.5 py-[7px] text-[12px] text-text-tertiary hover:text-text-secondary hover:bg-bg-hover transition-colors duration-100"
        >
          <BookOpen class="w-3.5 h-3.5" />
          <span>{m.sidebar_docs({}, { locale })}</span>
        </a>
        <a
          href="/changelog"
          class="flex items-center gap-2 px-2.5 py-[7px] text-[12px] text-text-tertiary hover:text-text-secondary hover:bg-bg-hover transition-colors duration-100"
          onclick={(e) => { e.preventDefault(); showUserMenu = false; handleNavigate('/changelog'); }}
        >
          <History class="w-3.5 h-3.5" />
          <span>{m.sidebar_changelog({}, { locale })}</span>
        </a>
	        <button
	          type="button"
	          class="flex items-center gap-2 w-full px-2.5 py-[7px] text-[12px] text-text-tertiary hover:text-text-secondary hover:bg-bg-hover transition-colors duration-100"
	          onclick={saveDebugLog}
	        >
	          <Download class="w-3.5 h-3.5" />
	          <span>{m.sidebar_save_debug_log({}, { locale })}</span>
	        </button>
	        <button
	          type="button"
	          class="flex items-center gap-2 w-full px-2.5 py-[7px] text-[12px] text-text-tertiary hover:text-error-soft hover:bg-bg-hover transition-colors duration-100"
	          onclick={() => { showUserMenu = false; void handleLogout(); }}
	        >
          <LogOut class="w-3.5 h-3.5" />
          <span>{m.sidebar_sign_out({}, { locale })}</span>
        </button>
      </div>
    {/if}

    <button
      type="button"
      data-user-menu
      class="flex items-center gap-2 w-full px-1.5 py-[6px] rounded-[5px] hover:bg-bg-hover transition-colors duration-100 cursor-pointer"
      onclick={() => { showUserMenu = !showUserMenu; }}
    >
      <UserAvatar name={userDisplayName} avatarUrl={authStore.profile?.avatarUrl} size="xs" class="h-[22px] w-[22px] border-0" />
      <div class="flex-1 min-w-0 text-left">
        <p class="text-[12px] text-text-secondary truncate">{userDisplayName}</p>
      </div>
      <ChevronDown class={'w-3 h-3 text-text-tertiary shrink-0 transition-transform duration-150 ' + (showUserMenu ? 'rotate-180' : '')} />
    </button>
  </div>
</aside>
{/if}

{#if showNewLabelPopover && currentSpaceId && canManageLabels}
	<NewLabelPopover
		spaceId={currentSpaceId}
		{labels}
		onCreated={() => { void loadLabelsForSpace(currentSpaceId, true); }}
		onClose={() => { showNewLabelPopover = false; }}
	/>
{/if}

<style>
	:global([data-theme="neta-studio"]) .new-chat-collapsed {
		border: 1px solid var(--sidebar-primary-action-border);
		border-radius: var(--sidebar-primary-action-radius);
		background: var(--sidebar-primary-action-bg);
		color: var(--sidebar-primary-action-fg);
		box-shadow: 0 6px 16px rgb(0 0 0 / 18%);
	}

	:global([data-theme="neta-studio"]) .new-chat-collapsed:hover {
		background: var(--sidebar-primary-action-bg-hover);
		color: var(--sidebar-primary-action-fg);
	}

	:global([data-theme="neta-studio"]) .new-chat-shortcut {
		border-color: color-mix(
			in srgb,
			var(--sidebar-primary-action-fg) 20%,
			transparent
		);
		background: transparent;
		color: color-mix(
			in srgb,
			var(--sidebar-primary-action-fg) 70%,
			transparent
		);
	}

	.label-tree-row {
		position: relative;
		display: flex;
		min-height: 28px;
		width: 100%;
		align-items: center;
		gap: 6px;
		border-radius: var(--sidebar-item-radius, 6px);
		padding: 0 6px;
		color: var(--text-tertiary);
		font-size: 13px;
		text-align: left;
		transition: background-color 100ms ease, color 100ms ease;
	}

	.label-tree-row:hover,
	.label-tree-row.renaming {
		background: var(--sidebar-item-hover-bg, var(--bg-hover));
		color: var(--text-secondary);
	}

	.label-row-actions {
		margin-left: auto;
		display: inline-flex;
		flex-shrink: 0;
		align-items: center;
		gap: 2px;
		opacity: 0;
		pointer-events: none;
		transition: opacity 100ms ease;
	}

	.label-tree-row:hover .label-row-actions,
	.label-tree-row:focus-within .label-row-actions {
		opacity: 1;
		pointer-events: auto;
	}

	.label-rename-input {
		min-width: 0;
		flex: 1 1 auto;
		border: 1px solid var(--border-subtle);
		border-radius: 5px;
		background: var(--bg-input);
		padding: 2px 6px;
		color: var(--text-primary);
		font: inherit;
		line-height: 1.25;
		outline: none;
	}

	.label-rename-input:focus {
		border-color: color-mix(in srgb, var(--brand) 45%, var(--border-subtle));
		box-shadow: 0 0 0 1px color-mix(in srgb, var(--brand) 18%, transparent);
	}

	.label-tree-row.child {
		padding-left: 16px;
		font-size: 12px;
	}

	.label-tree-row.drop-target {
		background: var(--bg-active);
		color: var(--text-secondary);
	}

	.label-tree-row.drop-target::before,
	.label-tree-row.drop-success::before,
	.label-tree-row.drop-error::before {
		content: "";
		position: absolute;
		left: 0;
		top: 6px;
		bottom: 6px;
		width: 2px;
		border-radius: 999px;
		background: var(--brand);
	}

	.label-tree-row.drop-busy {
		color: var(--text-secondary);
		opacity: 0.75;
	}

	.label-tree-row.drop-error::before {
		background: var(--error-500, var(--brand));
	}

	.label-drop-message {
		margin: 4px 0 6px;
		border-radius: 6px;
		padding: 5px 8px;
		background: color-mix(in srgb, var(--error-500, var(--brand)) 8%, transparent);
		color: var(--text-secondary);
		font-size: 11px;
		line-height: 1.25;
	}

	.rail-button {
		position: relative;
		display: flex;
		height: 2rem;
		width: 2rem;
		align-items: center;
		justify-content: center;
		border-radius: 0.375rem;
		transition:
			background-color 100ms ease,
			color 100ms ease;
	}

	.rail-button:hover {
		background: var(--color-bg-hover);
		color: var(--color-text-secondary);
	}

	.rail-menu-item {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		padding: 0.4375rem 0.625rem;
		font-size: 0.75rem;
		color: var(--color-text-tertiary);
		transition:
			background-color 100ms ease,
			color 100ms ease;
	}

	.rail-menu-item:hover {
		background: var(--color-bg-hover);
		color: var(--color-text-secondary);
	}

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
