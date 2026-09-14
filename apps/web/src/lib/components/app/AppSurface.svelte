<script lang="ts">
import {
	type AppNavigationOpenMessage,
	buildAppNavigationOpenMessage,
	buildAppNavigationOpenResponse,
	parseAppNavigationOpenMessage,
} from "@cohub/protocol/app-navigation";
import type { AppRuntimeConfigureRequest } from "@cohub/protocol/app-runtime";
import {
	parseAppRuntimeCloseRequest,
	parseAppRuntimeConfigureRequest,
	parseAppRuntimePointer,
	parseAppRuntimeReady,
} from "@cohub/protocol/app-runtime";
import type { AppComposerChip } from "@cohub/protocol/app-surface";
import type {
	AppContent,
	AppRecord,
	AppRuntimeInvocationContext,
	AppRuntimeShellContext,
} from "@neta-art/cohub";
import { Eye } from "lucide-svelte";
import { onMount, untrack } from "svelte";
import { page } from "$app/state";
import { appDisplayTitle } from "$lib/app-page-meta";
import { type AppLaunchState, resolveAppFrame } from "$lib/app-url";
import WorkBoardSurface from "$lib/components/app/AppBoardSurface.svelte";
import WorkFileSurface from "$lib/components/app/AppFileSurface.svelte";
import { readAppCheckoutState } from "$lib/components/app/app-checkout-state";
import SpaceAvatar from "$lib/components/SpaceAvatar.svelte";
import UserIdentity from "$lib/components/UserIdentity.svelte";
import AppAuthorizeDialog from "$lib/features/app/AppAuthorizeDialog.svelte";
import { createAppBridgeHost } from "$lib/features/app/bridge-host.svelte";
import {
	type AppSurfaceHost,
	createAppSurfaceHost,
} from "$lib/features/app/surface-host";
import { formatCompactNumber, formatNumber } from "$lib/i18n/format";
import { getLocale } from "$lib/i18n/locale.svelte";
import { parseNewChatBackgroundAction } from "$lib/new-chat-background-bridge";
import { m } from "$lib/paraglide/messages.js";
import { emitSpaceConfigBackgroundAction } from "$lib/space-config";
import { createSpaceWorkspaceAssetResolver } from "$lib/space-workspace-assets";
import type { WorkspaceFileLinkTarget } from "$lib/workspace-file-links";

type AppSurfaceMode = "page" | "background" | "app" | "overlay";

type AppSpace = {
	id: string;
	slug: string | null;
	name: string | null;
	userUuid: string;
	publicProfile?: { avatarUrl: string | null } | null;
};

type AppOwner = {
	username: string | null;
	displayName: string;
	avatarUrl?: string | null;
} | null;

type Props = {
	app: Pick<
		AppRecord,
		| "id"
		| "spaceId"
		| "userUuid"
		| "slug"
		| "visibility"
		| "targetType"
		| "targetRef"
		| "appScopes"
		| "meta"
	>;
	space?: AppSpace | null;
	owner?: AppOwner;
	content?: AppContent | null;
	/** All-time view count shown in the public Cohub bar. */
	totalViews?: number | null;
	mode?: AppSurfaceMode;
	launchState?: AppLaunchState | null;
	invocation?: AppRuntimeInvocationContext;
	shell?: AppRuntimeShellContext;
	/**
	 * Receives the surface RPC host once mounted, so a parent can invoke methods
	 * the app registered. Only meaningful for embedded (web / port) apps.
	 */
	onSurfaceHost?: (host: AppSurfaceHost | null) => void;
	onComposerChip?: (chip: AppComposerChip | null) => void;
	onReady?: () => void;
	/** The App asked to close the surface it runs in. */
	onCloseRequest?: () => void;
	/** The App asked to change its overlay geometry or input region. */
	onConfigureRequest?: (request: AppRuntimeConfigureRequest) => void;
	/** The App reported the pointer while it owns it (overlay rect regions). */
	onPointerState?: (state: { x: number; y: number; down: boolean }) => void;
	onNavigationOpen?: (
		message: AppNavigationOpenMessage,
	) => Promise<
		Omit<
			import("@cohub/protocol/app-navigation").AppNavigationOpenResponse,
			"protocol" | "version" | "type" | "requestId"
		>
	>;
};

