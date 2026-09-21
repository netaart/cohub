<script lang="ts">
import type {
	AppDetailResponse,
	AppRuntimeInvocationContext,
	AppRuntimeShellContext,
	PublicAppVersionSummary,
} from "@neta-art/cohub";
import { onMount, untrack } from "svelte";
import { replaceState } from "$app/navigation";
import { page } from "$app/state";
import { buildAppPageMeta } from "$lib/app-page-meta";
import { reportAppPromotionReady, startAppPromotion } from "$lib/app-promotion";
import AppPageHead from "$lib/components/app/AppPageHead.svelte";
import AppSurface from "$lib/components/app/AppSurface.svelte";
import AppVersionBar from "$lib/components/app/AppVersionBar.svelte";
import {
	type AppEmbedConnection,
	type AppEmbedState,
	connectAppEmbed,
	isServedFrom,
	resolveEmbedderOrigin,
} from "$lib/features/app/app-embed";
import { loadAppPreview } from "$lib/features/app/app-open";
import { sdk } from "$lib/sdk";

type ReadyView = {
	app: AppDetailResponse["app"];
	space: AppDetailResponse["space"];
	owner: AppDetailResponse["owner"];
	publisher: AppDetailResponse["publisher"];
	content: AppDetailResponse["content"];
	publicUrl: AppDetailResponse["publicUrl"];
	totalViews: number | null;
	version: PublicAppVersionSummary | null;
	pathname: string;
	origin: string;
};

type ReadyData = ReadyView & {
	mode: "ready";
	requestedVersion: number | null;
};

type ClientData = {
	mode: "client";
	pathname: string;
	origin: string;
	username: string;
	spaceSlug: string;
	appSlug: string;
	requestedVersion: number | null;
};

const props = $props<{ data: ReadyData | ClientData }>();

const launchState = $derived({
	search: page.url.search,
	hash: page.url.hash,
});

/**
 * Displayed version; `null` is the current version. Driven by local state, not
 * `page.url`: `replaceState` rewrites the address bar without updating
 * `page.url`, so URL-derived reactivity would never fire on a switch.
 */
let selectedVersion = $state<number | null>(
	untrack(() => props.data.requestedVersion ?? null),
);

let clientDetail = $state<AppDetailResponse | null>(null);
let clientError = $state("");
let clientLoading = $state(false);
/** Client-side version override, set when the switcher changes the URL. */
let versionDetail = $state<AppDetailResponse | null>(null);
let versions = $state<PublicAppVersionSummary[]>([]);
/** True while the selected version's content is being fetched. */
let switching = $state(false);
/** Version the on-screen content corresponds to; used to recover a failed switch. */
let resolvedVersionParam: number | null = null;
/** AppSurface uses window/postMessage; mount only after hydration. */
let surfaceReady = $state(false);
let surfaceLoaded = false;
let promotionReadyReported = false;
let promotionRuntime: ReturnType<typeof startAppPromotion> | null = null;
let activePromotionKey = "";
/**
 * Another App embeds this page. Its hints shape the embedded App's shell and
 * invocation context only; identity and grants stay in the local bridge.
 */
let embed = $state<AppEmbedState | null>(null);
let embedder = $state<{ appId: string; slug: string } | null>(null);
let embedConnection = $state<AppEmbedConnection | null>(null);

/**
 * Shell hints arrive over postMessage and are only navigation context. They
 * become usable only once the embedder proved it is the App served from that
 * frame origin, so an unrelated page cannot hand this one a fabricated Space
 * and have it treated as a current Shell.
 */
const trustedEmbed = $derived(embed && embedder ? embed : null);

const shell = $derived<AppRuntimeShellContext | undefined>(
	trustedEmbed
		? {
				surface: "embed",
				...(trustedEmbed.shell ?? { space: null, session: null, turn: null }),
			}
		: undefined,
);
const invocation = $derived<AppRuntimeInvocationContext | undefined>(
	trustedEmbed
		? {
				surface: "page",
				source: "embed",
				// `embedder` is backed by Svelte state. Rebuild the nested value so
				// the bridge only ever receives structured-cloneable data.
				...(embedder
					? {
							embedder: {
								appId: embedder.appId,
								slug: embedder.slug,
							},
						}
					: {}),
				...(trustedEmbed?.shell?.space
					? { spaceId: trustedEmbed.shell.space.id }
					: {}),
				...(trustedEmbed?.shell?.session
					? { sessionId: trustedEmbed.shell.session.id }
					: {}),
				...(trustedEmbed?.shell?.turn
					? { turnId: trustedEmbed.shell.turn.id }
					: {}),
			}
		: undefined,
);

