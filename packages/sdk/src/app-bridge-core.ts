import { appAuthorizationRequestSchema, appAuthorizationGrantSchema, type AppAuthorizationRequest, type AppAuthorizationGrant, type AppAuthorizationResult } from "@cohub/protocol";
import { PERMISSIONS, isUserLevelPermission, type CreateSpaceInput, type Permission, type SpaceBootstrapSource } from "./types.js";
import type { AppRecord } from "./apis/apps.js";
import type {
	AppRuntimeCheckoutState,
	AppRuntimeContext,
	AppRuntimeInvocationContext,
	AppRuntimeShellContext,
} from "./app-runtime.js";
import {
	syncGrantedAppScopes,
	clearGrantedAppScopes,
	hasGrantedAppScopes,
	listGrantedAppSpacesForScopes,
	listGrantedAppScopes,
	setGrantedAppScopes,
} from "./app-grant-cache.js";

/**
 * The subset of an app record the bridge host needs to answer bridge messages.
 * Matches what the iframe host (AppSurface) and the broker page both have on
 * hand after loading the app.
 */
export type AppBridgeCoreApp = Pick<
	AppRecord,
	"id" | "spaceId" | "slug" | "userUuid" | "appScopes"
> & {
	/** App home space display name, when the host knows it. */
	spaceName?: string | null;
};

/** A space offered to the viewer inside the consent dialog's picker. */
export type AppAuthorizeSpaceOption = {
	id: string;
	name: string | null;
	ownerUserUuid?: string | null;
	isPinned?: boolean;
};

/** Untrusted Space payload from the API, normalized into a picker candidate. */
type RawSpacePayload = {
	id?: unknown;
	name?: unknown;
	userUuid?: unknown;
	ownerUserUuid?: unknown;
	isPinned?: unknown;
};

/**
 * A pending authorize request surfaced to the UI as a consent dialog.
 * `spaceId` is the app's requested target (kept for duplicate detection even
 * when the viewer cannot access it); `spaceName` is resolved by the host from
 * the viewer's Space list (never trusted from the app) for the dialog copy.
 * `selectSpace` asks the viewer to pick the target space inside the dialog —
 * one consent covers both the choice and the grant.
 * `createSpace` asks the host to create a viewer-owned Space (same payload as
 * `POST /api/spaces`) and grant the scopes on it — never silent, never mixed
 * with `spaceId` / `selectSpace`.
 */
export type AppAuthorizeRequest = {
	requestId: string;
	/** Identical requests made while the dialog is open, answered with it. */
	joinedRequestIds?: string[];
	scopes: Permission[];
	reason?: string;
	spaceId?: string;
	spaceName?: string | null;
	selectSpace?: boolean;
	spaces?: AppAuthorizeSpaceOption[] | null;
	/**
	 * The viewer-controlled Space resolved as the target. Absent only when the
	 * target couldn't be resolved (e.g. the viewer's Space list failed to load).
	 * This — not `spaceId` — is what the grant uses.
	 */
	defaultSpaceId?: string;
	/** App home space display name, for context on home-space grants. */
	homeSpaceName?: string | null;
	/** Viewer-owned Space to create as part of this consent. */
	createSpace?: CreateSpaceInput;
};

/**
 * A purchase request being processed by the host.
 */
export type AppPurchaseRequest = {
	requestId: string;
	productKey: string;
	purchaseAttemptId: string;
};

export type AppCheckoutStarted = AppPurchaseRequest & {
	value?: number;
	currency?: string;
};

/**
 * Reactive dialog state managed by the core. The host (Svelte or React)
 * subscribes via {@link AppBridgeCoreConfig.onStateChange} and mirrors these
 * fields into its own reactive primitives.
 */
export type AppBridgeDialogState = {
	authOpen: boolean;
	pendingAuth: AppAuthorizeRequest | null;
	authError: string | null;
	authSaving: boolean;
	/** Space currently selected in the consent dialog. */
	selectedSpaceId: string | null;
	/** Whether the viewer may change the target (more than one candidate). */
	canChangeSpace: boolean;
};

/**
 * A non-fatal diagnostic for the app author. Diagnostics never block the
 * viewer; they explain why the host silently corrected an app request.
 */
export type AppBridgeDiagnostic = {
	code: string;
	message: string;
	detail?: Record<string, unknown>;
};

/**
 * Resolves the current user's Cohub API access token. The core uses this to
 * mint app session / authorization tokens via the Cohub API.
 */
export type AppBridgeGetAccessToken = (
	options?: { forceRefresh?: boolean },
) => Promise<string | null>;

/**
 * Resolves the current viewer's user UUID (or null when unauthenticated).
 * Used for ownership checks and silent re-authorization cache lookups.
 */
export type AppBridgeGetViewerUuid = () => Promise<string | null>;

export type AppPromotionAttributionContext = {
	promotionId: string;
	sourceUrl?: string;
	fbp?: string;
	fbc?: string;
};

export type AppBridgeAuthorizationContext = {
	/** The host surface handling this authorization request. */
	surface: "page" | "app" | "overlay" | "background" | "broker";
};

/**
 * Requests the host to start a sign-in flow, redirecting back to the given
 * path afterward. The core calls this when an API request fails due to missing
 * authentication.
 */
export type AppBridgeRequestSignIn = (redirectPath: string) => Promise<void>;

/**
 * Configuration injected by the caller. The core is transport-agnostic: how a
 * reply is delivered back to the app (iframe postMessage vs opener
 * postMessage) and how the current checkout state is read (page URL) are the
 * caller's responsibility, so the same core serves both bridge and broker
 * hosts. Auth dependencies (token resolution, viewer identity, sign-in) are
 * also injected so the core stays free of any framework's store/auth plumbing.
 */
export type AppBridgeCoreConfig = {
	app: AppBridgeCoreApp;
	/** Trusted host context used to decide whether the publisher may authorize silently. */
	authorizationContext?: AppBridgeAuthorizationContext;
	/** Optional snapshot describing what opened this app runtime. */
	invocation?: AppRuntimeInvocationContext;
	/** Reads the latest opening context without recreating the app surface. */
	getInvocation?: () => AppRuntimeInvocationContext | undefined;
	/** Optional snapshot of the current embedding shell location. */
	shell?: AppRuntimeShellContext;
	/** Reads the latest shell context without recreating the app surface. */
	getShell?: () => AppRuntimeShellContext | undefined;
	/** Sends an unsolicited event to the app runtime. */
	notify?: (payload: Record<string, unknown>) => void;
	/** @deprecated Use authorizationContext with a background surface. */
	isBackground?: boolean;
	/** Base origin for Cohub API requests (e.g. "https://cohub.live"). */
	apiOrigin: string;
	/** Sends a reply payload back to the app runtime. */
	reply: (requestId: string, payload: Record<string, unknown>) => void;
	/** Reads the current checkout state (typically derived from the page URL). */
	getCheckoutState: () => AppRuntimeCheckoutState;
	/** Resolves the current user's Cohub access token. */
	getAccessToken: AppBridgeGetAccessToken;
	/** Resolves the current viewer's user UUID. */
	getViewerUuid: AppBridgeGetViewerUuid;
	/** Starts a sign-in flow with a post-login redirect path. */
	requestSignIn: AppBridgeRequestSignIn;
	/** Returns optional host-owned promotion attribution for checkout. */
	getPromotionAttribution?: () => AppPromotionAttributionContext | null;
	/** Called when the host begins processing a purchase request. */
	onPurchaseRequested?: (input: AppPurchaseRequest) => void;
	/** Called immediately before navigating to a usable checkout. */
	onCheckoutStarted?: (input: AppCheckoutStarted) => void;
	/** Called whenever the dialog state changes, for reactive UI binding. */
	onStateChange?: (state: AppBridgeDialogState) => void;
};

export type AppBridgeCore = {
	/** Returns a snapshot of the current dialog state. */
	getState: () => AppBridgeDialogState;
	/** Processes an inbound bridge message (already source/origin-validated). */
	handleMessage: (event: MessageEvent) => Promise<void>;
	/** Sends the current complete runtime context to the app. */
	notifyContextChanged: (
		invocation?: AppRuntimeInvocationContext,
	) => Promise<void>;
	/** Selects the target Space in the open consent dialog. */
	setSelectedSpace: (spaceId: string) => void;
	/** Confirm/cancel handlers for the authorize dialog. `confirmAuth` receives the space picked in picker mode. */
	confirmAuth: (pickedSpaceId?: string) => Promise<void>;
	cancelAuth: () => void;
};