const {
	app,
	space = null,
	owner = null,
	content = null,
	totalViews = null,
	mode = "page",
	launchState = null,
	invocation = undefined,
	shell = undefined,
	onSurfaceHost = undefined,
	onComposerChip = undefined,
	onReady = undefined,
	onCloseRequest = undefined,
	onConfigureRequest = undefined,
	onPointerState = undefined,
	onNavigationOpen = undefined,
}: Props = $props();

let frame: HTMLIFrameElement | null = $state(null);
let bridgeReady = $state(false);
let runtimeReady = $state(false);
let frameHasLoaded = $state(false);
let readyReported = false;
let contextSyncWarningReported = false;

function reportReady() {
	if (readyReported) return;
	readyReported = true;
	onReady?.();
}

const isBackground = $derived(mode === "background");
const spaceName = $derived(space?.name || space?.slug || "Space");
const appTitle = $derived(appDisplayTitle(app?.meta, app?.slug ?? "App"));
const publisherName = $derived(owner?.displayName ?? "Cohub");
const publisherAvatarUrl = $derived(owner?.avatarUrl?.trim() || null);
const hideCohubBar = $derived(app?.meta?.presentation?.hideCohubBar === true);
const locale = $derived(getLocale());
const totalViewsText = $derived(
	typeof totalViews === "number" && totalViews > 0
		? formatCompactNumber(totalViews, locale)
		: null,
);
const totalViewsTitle = $derived(
	totalViewsText
		? m.app_stats_total_views_title(
				{ count: formatNumber(totalViews ?? 0, locale) },
				{ locale },
			)
		: "",
);
// Board and file Works render natively; only web and port Works are embedded.
const boardContent = $derived(content?.kind === "board" ? content : null);
const fileContent = $derived(content?.kind === "file" ? content : null);
const workspaceAssetResolver = $derived(
	createSpaceWorkspaceAssetResolver(app.spaceId),
);
const appNavigationEnabled = $derived(Boolean(onNavigationOpen));

/**
 * Native Works (board/file) render markdown in the host, outside the App
 * iframe, so their links need to reach the same navigation bridge the iframe
 * uses instead of falling through to a raw browser navigation.
 */
function openWorkFileLink(target: WorkspaceFileLinkTarget) {
	if (!onNavigationOpen) return;
	void onNavigationOpen(
		buildAppNavigationOpenMessage({
			requestId: crypto.randomUUID(),
			target: {
				kind: "file",
				spaceId: app.spaceId,
				path: target.path,
				...(target.position ? { view: target.position } : {}),
			},
		}),
	);
}

async function openWorkUrlLink(href: string, event: MouseEvent) {
	if (!onNavigationOpen) return;
	let url: URL;
	try {
		url = new URL(href, window.location.href);
	} catch {
		return;
	}
	// External links and non-App routes keep the default browser behavior.
	if (url.origin !== window.location.origin || !url.pathname.includes("/w/")) {
		return;
	}
	event.preventDefault();
	try {
		const result = await onNavigationOpen(
			buildAppNavigationOpenMessage({
				requestId: crypto.randomUUID(),
				target: { kind: "app", ref: url.href },
			}),
		);
		if (!result.handled) window.location.assign(url.href);
	} catch {
		window.location.assign(url.href);
	}
}
const embeddedContent = $derived(
	content && (content.kind === "web" || content.kind === "port")
		? content
		: null,
);
const nativeContent = $derived(boardContent ?? fileContent);
const frameDescriptor = $derived.by(() => {
	if (!app) return null;

	return resolveAppFrame({
		contentUrl:
			embeddedContent?.url ??
			(!content && app.targetType === "port" ? app.targetRef : ""),
		launchState,
		baseHref: page.url.href,
		targetType: app.targetType,
	});
});
const iframeSrc = $derived(frameDescriptor?.url ?? "");
const frameOrigin = $derived(frameDescriptor?.origin ?? null);
const hasFrameSource = $derived(Boolean(frameDescriptor));
const shouldRenderFrame = $derived(
	Boolean(bridgeReady && hasFrameSource && !nativeContent),
);
const frameReplyTarget = $derived(frameOrigin ?? page.url.origin);
// A new document invalidates any announced methods.
$effect(() => {
	void iframeSrc;
	runtimeReady = false;
	frameHasLoaded = false;
	surfaceHost?.reset();
});