const embedderOrigin = resolveEmbedderOrigin();

$effect(() => {
	if (!surfaceReady || !embedderOrigin) return;
	embedConnection = connectAppEmbed(embedderOrigin, (state) => {
		embed = state;
	});
	return () => {
		embedConnection?.dispose();
		embedConnection = null;
		embed = null;
	};
});

// The embedder names itself by id. It is trusted only when that App's content
// is served from the frame origin that sent the hint.
const embedderAppId = $derived(embed?.embedder.appId ?? null);
$effect(() => {
	const appId = embedderAppId;
	embedder = null;
	if (!appId || !embedderOrigin) return;
	let cancelled = false;
	void loadAppPreview(sdk.apps, appId).then(
		({ app, content }) => {
			if (!cancelled && isServedFrom(content, embedderOrigin))
				embedder = { appId: app.id, slug: app.slug };
		},
		() => undefined,
	);
	return () => {
		cancelled = true;
	};
});

function handleCloseRequest() {
	if (embedConnection) return embedConnection.requestClose();
	// Browsers only let scripts close tabs they opened; otherwise leave the App,
	// which may land outside Cohub when this page was the entry point.
	window.close();
	if (!window.closed) history.back();
}

const promotionId = $derived(page.url.searchParams.get("cohub_campaign"));

function maybeReportPromotionReady() {
	if (
		!surfaceLoaded ||
		promotionReadyReported ||
		!promotionRuntime ||
		!promotionId ||
		!ready
	)
		return;
	const appId = ready.app.id;
	promotionReadyReported = true;
	void promotionRuntime
		.then((runtime) => reportAppPromotionReady(appId, promotionId, runtime))
		.catch(() => undefined);
}

function handleSurfaceReady() {
	surfaceLoaded = true;
	maybeReportPromotionReady();
}

function toReadyView(
	detail: AppDetailResponse,
	pathname: string,
	origin: string,
): ReadyView {
	return {
		app: detail.app,
		space: detail.space,
		owner: detail.owner,
		publisher: detail.publisher,
		content: detail.content,
		publicUrl: detail.publicUrl,
		totalViews: detail.totalViews ?? null,
		version: detail.version ?? null,
		pathname,
		origin,
	};
}

const ready = $derived<ReadyView | null>(
	versionDetail
		? toReadyView(versionDetail, props.data.pathname, props.data.origin)
		: props.data.mode === "ready"
			? props.data
			: clientDetail
				? toReadyView(clientDetail, props.data.pathname, props.data.origin)
				: null,
);

const pageMeta = $derived(
	ready
		? buildAppPageMeta(
				{
					app: ready.app,
					space: ready.space,
					owner: ready.owner,
					publicUrl: ready.publicUrl,
					contentUrl: ready.content?.url ?? null,
					contentKind:
						ready.content?.kind === "web" || ready.content?.kind === "port"
							? ready.content.kind
							: null,
				},
				{ origin: ready.origin, path: ready.pathname },
			)
		: buildAppPageMeta(null, {
				origin: props.data.origin,
				path: props.data.pathname,
				// Auth-gated shell must not be indexed before client resolution.
				indexable: false,
			}),
);

onMount(() => {
	surfaceReady = true;
});

$effect(() => {
	if (!surfaceReady || !promotionId || !ready) return;
	const key = `${ready.app.id}:${promotionId}`;
	if (activePromotionKey === key) return;
	activePromotionKey = key;
	promotionReadyReported = false;
	promotionRuntime = startAppPromotion(ready.app.id, promotionId);
	promotionRuntime.catch(() => undefined);
	maybeReportPromotionReady();
});

/** A real route load (initial or navigation) invalidates the version override. */
$effect(() => {
	void props.data.pathname;
	void props.data.requestedVersion;
	const version = props.data.requestedVersion ?? null;
	versionDetail = null;
	selectedVersion = version;
	resolvedVersionParam = version;
});

// Version history is secondary chrome: fetch it after hydration, and only for
// apps that actually have history, so the SSR critical path stays a single
// request. The browser request carries the caller's identity, so member-only
// session provenance is available without a server-side refresh.
$effect(() => {
	const data = props.data;
	const latestVersion =
		data.mode === "ready"
			? data.app.latestVersion
			: (clientDetail?.app.latestVersion ?? 0);
	if (latestVersion <= 1) {
		versions = [];
		return;
	}
	const identity =
		data.mode === "ready"
			? {
					username: data.owner.username,
					spaceSlug: data.space.slug ?? "",
					appSlug: data.app.slug,
				}
			: {
					username: data.username,
					spaceSlug: data.spaceSlug,
					appSlug: data.appSlug,
				};
	if (!identity.username || !identity.spaceSlug || !identity.appSlug) return;
	let cancelled = false;
	void sdk.apps
		.listPublicVersions(identity.username, identity.spaceSlug, identity.appSlug)
		.then((result) => {
			if (!cancelled) versions = result.versions;
		})
		.catch(() => undefined);
	return () => {
		cancelled = true;
	};
});