class AppLoginRedirect extends Error {}

function readTokenResponse(value: unknown) {
	if (!value || typeof value !== "object") return null;
	const token = (value as Record<string, unknown>).token;
	return typeof token === "string" && token ? token : null;
}

function clonePermissionScopes(scopes: readonly Permission[] | null | undefined) {
	return Array.from(scopes ?? []).filter(
		(scope): scope is Permission => typeof scope === "string",
	);
}

/**
 * Scopes arriving over postMessage are untrusted: keep only known permission
 * names (in first-seen order, deduplicated) so a malicious app cannot push
 * arbitrary strings, duplicates, or oversized arrays into the consent dialog.
 */
function sanitizeRequestedScopes(value: unknown): Permission[] {
	if (!Array.isArray(value)) return [];
	const known = new Set<string>(PERMISSIONS);
	const seen = new Set<Permission>();
	for (const scope of value) {
		if (typeof scope === "string" && known.has(scope)) seen.add(scope as Permission);
	}
	return Array.from(seen);
}

/** Consent dialogs render the reason; keep hostile input bounded. */
const MAX_REASON_LENGTH = 280;

/**
 * Bound the viewer's Space lookup so a stalled network can't leave the consent
 * dialog reserved but invisible until the SDK request times out.
 */
const SPACE_LIST_TIMEOUT_MS = 10_000;
/** Bound a single authorize call so a stalled network can't wedge the flow. */
const AUTHORIZE_TIMEOUT_MS = 30_000;
/** Cap serial silent-renewal attempts per request (account grants may span Spaces). */
const MAX_SILENT_SPACE_ATTEMPTS = 4;

const timeoutSignal = (ms: number) =>
	typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function"
		? AbortSignal.timeout(ms)
		: undefined;

const spaceListSignal = () => timeoutSignal(SPACE_LIST_TIMEOUT_MS);

class AppAuthorizationError extends Error {
	constructor(
		message: string,
		readonly status: number,
		readonly code?: string,
	) {
		super(message);
		this.name = "AppAuthorizationError";
	}
}

const isDefinitiveAuthorizationFailure = (error: unknown) =>
	error instanceof AppAuthorizationError && [401, 403, 404].includes(error.status);

/** A grant the server rejected (revoked / not found) — safe to drop from cache. */
const isGrantRejection = (error: unknown) =>
	error instanceof AppAuthorizationError && [403, 404].includes(error.status);

/** A stale access token — never a revoked grant, so never clear the cache. */
const isAuthFailure = (error: unknown) =>
	error instanceof AppAuthorizationError && error.status === 401;

/** Viewer-facing copy for grant failures the viewer cannot act on technically. */
const VIEWER_OPAQUE_AUTH_MESSAGES: Record<string, string> = {
	space_inaccessible: "Couldn't connect this app to your Space. Try another Space.",
	app_not_accessible: "This app isn't available in this Space right now.",
	scope_not_held: "This app needs permissions you don't have yet.",
};

const viewerOpaqueAuthMessage = (error: unknown): string | null =>
	error instanceof AppAuthorizationError && error.code
		? VIEWER_OPAQUE_AUTH_MESSAGES[error.code] ?? null
		: null;

/**
 * Whether a new authorize request asks for exactly the consent a pending
 * dialog already shows: same scopes, same target and same mode. Such a request
 * joins the dialog instead of replacing it, so an App that asks twice (for
 * example on every context update) gets one dialog and one shared answer.
 */
function isSameConsent(
	pending: AppAuthorizeRequest,
	next: { scopes: Permission[]; spaceId?: string; selectSpace: boolean; createSpace?: CreateSpaceInput | null },
) {
	if (next.createSpace || pending.createSpace) return false;
	if (Boolean(pending.selectSpace) !== next.selectSpace) return false;
	if (pending.spaceId !== next.spaceId) return false;
	const a = normalizePermissionScopes(pending.scopes);
	const b = normalizePermissionScopes(next.scopes);
	return a.length === b.length && a.every((scope) => b.includes(scope));
}