const frameSandbox = $derived(
	`allow-scripts allow-same-origin allow-forms allow-popups allow-downloads allow-modals${isBackground ? "" : " allow-pointer-lock"}`,
);
const framePermissions =
	"clipboard-read; clipboard-write; fullscreen; web-share";
const checkoutState = $derived(readAppCheckoutState(page.url));

// `app` and `mode` are constant for the lifetime of this surface (a different
// app remounts the component), so capturing their initial values is intentional.
// `reply`/`getCheckoutState` stay reactive via closures.
const host = untrack(() =>
	createAppBridgeHost({
		app: { ...app, spaceName: space?.name ?? null },
		authorizationContext: { surface: mode },
		invocation,
		getInvocation: () => invocation,
		shell,
		getShell: () => shell,
		notify: (payload) => {
			// Only a ready runtime can receive unsolicited context updates. The
			// iframe may have navigated without changing iframeSrc.
			if (!runtimeReady || !frameOrigin) return;
			frame?.contentWindow?.postMessage(payload, frameReplyTarget);
		},
		reply: (requestId, payload) => {
			if (!frameOrigin) return;
			frame?.contentWindow?.postMessage(
				{ requestId, ...payload },
				frameReplyTarget,
			);
		},
		getCheckoutState: () => checkoutState,
	}),
);

$effect(() => {
	void invocation;
	void shell;
	pushSurfaceContext();
});

// Surface RPC is opt-in: only created when a parent wants to call into the App.
const surfaceHost = untrack(() =>
	onSurfaceHost || onComposerChip
		? createAppSurfaceHost({
				getFrame: () => frame,
				getFrameOrigin: () => frameOrigin,
				onComposerChip,
				syncContext: (nextInvocation) =>
					host.notifyContextChanged(nextInvocation),
			})
		: null,
);

function syncSurfaceContext() {
	return surfaceHost?.syncContext() ?? host.notifyContextChanged();
}

function pushSurfaceContext() {
	void syncSurfaceContext().then(
		() => {
			contextSyncWarningReported = false;
		},
		(cause) => {
			if (contextSyncWarningReported) return;
			contextSyncWarningReported = true;
			console.warn("[app-context] Failed to notify the App.", cause);
		},
	);
}