// Initial detail for the auth-gated client shell. The version switcher handles
// later changes through the override effect below, so this runs once per load.
$effect(() => {
	if (props.data.mode !== "client") {
		clientDetail = null;
		clientError = "";
		clientLoading = false;
		return;
	}
	const {
		username,
		spaceSlug,
		appSlug,
		requestedVersion: version,
	} = props.data;
	let cancelled = false;
	clientLoading = true;
	clientError = "";
	clientDetail = null;
	void sdk.apps
		.getBySlug(username, spaceSlug, appSlug, {
			version: version ?? undefined,
		})
		.then((detail) => {
			if (!cancelled) {
				clientDetail = detail;
				clientLoading = false;
			}
		})
		.catch((err: unknown) => {
			if (cancelled) return;
			clientLoading = false;
			const status =
				err && typeof err === "object" && "status" in err
					? Number((err as { status?: unknown }).status)
					: 0;
			clientError =
				status === 401
					? "Sign in to view this App."
					: status === 403 || status === 404
						? "App not found."
						: "Failed to load this App.";
		});
	return () => {
		cancelled = true;
	};
});

// The switcher changes the URL without re-running load, so fetch the selected
// version here. Matching the loaded version restores the server's payload.
$effect(() => {
	const version = selectedVersion;
	if (version === (props.data.requestedVersion ?? null)) {
		versionDetail = null;
		resolvedVersionParam = version;
		switching = false;
		return;
	}
	const { username, spaceSlug, appSlug } = page.params;
	if (!username || !spaceSlug || !appSlug) {
		switching = false;
		return;
	}
	const controller = new AbortController();
	switching = true;
	void sdk.apps
		.getBySlug(username, spaceSlug, appSlug, {
			version: version ?? undefined,
			signal: controller.signal,
		})
		.then((detail) => {
			if (controller.signal.aborted) return;
			versionDetail = detail;
			resolvedVersionParam = version;
		})
		.catch(() => {
			if (controller.signal.aborted) return;
			// Keep the address bar honest: fall back to the version on screen.
			const url = new URL(window.location.href);
			if (resolvedVersionParam === null) url.searchParams.delete("cohub_v");
			else url.searchParams.set("cohub_v", String(resolvedVersionParam));
			replaceState(url, {});
		})
		.finally(() => {
			if (!controller.signal.aborted) switching = false;
		});
	return () => {
		controller.abort();
	};
});

function handleSelectVersion(version: number | null) {
	if (version === selectedVersion) return;
	selectedVersion = version;
	// Read `location` directly: `page.url` is stale after `replaceState`.
	const url = new URL(window.location.href);
	if (version === null) url.searchParams.delete("cohub_v");
	else url.searchParams.set("cohub_v", String(version));
	replaceState(url, {});
}
</script>

<AppPageHead meta={pageMeta} />

{#snippet versionBar()}
	<AppVersionBar
		{versions}
		spaceId={ready?.space.id ?? ""}
		selectedVersion={selectedVersion}
		latestVersion={ready?.app.latestVersion ?? 0}
		loading={switching}
		onSelect={handleSelectVersion}
	/>
{/snippet}

{#if ready && surfaceReady}
	<AppSurface
		app={ready.app}
		space={ready.space}
		owner={ready.owner}
		publisher={ready.publisher}
		content={ready.content}
		totalViews={ready.totalViews}
		{launchState}
		{shell}
		{invocation}
		barActions={versions.length > 1 ? versionBar : undefined}
		onCloseRequest={handleCloseRequest}
		onReady={handleSurfaceReady}
	/>
{:else if ready}
	<!-- SSR / first paint: head already has share meta; surface hydrates client-side. -->
	<div class="h-full bg-bg-primary" aria-hidden="true"></div>
{:else if clientLoading}
	<div
		class="flex h-full items-center justify-center bg-bg-primary px-4 text-[13px] text-text-tertiary"
	>
		Loading App…
	</div>
{:else}
	<div
		class="flex h-full items-center justify-center bg-bg-primary px-4 text-[13px] text-text-secondary"
	>
		{clientError || "App is unavailable."}
	</div>
{/if}