function sanitizeReason(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	if (!trimmed) return undefined;
	return trimmed.length > MAX_REASON_LENGTH ? trimmed.slice(0, MAX_REASON_LENGTH) : trimmed;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function sanitizeBootstrapSource(value: unknown): SpaceBootstrapSource | null {
	if (!isRecord(value) || typeof value.type !== "string") return null;
	if (value.type === "blank") return { type: "blank" };
	if (value.type === "checkpoint") {
		const checkpointId = typeof value.checkpointId === "string" ? value.checkpointId.trim() : "";
		return checkpointId ? { type: "checkpoint", checkpointId } : null;
	}
	if (value.type === "git_repo") {
		const repoUrl = typeof value.repoUrl === "string" ? value.repoUrl.trim() : "";
		if (!repoUrl) return null;
		const ref =
			typeof value.ref === "string" ? value.ref.trim() || null : value.ref === null ? null : undefined;
		return ref === undefined
			? { type: "git_repo", repoUrl }
			: { type: "git_repo", repoUrl, ref };
	}
	return null;
}

/**
 * Untrusted postMessage payload → `CreateSpaceInput`. Unknown keys are
 * dropped; the create API still validates the rest.
 */
function sanitizeCreateSpaceInput(value: unknown): CreateSpaceInput | null {
	if (!isRecord(value)) return null;
	const name = typeof value.name === "string" ? value.name.trim() : "";
	if (!name) return null;
	const input: CreateSpaceInput = { name };
	if (value.slug !== undefined) {
		if (value.slug !== null && typeof value.slug !== "string") return null;
		input.slug = value.slug;
	}
	if (value.description !== undefined) {
		if (value.description !== null && typeof value.description !== "string") return null;
		input.description = value.description;
	}
	if (value.source !== undefined) {
		if (typeof value.source !== "string") return null;
		input.source = value.source;
	}
	if (value.bootstrapSource !== undefined) {
		const bootstrap = sanitizeBootstrapSource(value.bootstrapSource);
		if (!bootstrap) return null;
		input.bootstrapSource = bootstrap;
	}
	if (value.extraEnv !== undefined) {
		if (!Array.isArray(value.extraEnv)) return null;
		input.extraEnv = value.extraEnv as CreateSpaceInput["extraEnv"];
	}
	if (value.channelBindings !== undefined) {
		if (!Array.isArray(value.channelBindings)) return null;
		input.channelBindings = value.channelBindings as CreateSpaceInput["channelBindings"];
	}
	if (value.mods !== undefined) {
		if (!Array.isArray(value.mods)) return null;
		input.mods = value.mods as CreateSpaceInput["mods"];
	}
	if (value.config !== undefined) {
		if (!isRecord(value.config)) return null;
		input.config = value.config as CreateSpaceInput["config"];
	}
	return input;
}

function readCreatedSpace(payload: unknown): { id: string; name: string | null } | null {
	if (!isRecord(payload) || !isRecord(payload.space)) return null;
	const id = payload.space.id;
	if (typeof id !== "string" || !id) return null;
	const name = payload.space.name;
	return { id, name: typeof name === "string" && name ? name : null };
}

function normalizePermissionScopes(scopes: readonly Permission[]) {
	return Array.from(new Set(clonePermissionScopes(scopes)));
}

/**
 * Framework-agnostic app bridge host core — message handling, app session
 * token minting, authorization (with silent re-grant cache), and
 * purchase/checkout flow — without any rendering or reactive primitives.
 *
 * Both the Cohub iframe host (AppSurface, Svelte) and the standalone broker
 * page compose this with their own transport-specific reply and auth
 * dependencies. External hosts (e.g. Neta-Studio in React) can do the same.
 */
export function createAppBridgeCore(
	config: AppBridgeCoreConfig,
): AppBridgeCore {
	const { app, reply, getCheckoutState, getAccessToken, getViewerUuid } =
		config;
	const apiOrigin = config.apiOrigin;
	const authorizationContext =
		config.authorizationContext ??
		(config.isBackground
			? { surface: "background" as const }
			: { surface: "page" as const });
	const onStateChange = config.onStateChange;

	let appToken: string | null = null;
	let tokenViewer: string | null | undefined;
	function synchronizeViewer(viewer: string | null) {
		if (tokenViewer !== undefined && tokenViewer !== viewer) {
			appToken = null;
			sessionViewerGrants.clear();
			authoritativeGrants.clear();
		}
		tokenViewer = viewer;
	}
	/** Consents made through this host, keyed by target space. */
	const sessionViewerGrants = new Map<string, { spaceId: string; scopes: Permission[] }>();
	let activeInvocation: AppRuntimeInvocationContext | undefined;
	let contextChangeVersion = 0;
	const legacyRequestIds = new Set<string>();
	const authorizationRequests = new Map<string, AppAuthorizationRequest>();
	const authoritativeGrants = new Map<string, AppAuthorizationGrant>();
	function canJoin(pending: AppAuthorizeRequest, next: Parameters<typeof isSameConsent>[1], requestId: string) {
		const previous = authorizationRequests.get(pending.requestId);
		const current = authorizationRequests.get(requestId);
		return Boolean(previous) === Boolean(current)
			&& previous?.fallback === current?.fallback
			&& isSameConsent(pending, next);
	}
	let signInFlight: Promise<void> | null = null;
	const pendingLoginKey = `cohub:app-login:${app.id}`;

	function rememberAuthorization(data: Record<string, unknown>) {
		// Never persist bootstrap credentials or any token. Creating a Space
		// requires a fresh user action after a full-page login.
		if (data.createSpace) return;
		try {
			const structured = typeof data.requestId === "string" ? authorizationRequests.get(data.requestId) : undefined;
			sessionStorage.setItem(pendingLoginKey, JSON.stringify({ at: Date.now(), data: {
				...(structured ? { ...structured, type: "cohub.app.authorize.v2" } : { type: data.type }), requestId: data.requestId, scopes: data.scopes,
				reason: sanitizeReason(data.reason), spaceId: data.spaceId,
				selectSpace: data.selectSpace, alwaysAsk: data.alwaysAsk,
			} }));
		} catch { /* Storage can be unavailable in private browsing. */ }
	}

	function clearAuthorizationIntent(requestId: string) {
		try {
			const raw = sessionStorage.getItem(pendingLoginKey);
			if (!raw) return;
			const saved = JSON.parse(raw);
			if (isRecord(saved) && isRecord(saved.data) && saved.data.requestId === requestId) {
				sessionStorage.removeItem(pendingLoginKey);
			}
		} catch { /* Storage failure must not change an authorization outcome. */ }
	}

	async function resumeAuthorization() {
		if (state.pendingAuth || !(await getViewerUuid())) return;
		try {
			const raw = sessionStorage.getItem(pendingLoginKey);
			if (!raw) return;
			const saved = JSON.parse(raw);
			if (!isRecord(saved) || typeof saved.at !== "number" || Date.now() - saved.at > 600_000 || !isRecord(saved.data)) {
				sessionStorage.removeItem(pendingLoginKey);
				return;
			}
			await handleMessage({ data: saved.data } as MessageEvent);
		} catch { /* An invalid saved intent must not block context loading. */ }
	}

	async function startSignIn() {
		if (state.pendingAuth) rememberAuthorization({ ...state.pendingAuth, type: "cohub.app.authorize" });
		signInFlight ??= config.requestSignIn(
			typeof location !== "undefined" ? location.pathname + location.search + location.hash : "/",
		).catch((error) => { signInFlight = null; throw error; });
		await signInFlight;
	}

	async function getContext(): Promise<AppRuntimeContext> {
		const invocation =
			activeInvocation !== undefined
				? activeInvocation
				: config.getInvocation?.() ?? config.invocation;
		const shell = config.getShell?.() ?? config.shell;
		const appScopes = clonePermissionScopes(app.appScopes);
		const viewerUuid = await getViewerUuid();
		synchronizeViewer(viewerUuid);
		// Viewer grants as far as the host can tell: previously consented
		// (localStorage cache) overlaid by this session's fresh consents. The
		// server remains the source of truth; this is display-only.
		const viewerGrants = mergeViewerGrants(
			viewerUuid,
			Array.from(sessionViewerGrants.values()),
		);
		return {
			capabilities: { authorization: 2, serverGrants: true },
			mode: authorizationContext.surface === "broker" ? "broker" : "bridge",
			app: {
				id: app.id,
				slug: app.slug,
				url: typeof location !== "undefined" ? location.href : "",
				homeSpace: { id: app.spaceId, name: app.spaceName ?? null },
			},
			// Kept for clients that still read context.space.
			space: { id: app.spaceId },
			viewer: viewerUuid ? { userUuid: viewerUuid } : null,
			...(invocation ? { invocation: { ...invocation } } : {}),
			...(shell
				? {
						shell: {
							...shell,
							space: shell.space ? { ...shell.space } : null,
							session: shell.session ? { ...shell.session } : null,
							turn: shell.turn ? { ...shell.turn } : null,
						},
					}
				: {}),
			permissions: {
				scopes: normalizePermissionScopes([
					...appScopes,
					...viewerGrants.flatMap((grant) => grant.scopes),
				]),
				appScopes,
				viewerScopes: normalizePermissionScopes(
					viewerGrants.flatMap((grant) => grant.scopes),
				),
				viewerGrants,
			},
		};
	}

	/** Builds an authorize reply; the target space rides along for the app. */
	function authorizeResult(
		token: string | null,
		spaceId: string | undefined,
		spaceName: string | null,
	) {
		return {
			type: "cohub.app.authorize.result",
			token,
			space: spaceId
				? { id: spaceId, name: spaceName }
				: { id: app.spaceId, name: app.spaceName ?? null },
		};
	}

	function replyForRequest(
		requestId: string,
		payload: Record<string, unknown>,
		complete = false,
	) {
		const request = authorizationRequests.get(requestId);
		if (request && payload.type === "cohub.app.error" && ["space_inaccessible", "scope_not_held", "app_not_accessible", "consent_required"].includes(String(payload.code))) {
			payload = { ...payload, type: "cohub.app.authorize.result", token: null, result: { status: "denied", code: payload.code } };
		}
		if (request && payload.type === "cohub.app.authorize.result" && !payload.result) {
			const space = payload.space as { id: string; name: string | null } | undefined;
			const grant = space ? authoritativeGrants.get(space.id) : undefined;
			let result: AppAuthorizationResult = { status: "cancelled" };
			if (payload.token && space && grant) {
				result = {
					status: "granted", requestedTarget: request.target,
					target: request.target.kind === "account" ? { kind: "account" } : { kind: "space", spaceId: space.id, name: space.name },
					resolution: request.target.kind === "pick-space" ? "selected" : request.target.kind === "space" && request.target.spaceId !== space.id ? "fallback" : "requested",
					grant,
				};
			} else if (payload.token) {
				payload = { type: "cohub.app.error", code: "invalid_response", message: "Missing authoritative grant." };
			}
			if (payload.type !== "cohub.app.error") payload = { ...payload, result };
		}
		if (complete && (payload.type === "cohub.app.authorize.result" ||
			(payload.type === "cohub.app.error" && ["invalid_request", "space_inaccessible", "scope_not_held", "app_not_accessible", "consent_required"].includes(String(payload.code))))) {
			clearAuthorizationIntent(requestId);
		}
		const namespace = legacyRequestIds.has(requestId) ? "work" : "app";
		const type = payload.type;
		reply(requestId, {
			...payload,
			...(typeof type === "string" && type.startsWith("cohub.app.")
				? { type: type.replace("cohub.app.", `cohub.${namespace}.`) }
				: {}),
		});
		if (complete) {
			legacyRequestIds.delete(requestId);
			authorizationRequests.delete(requestId);
		}
	}

	function toLegacyWorkContext(context: AppRuntimeContext) {
		const permissions = context.permissions
			? {
					scopes: context.permissions.scopes,
					workScopes: context.permissions.appScopes,
					appScopes: context.permissions.appScopes,
					viewerScopes: context.permissions.viewerScopes,
				}
			: undefined;
		return {
			// Keep the legacy projection stable as App context gains fields.
			work: {
				id: context.app.id,
				slug: context.app.slug,
				url: context.app.url,
			},
			space: context.space,
			...(context.viewer !== undefined ? { viewer: context.viewer } : {}),
			...(context.invocation ? { invocation: context.invocation } : {}),
			...(permissions ? { permissions } : {}),
		};
	}

	async function notifyContextChanged(
		invocation?: AppRuntimeInvocationContext,
	) {
		activeInvocation = invocation;
		const version = ++contextChangeVersion;
		if (!config.notify) return;
		const context = await getContext();
		if (version !== contextChangeVersion) return;
		config.notify({
			type: "cohub.app.context.changed",
			context,
		});
	}

	const state: AppBridgeDialogState = {
		authOpen: false,
		pendingAuth: null,
		authError: null,
		authSaving: false,
		selectedSpaceId: null,
		canChangeSpace: false,
	};

	function notify() {
		onStateChange?.({ ...state });
	}

	/** notify() that never lets a broken host callback escape. */
	function safeNotify() {
		try {
			notify();
		} catch {
			// The host's state callback threw; nothing safe to do here.
		}
	}

	/** Sends a developer-facing diagnostic to the app; never surfaced to viewers. */
	function emitDiagnostic(diagnostic: AppBridgeDiagnostic) {
		// Diagnostics are non-fatal: a broken or torn-down host must never turn a
		// warning into a rejection of the surrounding authorization flow.
		try {
			config.notify?.({
				type: "cohub.app.diagnostic",
				code: diagnostic.code,
				message: diagnostic.message,
				...(diagnostic.detail ? { detail: diagnostic.detail } : {}),
			});
		} catch {
			// Ignore transport failures.
		}
	}

	const pendingPurchaseStorageKey = `cohub-app-purchase:${app.id}`;
	const purchaseInFlight = new Map<string, Promise<unknown>>();
	let activePurchase: { productKey: string; promise: Promise<unknown> } | null = null;
	/** Space minted during the current create-space consent; retries skip create. */
	let mintedSpace: {
		id: string;
		name: string | null;
		provisioned: boolean;
		error?: string;
	} | null = null;

	async function isCurrentViewerAppOwner() {
		const viewerUuid = await getViewerUuid();
		return Boolean(viewerUuid && viewerUuid === app.userUuid);
	}

	function mergeViewerGrants(
		viewerUuid: string | null,
		sessionGrants: Array<{ spaceId: string; scopes: Permission[] }>,
	) {
		const bySpace = new Map<string, { spaceId: string; scopes: Permission[] }>();
		for (const grant of listGrantedAppScopes(viewerUuid, app.id, app.spaceId)) {
			bySpace.set(grant.spaceId, grant);
		}
		for (const grant of sessionGrants) {
			bySpace.set(grant.spaceId, grant);
		}
		return Array.from(bySpace.values());
	}

	function allowsOwnerAutoAuthorization() {
		return (
			authorizationContext.surface === "background" ||
			authorizationContext.surface === "app" ||
			authorizationContext.surface === "overlay"
		);
	}

	async function ensureBaseToken(forceRefresh = false) {
		const viewer = await getViewerUuid();
		synchronizeViewer(viewer);
		if (appToken && !forceRefresh) return appToken;
		const userToken = await getAccessToken({ forceRefresh });
		if (!userToken) {
			return null;
		}
		const response = await fetch(
			`${apiOrigin}/api/apps/${app.id}/session`,
			{
				method: "POST",
				headers: { Authorization: `Bearer ${userToken}` },
			},
		);
		if (!response.ok) throw new Error("Failed to create app session.");
		const token = readTokenResponse(await response.json());
		if (!token) throw new Error("Invalid app session response.");
		if (viewer !== await getViewerUuid()) return null;
		appToken = token;
		return appToken;
	}

	/**
	 * Calls the authorize endpoint. `silent` marks a background refresh of a
	 * previous consent: the server then only renews a live grant and never
	 * creates or revives one, so a revoked grant cannot come back without a
	 * fresh dialog.
	 */
	async function authorize(
		scopes: Permission[],
		spaceId?: string,
		options?: { silent?: boolean; forceRefreshToken?: boolean },
	) {
		const incremental = Boolean(state.pendingAuth && authorizationRequests.has(state.pendingAuth.requestId));
		const userToken = await getAccessToken(
			options?.forceRefreshToken ? { forceRefresh: true } : undefined,
		);
		if (!userToken) {
			if (mintedSpace) throw new AppAuthorizationError("Sign in to finish authorization.", 401, "login_required");
			await startSignIn();
			throw new AppLoginRedirect();
		}
		const authorizingViewer = await getViewerUuid();
		const response = await fetch(
			`${apiOrigin}/api/apps/${app.id}/authorize`,
			{
				method: "POST",
				signal: timeoutSignal(AUTHORIZE_TIMEOUT_MS),
				headers: {
					Authorization: `Bearer ${userToken}`,
					"Content-Type": "application/json",
				},
				body: JSON.stringify({
					scopes,
					...(spaceId ? { spaceId } : {}),
					...(options?.silent ? { silent: true } : {}),
					...(incremental ? { scopeMode: "extend" } : {}),
				}),
			},
		);
		const payload = await response.json().catch(() => null) as {
			token?: unknown;
			grant?: { id?: unknown; spaceId?: unknown; scopes?: unknown; expiresAt?: unknown } | null;
			message?: unknown;
			code?: unknown;
		} | null;
		if (!response.ok) {
			throw new AppAuthorizationError(
				typeof payload?.message === "string" ? payload.message : "Authorization failed.",
				response.status,
				typeof payload?.code === "string" ? payload.code : undefined,
			);
		}
		if (authorizingViewer !== await getViewerUuid()) throw new AppAuthorizationError("The signed-in account changed. Please try again.", 409, "session_changed");
		synchronizeViewer(authorizingViewer);
		const token = readTokenResponse(payload);
		if (!token) throw new Error("Invalid app authorization response.");
		const parsedGrant = appAuthorizationGrantSchema.safeParse(payload?.grant);
		if (parsedGrant.success) authoritativeGrants.set(parsedGrant.data.spaceId, parsedGrant.data);
		const canonicalSpaceId =
			typeof payload?.grant?.spaceId === "string" && payload.grant.spaceId
				? payload.grant.spaceId
				: spaceId ?? app.spaceId;
		const grantedScopes = sanitizeRequestedScopes(payload?.grant?.scopes);
		const canonicalScopes = grantedScopes.length > 0 ? grantedScopes : clonePermissionScopes(scopes);
		appToken = token;
		sessionViewerGrants.set(canonicalSpaceId, {
			spaceId: canonicalSpaceId,
			scopes: canonicalScopes,
		});
		const viewerUuid = await getViewerUuid();
		syncGrantedAppScopes(viewerUuid, app.id, spaceId, canonicalSpaceId, canonicalScopes);
		return { token, spaceId: canonicalSpaceId, scopes: canonicalScopes };
	}

	/**
	 * Silent renewal with a single stale-token retry: a 401 means the access
	 * token expired, not that the grant was revoked, so refresh once before
	 * letting the caller classify the failure.
	 */
	async function authorizeSilent(scopes: Permission[], spaceId?: string) {
		try {
			return await authorize(scopes, spaceId, { silent: true });
		} catch (error) {
			if (!isAuthFailure(error)) throw error;
			return authorize(scopes, spaceId, { silent: true, forceRefreshToken: true });
		}
	}

	/**
	 * Attempts silent renewal against each target in order. Returns true when the
	 * request was answered (success or terminal error); false when every target
	 * was a rejected grant, so the caller should fall back to consent.
	 */
	async function attemptSilentRenewal(
		reserved: AppAuthorizeRequest,
		viewerUuid: string | null,
		scopes: Permission[],
		targets: readonly string[],
	): Promise<boolean> {
		if (!viewerUuid || targets.length === 0) return false;
		for (const target of targets) {
			try {
				const result = await authorizeSilent(scopes, target);
				// A different request may have replaced us while we waited; it already
				// answered us, and clearing state here would wipe its reservation.
				if (state.pendingAuth !== reserved) return true;
				replyPendingAuth(reserved, authorizeResult(result.token, result.spaceId, null));
				resetDialogState();
				safeNotify();
				return true;
			} catch (error) {
				if (state.pendingAuth !== reserved) return true;
				// Only a grant the server rejected clears the cache. A 401 is a stale
				// token (already retried with a refresh) and a 5xx/network error is
				// transient: neither may drop a valid grant.
				if (isGrantRejection(error)) {
					clearGrantedAppScopes(viewerUuid, app.id, target);
					if (target === app.spaceId) clearGrantedAppScopes(viewerUuid, app.id);
					continue;
				}
				replyPendingAuth(reserved, {
					type: "cohub.app.error",
					message: error instanceof Error ? error.message : "Authorization failed.",
				});
				resetDialogState();
				safeNotify();
				return true;
			}
		}
		return false;
	}

	/** Normalizes a raw Space payload into a picker candidate. */
	function toSpaceOption(value: RawSpacePayload): AppAuthorizeSpaceOption | null {
		if (typeof value.id !== "string" || !value.id) return null;
		const owner = value.ownerUserUuid ?? value.userUuid;
		return {
			id: value.id,
			name: typeof value.name === "string" && value.name ? value.name : null,
			...(typeof owner === "string" ? { ownerUserUuid: owner } : {}),
			...(typeof value.isPinned === "boolean" ? { isPinned: value.isPinned } : {}),
		};
	}

	/**
	 * Lists the viewer's spaces for the consent dialog picker. Fetched by the
	 * host with the viewer's own token — the app only ever learns the space
	 * the viewer picks, never the list.
	 */
	async function listViewerSpaces(): Promise<AppAuthorizeSpaceOption[] | null> {
		const request = async (forceRefresh = false) => {
			const userToken = await getAccessToken({ forceRefresh });
			if (!userToken) {
				await startSignIn();
				throw new AppLoginRedirect();
			}
			return fetch(`${apiOrigin}/api/spaces`, {
				headers: { Authorization: `Bearer ${userToken}` },
				signal: spaceListSignal(),
			});
		};

		try {
			let response = await request();
			// The consent dialog can outlive the access token's short lifetime. A
			// single refresh keeps a stale cached token from looking like a missing
			// Space list without retrying genuine authorization failures forever.
			if (response?.status === 401) response = await request(true);
			if (!response?.ok) return null;
			const spaces = (await response.json()) as RawSpacePayload[];
			if (!Array.isArray(spaces)) return null;
			return spaces.flatMap((space): AppAuthorizeSpaceOption[] => {
				const option = toSpaceOption(space);
				return option ? [option] : [];
			});
		} catch (error) {
			if (error instanceof AppLoginRedirect) throw error;
			return null;
		}
	}

	/**
	 * Ensures the viewer has a Space to target when their accessible list is
	 * empty. `GET /api/spaces/default` returns their home Space, creating it on
	 * first use — the same path taken when they first enter Cohub.
	 */
	async function ensureDefaultSpace(): Promise<AppAuthorizeSpaceOption | null> {
		const request = async (forceRefresh = false) => {
			const userToken = await getAccessToken({ forceRefresh });
			if (!userToken) return null;
			return fetch(`${apiOrigin}/api/spaces/default`, {
				headers: { Authorization: `Bearer ${userToken}` },
				signal: spaceListSignal(),
			});
		};

		try {
			let response = await request();
			if (response?.status === 401) response = await request(true);
			if (!response?.ok) return null;
			const payload = (await response.json()) as {
				space?: RawSpacePayload | null;
			};
			return payload?.space ? toSpaceOption(payload.space) : null;
		} catch {
			return null;
		}
	}

	const pickedSpaceStorageKey = `cohub:app-picked-space:${app.id}`;

	function readLastPickedSpace(): string | null {
		try {
			return localStorage.getItem(pickedSpaceStorageKey);
		} catch {
			return null;
		}
	}

	function writeLastPickedSpace(spaceId: string) {
		try {
			localStorage.setItem(pickedSpaceStorageKey, spaceId);
		} catch {
			// Ignore storage failures.
		}
	}

	/**
	 * Resolves the default target for a Space-bound request to a Space the
	 * viewer controls — preferring wherever the app was invoked, then the last
	 * Space the viewer picked. Returns undefined when nothing is accessible.
	 */
	function resolveDefaultSpaceId(
		candidates: AppAuthorizeSpaceOption[] | null,
	): string | undefined {
		if (!candidates?.length) return undefined;
		const accessible = (id: string | null | undefined) =>
			id && candidates.some((space) => space.id === id) ? id : undefined;
		const invocation =
			activeInvocation !== undefined
				? activeInvocation
				: config.getInvocation?.() ?? config.invocation;
		const shell = config.getShell?.() ?? config.shell;
		return (
			accessible(invocation?.spaceId) ??
			accessible(shell?.space?.id) ??
			accessible(readLastPickedSpace()) ??
			candidates[0]?.id
		);
	}

	/**
	 * The Space the app is currently in, from trusted host context only (no
	 * network). Used to attempt silent renewal before loading the Space list.
	 */
	function resolveContextSpaceId(): string | undefined {
		const invocation =
			activeInvocation !== undefined
				? activeInvocation
				: config.getInvocation?.() ?? config.invocation;
		const shell = config.getShell?.() ?? config.shell;
		return invocation?.spaceId ?? shell?.space?.id ?? undefined;
	}

	/**
	 * Creates the Space with the viewer's own token — the same `POST /api/spaces`
	 * path as the web New Space flow and the CLI. The app never holds this token.
	 */
	async function createViewerSpace(input: CreateSpaceInput): Promise<{
		id: string;
		name: string | null;
		provisioned: boolean;
		error?: string;
	}> {
		const request = async (forceRefresh = false) => {
			const userToken = await getAccessToken({ forceRefresh });
			if (!userToken) {
				await config.requestSignIn(
					typeof location !== "undefined" ? location.pathname : "/",
				);
				throw new Error("Sign in is required to create a Space.");
			}
			return fetch(`${apiOrigin}/api/spaces`, {
				method: "POST",
				headers: {
					Authorization: `Bearer ${userToken}`,
					"Content-Type": "application/json",
				},
				body: JSON.stringify(input),
			});
		};

		let response = await request();
		if (response.status === 401) response = await request(true);
		const payload = await response.json().catch(() => null);
		const space = readCreatedSpace(payload);
		if (response.ok) {
			if (!space) throw new Error("Invalid space create response.");
			return { ...space, provisioned: true };
		}
		const message =
			isRecord(payload) && typeof payload.message === "string"
				? payload.message
				: "Failed to create Space.";
		// Space row can land before provision fails. Remember it so retry does
		// not 409, but do not treat this as a successful consent.
		if (space) return { ...space, provisioned: false, error: message };
		throw new Error(message);
	}

	function writePendingPurchase(input: {
		orderId: string;
		productKey: string;
	}) {
		if (typeof sessionStorage === "undefined") return;
		try {
			sessionStorage.setItem(
				pendingPurchaseStorageKey,
				JSON.stringify({ ...input, at: Date.now() }),
			);
		} catch {
			// ignore storage failures
		}
	}

	function readPendingPurchase(): {
		orderId: string;
		productKey: string;
		at: number;
	} | null {
		if (typeof sessionStorage === "undefined") return null;
		try {
			const raw = sessionStorage.getItem(pendingPurchaseStorageKey);
			if (!raw) return null;
			const parsed = JSON.parse(raw) as {
				orderId?: unknown;
				productKey?: unknown;
				at?: unknown;
			};
			return typeof parsed.orderId === "string" &&
				typeof parsed.productKey === "string" &&
				typeof parsed.at === "number"
				? {
						orderId: parsed.orderId,
						productKey: parsed.productKey,
						at: parsed.at,
					}
				: null;
		} catch {
			return null;
		}
	}

	function clearPendingPurchase() {
		if (typeof sessionStorage === "undefined") return;
		try {
			sessionStorage.removeItem(pendingPurchaseStorageKey);
		} catch {
			// ignore storage failures
		}
	}

	async function createPurchase(
		productKey: string,
		purchaseAttemptId: string,
	) {
		const userToken = await getAccessToken();
		if (!userToken) {
			await config.requestSignIn(
				typeof location !== "undefined"
					? location.pathname + location.search + location.hash
					: "/",
			);
			return null;
		}
		const promotionAttribution = config.getPromotionAttribution?.() ?? null;
		const response = await fetch(
			`${apiOrigin}/api/apps/${app.id}/commerce/purchase`,
			{
				method: "POST",
				headers: {
					Authorization: `Bearer ${userToken}`,
					"Content-Type": "application/json",
				},
				body: JSON.stringify({
					productKey,
					purchaseAttemptId,
					...(promotionAttribution ? { promotionAttribution } : {}),
				}),
			},
		);
		if (!response.ok)
			throw new Error(
				(await response.json().catch(() => null))?.message ??
					"Purchase failed.",
			);
		const json = await response.json();
		return (json as { checkout?: unknown }).checkout ?? null;
	}

	async function handleMessage(event: MessageEvent) {
		let data = event.data as {
			type?: string;
			requestId?: string;
			scopes?: Permission[];
			reason?: string;
			spaceId?: string;
			selectSpace?: boolean;
			createSpace?: unknown;
			alwaysAsk?: boolean;
			forceRefresh?: boolean;
			productKey?: string;
			purchaseAttemptId?: string;
		};
		if (!data?.requestId) return;
		if (data.type === "cohub.app.authorize.v2") {
			const parsed = appAuthorizationRequestSchema.safeParse(event.data);
			if (!parsed.success || parsed.data.scopes.some((scope) => !PERMISSIONS.includes(scope as Permission))) {
				replyForRequest(data.requestId, { type: "cohub.app.error", code: "invalid_request", message: "Invalid authorization request." }, true);
				return;
			}
			const input = parsed.data;
			if (input.target.kind === "account" && input.scopes.some((scope) => !isUserLevelPermission(scope as Permission))) {
				replyForRequest(data.requestId, { type: "cohub.app.error", code: "invalid_request", message: "Space permissions require a Space target." }, true);
				return;
			}
			authorizationRequests.set(data.requestId, input);
			data = { requestId: data.requestId, ...input, type: "cohub.app.authorize", scopes: input.scopes as Permission[], spaceId: input.target.kind === "space" ? input.target.spaceId : undefined, selectSpace: input.target.kind === "pick-space" };
		}
		if (!data.requestId) return;
		const isLegacyWork = data.type?.startsWith("cohub.work.") === true;
		if (isLegacyWork) legacyRequestIds.add(data.requestId);
		// The dialog reservation this message created, when it got that far. Lets
		// the catch below answer joined requests and clear stale state on error.
		let reservedAuth: AppAuthorizeRequest | null = null;
		try {
			if (data.type === "cohub.app.context" || data.type === "cohub.work.context") {
				const context = await getContext();
				replyForRequest(data.requestId, {
					type: "cohub.app.context.result",
					context: isLegacyWork ? toLegacyWorkContext(context) : context,
				}, true);
				await resumeAuthorization();
			}
			if (data.type === "cohub.app.token" || data.type === "cohub.work.token") {
				const token = await ensureBaseToken(Boolean(data.forceRefresh));
				replyForRequest(data.requestId, { type: "cohub.app.token.result", token }, true);
			}
			if (
				data.type === "cohub.app.checkout-state" ||
				data.type === "cohub.work.checkout-state"
			) {
				const pending = readPendingPurchase();
				const checkoutState = getCheckoutState();
				const orderId =
					checkoutState.orderId ?? pending?.orderId ?? null;
				if (checkoutState.status && checkoutState.orderId)
					clearPendingPurchase();
				replyForRequest(data.requestId, {
					type: "cohub.app.checkout-state.result",
					status: checkoutState.status,
					orderId,
				}, true);
			}
			if (data.type === "cohub.app.purchase" || data.type === "cohub.work.purchase") {
				const productKey =
					typeof data.productKey === "string" ? data.productKey.trim() : "";
				if (!productKey) {
					replyForRequest(data.requestId, {
						type: "cohub.app.error",
						message: "Product key is required.",
					}, true);
					return;
				}
				const suppliedPurchaseAttemptId =
					typeof data.purchaseAttemptId === "string"
						? data.purchaseAttemptId.trim()
						: "";
				const purchaseAttemptId = suppliedPurchaseAttemptId || data.requestId
					.replace(/[^a-zA-Z0-9_-]/g, "_")
					.slice(0, 128);
				if (!/^[a-zA-Z0-9_-]{1,128}$/.test(purchaseAttemptId)) {
					replyForRequest(data.requestId, {
						type: "cohub.app.error",
						message: "Purchase attempt id is invalid.",
					}, true);
					return;
				}
				const purchase = { requestId: data.requestId, productKey, purchaseAttemptId };
				const existing = purchaseInFlight.get(purchaseAttemptId);
				if (existing) {
					await replyPurchaseResult(purchase, existing);
					return;
				}
				if (activePurchase) {
					if (activePurchase.productKey !== productKey) {
						replyForRequest(data.requestId, {
							type: isLegacyWork ? "cohub.work.error" : "cohub.app.error",
							message: "Another purchase is already in progress.",
						}, true);
						return;
					}
					// Older SDKs may generate a new attempt id for every click. Coalesce
					// those requests while the same product is already being purchased.
					await replyPurchaseResult(purchase, activePurchase.promise);
					return;
				}
				config.onPurchaseRequested?.(purchase);
				const request = executePurchase(purchase);
				activePurchase = { productKey, promise: request };
				purchaseInFlight.set(purchaseAttemptId, request);
				try {
					await replyPurchaseResult(purchase, request);
				} finally {
					purchaseInFlight.delete(purchaseAttemptId);
					if (activePurchase?.promise === request) activePurchase = null;
				}
			}
			if (data.type === "cohub.app.authorize" || data.type === "cohub.work.authorize") {
				const scopes = sanitizeRequestedScopes(data.scopes);
				const spaceId =
					typeof data.spaceId === "string" && data.spaceId
						? data.spaceId
						: undefined;
				// Picker mode only applies when the app does not already know the
				// target space.
				const selectSpace = data.selectSpace === true && !spaceId;
				const createSpace =
					data.createSpace === undefined ? undefined : sanitizeCreateSpaceInput(data.createSpace);
				// `alwaysAsk` skips silent reuse so the viewer can re-confirm or
				// change the grant (e.g. switch to another Space).
				const alwaysAsk = data.alwaysAsk === true;
				if (scopes.length === 0) {
					replyForRequest(data.requestId, {
						type: "cohub.app.error",
						message: "No scopes requested.",
					}, true);
					return;
				}
				if (data.createSpace !== undefined && !createSpace) {
					const named =
						isRecord(data.createSpace) &&
						typeof data.createSpace.name === "string" &&
						Boolean(data.createSpace.name.trim());
					replyForRequest(data.requestId, {
						type: "cohub.app.error",
						message: named ? "Invalid space create input." : "Space name is required.",
					}, true);
					return;
				}
				if (createSpace && (selectSpace || spaceId)) {
					replyForRequest(data.requestId, {
						type: "cohub.app.error",
						message: "createSpace cannot be combined with spaceId or selectSpace.",
					}, true);
					return;
				}
				if (state.authSaving) {
					replyForRequest(data.requestId, {
						type: "cohub.app.error",
						message: "Another authorization is already in progress.",
					}, true);
					return;
				}
				if (state.pendingAuth) {
					if (canJoin(state.pendingAuth, { scopes, spaceId, selectSpace, createSpace }, data.requestId)) {
						state.pendingAuth.joinedRequestIds = [
							...(state.pendingAuth.joinedRequestIds ?? []),
							data.requestId,
						];
						return;
					}
					dismissPendingAuth();
				}
				// Creating a Space is a side effect: always a consent dialog, never
				// silent reuse or publisher auto-authorization.
				if (createSpace) {
					if (!(await getViewerUuid())) {
						await startSignIn();
						return;
					}
					mintedSpace = null;
					const pendingCreate: AppAuthorizeRequest = {
						requestId: data.requestId,
						scopes,
						reason: sanitizeReason(data.reason),
						homeSpaceName: app.spaceName ?? null,
						createSpace,
					};
					state.pendingAuth = pendingCreate;
					reservedAuth = pendingCreate;
					state.selectedSpaceId = null;
					state.canChangeSpace = false;
					state.authError = null;
					state.authOpen = true;
					notify();
					return;
				}
				// The publisher's own app auto-authorizes without a dialog — but
				// never when the app explicitly asks for re-consent, and always
				// through the silent path so a revoked grant cannot come back
				// without the owner confirming it again. A failed silent attempt
				// (e.g. the owner revoked the grant) falls through to the consent
				// dialog like any other viewer.
				if (
					!selectSpace &&
					!authorizationRequests.has(data.requestId) &&
					!alwaysAsk &&
					allowsOwnerAutoAuthorization() &&
					(await isCurrentViewerAppOwner())
				) {
					try {
						const result = await authorizeSilent(scopes, spaceId);
						replyForRequest(
							data.requestId,
							authorizeResult(
								result.token,
								result.spaceId,
								result.spaceId === app.spaceId ? app.spaceName ?? null : null,
							),
							true,
						);
						return;
					} catch (error) {
						if (!isDefinitiveAuthorizationFailure(error)) {
							replyForRequest(data.requestId, {
								type: "cohub.app.error",
								message: error instanceof Error ? error.message : "Authorization failed.",
							}, true);
							return;
						}
						// A definitive rejection needs fresh viewer consent.
					}
				}
				// A dialog may have opened while we resolved the owner path. Re-check so
				// a concurrent request joins or replaces it instead of both proceeding
				// and overwriting each other.
				if (state.pendingAuth) {
					if (canJoin(state.pendingAuth, { scopes, spaceId, selectSpace, createSpace }, data.requestId)) {
						state.pendingAuth.joinedRequestIds = [
							...(state.pendingAuth.joinedRequestIds ?? []),
							data.requestId,
						];
						return;
					}
					dismissPendingAuth();
				}
				const requestId = data.requestId;
				// Reserve the dialog synchronously before any further async work, so a
				// concurrent request sees it (and joins or replaces) rather than racing
				// us into an overwrite that would leave it waiting for a reply.
				// `spaceId` keeps the app's requested target for duplicate detection;
				// `defaultSpaceId` below carries the resolved, viewer-controlled one.
				const reserved: AppAuthorizeRequest = {
					requestId,
					scopes,
					reason: sanitizeReason(data.reason),
					homeSpaceName: app.spaceName ?? null,
					...(spaceId ? { spaceId } : {}),
					...(selectSpace ? { selectSpace: true } : {}),
				};
				state.pendingAuth = reserved;
				reservedAuth = reserved;
				state.selectedSpaceId = null;
				state.canChangeSpace = false;
				state.authError = null;

				// The viewer's identity is cheap (token store) and needed for the
				// client-side cache checks before we decide whether to load Spaces.
				const viewerUuid = await getViewerUuid();
				if (state.pendingAuth !== reserved) return;
				if (!viewerUuid) {
					rememberAuthorization(data as Record<string, unknown>);
					await startSignIn();
					return;
				}

				// Resolve the target before any silent reuse, so a legacy home-space
				// cache entry cannot silently re-authorize the app author's Space.
				// Space-bound requests carry the viewer's Spaces so the consent dialog
				// can show — and let them change — the target Space. Account-only
				// requests need no Space and no picker.
				const spaceLevel =
					Boolean(spaceId) ||
					selectSpace ||
					scopes.some((scope) => !isUserLevelPermission(scope));
				const lastPicked = readLastPickedSpace();

				// Fast path: renew without loading the Space list when the target is
				// already known client-side — account-level grants, or the Space the app
				// was invoked in. A returning viewer thus skips the list round trip and
				// is not blocked by a transient list failure.
				const contextSpaceId = resolveContextSpaceId();
				const preListTargets = !spaceLevel
					? listGrantedAppSpacesForScopes(viewerUuid, app.id, scopes, app.spaceId)
					: spaceId === undefined &&
						  !selectSpace &&
						  contextSpaceId &&
						  hasGrantedAppScopes(viewerUuid, app.id, scopes, contextSpaceId)
						? [contextSpaceId]
						: [];
				if (
					!alwaysAsk &&
					(await attemptSilentRenewal(reserved, viewerUuid, scopes, preListTargets))
				) {
					return;
				}
				if (state.pendingAuth !== reserved) return;

				let spaces = spaceLevel ? await listViewerSpaces() : undefined;
				if (state.pendingAuth !== reserved) return;
				// A viewer with no accessible Space still needs a target:
				// /spaces/default ensures and returns their home Space.
				if (spaces && spaces.length === 0) {
					const fallback = await ensureDefaultSpace();
					if (state.pendingAuth !== reserved) return;
					if (fallback) spaces = [fallback];
				}
				const candidates = spaces ?? null;
				// A failed Space lookup is different from an empty accessible list.
				// Keep the dialog visible for retry, but never authorize an unresolved target.
				if (spaceLevel && spaces === null) {
					reserved.spaces = null;
					state.authError = "Couldn't load your Spaces. Please try again.";
					state.authOpen = true;
					state.canChangeSpace = false;
					notify();
					return;
				}
				// An explicit target is honoured only when the viewer can use it. A list
				// that failed to load stays unresolved for every Space-bound request, so
				// confirmation is blocked rather than trusting an unverified target.
				const explicitAccessible =
					Boolean(spaceId) &&
					candidates?.some((space) => space.id === spaceId) === true;
				const structuredRequest = authorizationRequests.get(data.requestId);
				if (spaceId && candidates && !explicitAccessible && structuredRequest?.fallback === "none") {
					replyPendingAuth(reserved, { type: "cohub.app.error", code: "space_inaccessible", message: "The requested Space is unavailable." });
					resetDialogState();
					safeNotify();
					return;
				}
				const defaultSpaceId = explicitAccessible
					? spaceId
					: resolveDefaultSpaceId(candidates);

				// Remaining silent targets that need the loaded candidates: picker mode
				// (last picked, only if still accessible), an accessible explicit target,
				// or the resolved default. Account grants were already tried above.
				const silentTargets = (
					!spaceLevel
						? []
						: [
								selectSpace
									? lastPicked && candidates?.some((space) => space.id === lastPicked)
										? lastPicked
										: null
									: explicitAccessible
										? spaceId
										: spaceId === undefined
											? defaultSpaceId
											: null,
							].filter(
								(target): target is string =>
									Boolean(target) &&
									hasGrantedAppScopes(viewerUuid, app.id, scopes, target ?? undefined),
							)
				).slice(0, MAX_SILENT_SPACE_ATTEMPTS);
				if (
					!alwaysAsk &&
					(await attemptSilentRenewal(reserved, viewerUuid, scopes, silentTargets))
				) {
					return;
				}
				if (state.pendingAuth !== reserved) return;

				if (spaceId && candidates && !explicitAccessible) {
					// No resolved id: that would leak the viewer's Space to the app
					// before they consent.
					emitDiagnostic({
						code: "space_inaccessible",
						message: defaultSpaceId
							? "The app requested a Space this viewer cannot access; using a Space the viewer controls instead."
							: "The app requested a Space this viewer cannot access, and no viewer-controlled Space was available.",
						detail: { requestedSpaceId: spaceId },
					});
				}
				const spaceName = defaultSpaceId
					? candidates?.find((space) => space.id === defaultSpaceId)?.name ?? null
					: null;
				// Mutate in place so the reservation keeps its identity: the outer catch
				// releases state by identity, not by an app-supplied id.
				Object.assign(reserved, {
					...(explicitAccessible && spaceName ? { spaceName } : {}),
					...(spaces !== undefined ? { spaces: spaces ?? null } : {}),
					...(defaultSpaceId ? { defaultSpaceId } : {}),
				});
				state.selectedSpaceId = defaultSpaceId ?? null;
				// An explicit, accessible target is fixed: the caller receives only a
				// boolean and acts on the Space it named, so the viewer must not be able
				// to redirect the grant elsewhere. Change is offered only when there is
				// no target or the requested one is inaccessible.
				state.canChangeSpace =
					!explicitAccessible && (candidates?.length ?? 0) > 1;
				state.authOpen = true;
				notify();
			}
		} catch (error) {
			if (error instanceof AppLoginRedirect) {
				rememberAuthorization(data as Record<string, unknown>);
				resetDialogState();
				safeNotify();
				return;
			}
			const message =
				error instanceof Error ? error.message : "Request failed.";
			const code = error instanceof AppAuthorizationError ? error.code : "request_failed";
			// An error after the reservation (e.g. `onStateChange` threw) must answer
			// every joined request and release the dialog, or they would wait for the
			// SDK timeout and leave invisible stale state. Identity — not the
			// app-supplied request id — decides what is still the current reservation.
			if (reservedAuth && state.pendingAuth === reservedAuth) {
				replyPendingAuth(reservedAuth, { type: "cohub.app.error", message, code });
				resetDialogState();
				safeNotify();
				return;
			}
			replyForRequest(data.requestId, {
				type: "cohub.app.error",
				message,
				code,
			}, true);
		}
	}

	/** Answers the dialog's request and every request that joined it. */
	function replyPendingAuth(pending: AppAuthorizeRequest, payload: Record<string, unknown>) {
		for (const requestId of [pending.requestId, ...(pending.joinedRequestIds ?? [])]) {
			replyForRequest(requestId, payload, true);
		}
	}

	/** Closes the consent dialog and drops its transient selection state. */
	function resetDialogState() {
		state.pendingAuth = null;
		state.authOpen = false;
		state.authError = null;
		state.selectedSpaceId = null;
		state.canChangeSpace = false;
	}

	function dismissPendingAuth() {
		if (!state.pendingAuth) return;
		replyPendingAuth(state.pendingAuth, {
			type: "cohub.app.authorize.result",
			token: null,
			...(mintedSpace ? { space: { id: mintedSpace.id, name: mintedSpace.name }, stage: mintedSpace.provisioned ? "authorization" : "bootstrap" } : {}),
		});
		resetDialogState();
		mintedSpace = null;
		notify();
	}

	function cancelAuth() {
		if (state.authSaving) return;
		if (!state.pendingAuth) return;
		dismissPendingAuth();
		state.authSaving = false;
		notify();
	}

	/**
	 * Only a Space the host actually loaded may become the target, so a UI bug
	 * cannot mint a grant against an arbitrary id.
	 */
	function setSelectedSpace(spaceId: string) {
		if (!state.pendingAuth || state.authSaving || !state.canChangeSpace) return;
		// Only a candidate the host actually loaded may become the target, so a UI
		// bug cannot mint a grant against an arbitrary id.
		const spaces = state.pendingAuth.spaces;
		if (!spaces?.some((space) => space.id === spaceId)) return;
		if (state.selectedSpaceId === spaceId) return;
		state.selectedSpaceId = spaceId;
		notify();
	}

	async function executePurchase(purchase: AppPurchaseRequest) {
		const checkout = await createPurchase(
			purchase.productKey,
			purchase.purchaseAttemptId,
		);
		if (checkout && typeof checkout === "object") {
			const next = checkout as {
				checkoutUrl?: unknown;
				checkoutUsable?: unknown;
				orderId?: unknown;
				productKey?: unknown;
				value?: unknown;
				currency?: unknown;
			};
			if (typeof next.orderId === "string" && typeof next.productKey === "string") {
				writePendingPurchase({ orderId: next.orderId, productKey: next.productKey });
			}
			const url = next.checkoutUrl;
			if (next.checkoutUsable === true && typeof url === "string" && url) {
				config.onCheckoutStarted?.({
					...purchase,
					...(typeof next.value === "number" ? { value: next.value } : {}),
					...(typeof next.currency === "string" ? { currency: next.currency } : {}),
				});
				window.location.href = url;
			}
		}
		return checkout;
	}

	async function replyPurchaseResult(
		purchase: AppPurchaseRequest,
		request: Promise<unknown>,
	) {
		try {
			replyForRequest(purchase.requestId, {
				type: "cohub.app.purchase.result",
				checkout: await request,
			}, true);
		} catch (error) {
			replyForRequest(purchase.requestId, {
				type: "cohub.app.error",
				message: error instanceof Error ? error.message : "Purchase failed.",
			}, true);
		}
	}

	async function confirmAuth(pickedSpaceId?: string) {
		if (!state.pendingAuth || state.authSaving) return;
		const pending = state.pendingAuth;
		// The dialog passes the Space it selected; fall back to the core's
		// selection. The app's raw `spaceId` is never trusted: a Space-bound
		// request must target one of the Spaces the host actually loaded.
		// A pinned target (an accessible explicit `spaceId`) ignores any caller pick:
		// the caller only receives a boolean and acts on the Space it named.
		const picked = state.canChangeSpace ? pickedSpaceId : undefined;
		let requestedSpaceId = picked ?? state.selectedSpaceId ?? undefined;
		if (pending.spaces === null) {
			state.authError = "Couldn't load your Spaces. Please try again.";
			notify();
			return;
		}
		if (pending.spaces !== undefined) {
			const candidates = pending.spaces;
			const resolved =
				requestedSpaceId !== undefined &&
				candidates?.some((space) => space.id === requestedSpaceId) === true;
			if (!resolved) {
				state.authError =
					!candidates || candidates.length === 0
						? "Couldn't load your Spaces. Please try again."
						: "Choose a Space to continue.";
				notify();
				return;
			}
		}
		state.authError = null;
		state.authSaving = true;
		notify();
		try {
			if (pending.createSpace) {
				mintedSpace ??= await createViewerSpace(pending.createSpace);
				if (!mintedSpace.provisioned) {
					// Space row exists, bootstrap did not. Close with a structured
					// denial so the app can handle it — do not grant, do not hang.
					replyPendingAuth(
						pending,
						authorizeResult(
							null,
							mintedSpace.id,
							mintedSpace.name ?? pending.createSpace.name,
						),
					);
					resetDialogState();
					mintedSpace = null;
					return;
				}
				requestedSpaceId = mintedSpace.id;
			}
			const result = await authorize(pending.scopes, requestedSpaceId);
			const viewerUuid = await getViewerUuid();
			setGrantedAppScopes(viewerUuid, app.id, result.scopes, result.spaceId);
			if (
				pending.selectSpace ||
				pending.createSpace ||
				(pickedSpaceId && pickedSpaceId !== pending.spaceId)
			) {
				writeLastPickedSpace(result.spaceId);
			}
			// Name the Space the server actually granted; fall back to the
			// request's own labels for the implicit home-space and create paths.
			let spaceName: string | null = null;
			if (pending.createSpace) {
				spaceName = mintedSpace?.name ?? pending.createSpace.name;
			} else {
				const listed = pending.spaces?.find(
					(space) => space.id === result.spaceId,
				)?.name;
				if (listed) spaceName = listed;
				else if (result.spaceId === pending.spaceId) spaceName = pending.spaceName ?? null;
				else if (result.spaceId === app.spaceId) spaceName = app.spaceName ?? null;
			}
			replyPendingAuth(
				pending,
				authorizeResult(result.token, result.spaceId, spaceName),
			);
			resetDialogState();
			mintedSpace = null;
		} catch (error) {
			if (error instanceof AppLoginRedirect) return;
			if (mintedSpace && error instanceof AppAuthorizationError && error.code === "login_required") {
				replyPendingAuth(pending, authorizeResult(null, mintedSpace.id, mintedSpace.name));
				resetDialogState();
				mintedSpace = null;
				return;
			}
			// Grant failures whose cause is the app's own configuration are never
			// surfaced to the viewer; they go to the app author as diagnostics. Other
			// failures keep their message because the viewer can act on them (e.g. a
			// Space that already exists).
			if (error instanceof AppAuthorizationError) {
				emitDiagnostic({
					code: error.code ?? "authorize_failed",
					message: error.message,
					detail: { scopes: pending.scopes },
				});
			}
			state.authError =
				viewerOpaqueAuthMessage(error) ??
				(error instanceof Error ? error.message : "Authorization failed.");
		} finally {
			state.authSaving = false;
			notify();
		}
	}

	return {
		getState: () => ({ ...state }),
		handleMessage,
		notifyContextChanged,
		setSelectedSpace,
		confirmAuth,
		cancelAuth,
	};
}