async function onFrameMessage(event: MessageEvent) {
	if (event.source !== frame?.contentWindow) return;
	if (!frameOrigin || event.origin !== frameOrigin) return;
	if (parseAppRuntimeCloseRequest(event.data)) {
		onCloseRequest?.();
		return;
	}
	const configure = parseAppRuntimeConfigureRequest(event.data);
	if (configure) {
		onConfigureRequest?.(configure);
		return;
	}
	const pointer = parseAppRuntimePointer(event.data);
	if (pointer) {
		onPointerState?.({ x: pointer.x, y: pointer.y, down: pointer.down });
		return;
	}
	const navigation = parseAppNavigationOpenMessage(event.data);
	if (navigation) {
		let result:
			| Omit<
					import("@cohub/protocol/app-navigation").AppNavigationOpenResponse,
					"protocol" | "version" | "type" | "requestId"
			  >
			| undefined;
		try {
			result = onNavigationOpen
				? await onNavigationOpen(navigation)
				: { handled: false as const, reason: "unsupported" as const };
		} catch {
			result = { handled: false as const, reason: "inaccessible" as const };
		}
		frame?.contentWindow?.postMessage(
			buildAppNavigationOpenResponse({
				requestId: navigation.requestId,
				...(result ?? {
					handled: false as const,
					reason: "inaccessible" as const,
				}),
			}),
			frameReplyTarget,
		);
		return;
	}
	if (isBackground) {
		const action = parseNewChatBackgroundAction(event.data);
		if (action) {
			emitSpaceConfigBackgroundAction(action);
			return;
		}
	}
	const readyMessage = parseAppRuntimeReady(event.data);
	if (readyMessage) {
		runtimeReady = true;
		pushSurfaceContext();
		return;
	}
	if (surfaceHost?.handleMessage(event)) return;
	await host.handleMessage(event);
}

onMount(() => {
	window.addEventListener("message", onFrameMessage);
	bridgeReady = true;
	if (nativeContent) queueMicrotask(reportReady);
	onSurfaceHost?.(surfaceHost);
	return () => {
		window.removeEventListener("message", onFrameMessage);
		// Release own resources even if the consumer's unregister throws, so a
		// faulty listener cannot leak this frame's bridge.
		try {
			onSurfaceHost?.(null);
		} finally {
			surfaceHost?.dispose();
		}
	};
});
</script>

