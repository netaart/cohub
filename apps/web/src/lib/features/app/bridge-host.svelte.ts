import {
	type AppAuthorizeRequest,
	type AppBridgeAuthorizationContext,
	type AppBridgeCoreApp,
	type AppRuntimeCheckoutState,
	type AppRuntimeInvocationContext,
	type AppRuntimeShellContext,
	createAppBridgeCore,
} from "@neta-art/cohub";
import { PUBLIC_API_ORIGIN } from "$env/static/public";
import {
	getAppPromotionCheckoutAttribution,
	reportAppPromotionCheckoutStarted,
	reportAttributedAppPromotionEvent,
} from "$lib/app-promotion";
import { getAuthToken, signInWithRedirectPath } from "$lib/auth";
import { readInstalledApps } from "$lib/features/app/app-center";
import { readHostAppearance } from "$lib/features/app/host-appearance.svelte";
import { getLocale } from "$lib/i18n/locale.svelte";
import { authStore } from "$lib/stores/auth.svelte";

/**
 * The subset of an app record the bridge host needs to answer bridge messages.
 * Matches what the iframe host (AppSurface) and the broker page both have on
 * hand after loading the app.
 */
export type AppBridgeHostApp = AppBridgeCoreApp;

/**
 * A pending authorize request surfaced to the UI as a consent dialog.
 */
/**
 * Purchase request payload received from an App.
 */
export type {
	AppAuthorizeRequest,
	AppPurchaseRequest,
} from "@neta-art/cohub";

/**
 * Configuration injected by the caller. The host is transport-agnostic: how a
 * reply is delivered back to the app (iframe postMessage vs opener
 * postMessage) and how the current checkout state is read (page URL) are the
 * caller's responsibility, so the same host serves both bridge and broker.
 */
export type AppBridgeHostConfig = {
	app: AppBridgeHostApp;
	authorizationContext?: AppBridgeAuthorizationContext;
	invocation?: AppRuntimeInvocationContext;
	/** Reads the latest opening context without recreating the app surface. */
	getInvocation?: () => AppRuntimeInvocationContext | undefined;
	shell?: AppRuntimeShellContext;
	/** Reads the latest shell context without recreating the app surface. */
	getShell?: () => AppRuntimeShellContext | undefined;
	/** Reads whether this surface is showing; omitted means always visible. */
	getWindow?: () => { visible: boolean };
	/** Sends an unsolicited event to the app runtime. */
	notify?: (payload: Record<string, unknown>) => void;
	/** Sends a reply payload back to the app runtime. */
	reply: (requestId: string, payload: Record<string, unknown>) => void;
	/** Reads the current checkout state (typically derived from the page URL). */
	getCheckoutState: () => AppRuntimeCheckoutState;
};

export type AppBridgeHost = {
	/** Reactive authorize-dialog state. */
	readonly authOpen: boolean;
	readonly pendingAuth: AppAuthorizeRequest | null;
	readonly authError: string | null;
	readonly authSaving: boolean;
	/** Space currently selected in the consent dialog. */
	readonly selectedSpaceId: string | null;
	/** Whether the viewer may change the target (more than one candidate). */
	readonly canChangeSpace: boolean;
	/** Processes an inbound bridge message (already source/origin-validated). */
	handleMessage: (event: MessageEvent) => Promise<void>;
	/** Sends the current complete runtime context to the app. */
	notifyContextChanged: (
		invocation?: AppRuntimeInvocationContext,
	) => Promise<void>;
	/** Selects the target Space in the consent dialog. */
	setSelectedSpace: (spaceId: string) => void;
	/** Confirm/cancel handlers for the authorize dialog. */
	confirmAuth: (pickedSpaceId?: string) => Promise<void>;
	cancelAuth: () => void;
};

export function createAppBridgeHost(
	config: AppBridgeHostConfig,
): AppBridgeHost {
	let authOpen = $state(false);
	let pendingAuth = $state<AppAuthorizeRequest | null>(null);
	let authError = $state<string | null>(null);
	let authSaving = $state(false);
	let selectedSpaceId = $state<string | null>(null);
	let canChangeSpace = $state(false);

	const core = createAppBridgeCore({
		app: config.app,
		authorizationContext: config.authorizationContext,
		invocation: config.invocation,
		getInvocation: config.getInvocation,
		shell: config.shell,
		getShell: config.getShell,
		// Served from cache. Realtime changes to `.cohub/apps.json` invalidate it,
		// so an uninstall stops new dialog-free grants right away.
		isInstalledIn: async (spaceId) => {
			const { document } = await readInstalledApps(spaceId);
			return document.apps.some(
				(app) => app.id === config.app.id && app.enabled,
			);
		},
		getLocale,
		getAppearance: readHostAppearance,
		getWindow: config.getWindow,
		notify: config.notify,
		apiOrigin: PUBLIC_API_ORIGIN ?? "",
		reply: config.reply,
		getCheckoutState: config.getCheckoutState,
		getAccessToken: (options) => getAuthToken(options),
		getViewerUuid: async () => {
			await authStore.ensureLoaded();
			return authStore.userUuid;
		},
		requestSignIn: (redirectPath) => signInWithRedirectPath(redirectPath),
		getPromotionAttribution: () =>
			getAppPromotionCheckoutAttribution(config.app.id),
		onPurchaseRequested: (purchase) => {
			void reportAttributedAppPromotionEvent({
				appId: config.app.id,
				eventId: purchase.purchaseAttemptId,
				productKey: purchase.productKey,
			}).catch(() => {
				console.warn("[app-promotions] Failed to report purchase intent.");
			});
		},
		onCheckoutStarted: (purchase) => {
			reportAppPromotionCheckoutStarted({
				eventId: purchase.purchaseAttemptId,
				productKey: purchase.productKey,
				value: purchase.value,
				currency: purchase.currency,
			});
		},
		onStateChange: (next) => {
			authOpen = next.authOpen;
			pendingAuth = next.pendingAuth;
			authError = next.authError;
			authSaving = next.authSaving;
			selectedSpaceId = next.selectedSpaceId;
			canChangeSpace = next.canChangeSpace;
		},
	});

	return {
		get authOpen() {
			return authOpen;
		},
		get pendingAuth() {
			return pendingAuth;
		},
		get authError() {
			return authError;
		},
		get authSaving() {
			return authSaving;
		},
		get selectedSpaceId() {
			return selectedSpaceId;
		},
		get canChangeSpace() {
			return canChangeSpace;
		},
		handleMessage: core.handleMessage,
		notifyContextChanged: core.notifyContextChanged,
		setSelectedSpace: core.setSelectedSpace,
		confirmAuth: core.confirmAuth,
		cancelAuth: core.cancelAuth,
	};
}