<div class="app-surface {mode}">
	{#if boardContent}
		<div class="app-native">
			<WorkBoardSurface content={boardContent} />
		</div>
	{:else if fileContent}
		<div class="app-native">
			<WorkFileSurface
				content={fileContent}
				resolveWorkspaceAsset={workspaceAssetResolver}
				onOpenFile={appNavigationEnabled ? openWorkFileLink : undefined}
				onOpenUrl={appNavigationEnabled ? openWorkUrlLink : undefined}
			/>
		</div>
	{:else if !app}
		<div class="empty-state">Loading App…</div>
	{:else if shouldRenderFrame}
		<iframe
			bind:this={frame}
			class="app-frame"
			class:loading={!frameHasLoaded}
			title={appTitle}
			sandbox={frameSandbox}
			allow={framePermissions}
			allowtransparency={mode === "overlay" ? true : undefined}
			src={iframeSrc}
			onload={() => {
				// load only marks the document as visually ready. Context waits for
				// the new document's runtime handshake.
				// Any App can announce ready before its initial load event. Preserve
				// that handshake; later in-frame navigations must announce again.
				const isFirstLoad = !frameHasLoaded;
				frameHasLoaded = true;
				if (!isFirstLoad) runtimeReady = false;
				surfaceHost?.reset();
				reportReady();
			}}
		></iframe>
	{:else if !hasFrameSource}
		<div class="empty-state">App asset is unavailable.</div>
	{/if}

	{#if mode === "page" && !hideCohubBar}
		<footer class="pointer-events-none fixed inset-x-0 bottom-0 z-50 flex justify-center px-3 pb-3 sm:pb-4">
			<div class="app-bar pointer-events-auto flex h-12 w-full max-w-[860px] items-center gap-3 rounded-lg border border-border-subtle bg-bg-surface/95 px-2.5 text-[11px] text-text-tertiary shadow-lg shadow-bg-primary/15 backdrop-blur-md supports-[not(backdrop-filter:blur(0))]:bg-bg-surface sm:px-3">
				<div class="flex min-w-0 flex-1 items-center gap-2.5 overflow-hidden">
					<img src="/favicon.svg" alt="Cohub" class="block h-5 w-5 shrink-0 rounded-[5px]" />
					<div class="hidden h-4 w-px shrink-0 bg-border-subtle sm:block"></div>
					<div class="flex min-w-0 items-center gap-2 overflow-hidden">
						<SpaceAvatar name={spaceName} profile={space?.publicProfile} size="xs" class="translate-y-0" />
						<span class="min-w-0 truncate font-medium leading-none text-text-secondary">{spaceName}</span>
						<span class="hidden shrink-0 leading-none text-text-tertiary sm:inline">/</span>
						<span class="hidden min-w-0 truncate font-medium leading-none text-text-primary sm:inline">{appTitle}</span>
					</div>
				</div>
				<div class="flex min-w-0 shrink-0 items-center gap-2 overflow-hidden">
					{#if totalViewsText}
						<span class="flex shrink-0 items-center gap-1.5 text-text-tertiary" title={totalViewsTitle}>
							<Eye class="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
							<span class="font-mono leading-none tabular-nums">{totalViewsText}</span>
							<span class="sr-only">{totalViewsTitle}</span>
						</span>
						<div class="hidden h-4 w-px shrink-0 bg-border-subtle sm:block"></div>
					{/if}
					<span class="hidden shrink-0 leading-none text-text-tertiary md:inline">Published by</span>
					<UserIdentity
						name={publisherName}
						avatarUrl={publisherAvatarUrl}
						username={owner?.username}
						size="xs"
						class="min-w-0 text-text-secondary"
						avatarClass="h-5 w-5 rounded-full bg-bg-elevated text-[8px]"
						nameClass="hidden max-w-32 truncate font-medium leading-none sm:inline"
					/>
				</div>
			</div>
		</footer>
	{/if}
</div>


<AppAuthorizeDialog
	open={host.authOpen && !!host.pendingAuth}
	pending={host.pendingAuth}
	error={host.authError}
	saving={host.authSaving}
	appName={appTitle}
	authorName={owner?.displayName}
	selectedSpaceId={host.selectedSpaceId}
	canChangeSpace={host.canChangeSpace}
	onSelectSpace={host.setSelectedSpace}
	onConfirm={(spaceId) => void host.confirmAuth(spaceId)}
	onCancel={host.cancelAuth}
/>

<style>
	.app-surface {
		position: relative;
		overflow: hidden;
		background: var(--bg-content);
		color: var(--text-primary);
	}

	.app-surface.page {
		min-height: 100vh;
	}

	.app-surface.background,
	.app-surface.app,
	.app-surface.overlay {
		width: 100%;
		height: 100%;
	}

	/* App windows and overlays live inside the workspace and own no page chrome. */
	.app-surface.app,
	.app-surface.overlay {
		display: flex;
		min-height: 0;
		flex-direction: column;
	}

	.app-surface.app .app-frame,
	.app-surface.app .app-native,
	.app-surface.overlay .app-frame,
	.app-surface.overlay .app-native {
		flex: 1 1 auto;
		min-height: 0;
	}

	/* An overlay is a transparent layer: the App paints its own pixels. */
	.app-surface.overlay,
	.app-surface.overlay .app-frame {
		background: transparent;
	}

	/* Nothing to see until the App's own document paints; the layer must not flash. */
	.app-surface.overlay .app-frame.loading {
		visibility: hidden;
	}

	.app-frame {
		display: block;
		width: 100%;
		height: 100%;
		border: 0;
		background: var(--bg-primary);
		user-select: none;
	}

	/* Native surfaces own their own scrolling and chrome. */
	.app-native {
		height: 100%;
		min-height: 0;
	}

	.app-surface.page .app-native {
		height: 100vh;
	}

	.app-surface.page .app-frame {
		height: 100vh;
	}

	.empty-state {
		display: flex;
		height: 100%;
		min-height: 220px;
		align-items: center;
		justify-content: center;
		padding: 1.5rem;
		font-size: 0.875rem;
		color: var(--text-tertiary);
	}
</style>
