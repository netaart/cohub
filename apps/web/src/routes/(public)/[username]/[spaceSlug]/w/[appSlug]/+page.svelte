<script lang="ts">
import type {
	AppDetailResponse,
	AppRuntimeInvocationContext,
	AppRuntimeShellContext,
} from "@neta-art/cohub";
import { onMount } from "svelte";
import { page } from "$app/state";
import { buildAppPageMeta } from "$lib/app-page-meta";
import { reportAppPromotionReady, startAppPromotion } from "$lib/app-promotion";
import AppPageHead from "$lib/components/app/AppPageHead.svelte";
import AppSurface from "$lib/components/app/AppSurface.svelte";
import {
	type AppEmbedConnection,
	type AppEmbedState,
	connectAppEmbed,
	isServedFrom,
	resolveEmbedderOrigin,
} from "$lib/features/app/app-embed";
import { loadAppPreview } from "$lib/features/app/app-open";
import { sdk } from "$lib/sdk";

type ReadyData = {
	mode: "ready";
	app: AppDetailResponse["app"];
	space: AppDetailResponse["space"];
	owner: AppDetailResponse["owner"];
	content: AppDetailResponse["content"];
	publicUrl: AppDetailResponse["publicUrl"];
	totalViews: number | null;
	pathname: string;
	origin: string;
};

type ClientData = {
	mode: "client";
	pathname: string;
	origin: string;
	username: string;
	spaceSlug: string;
	appSlug: string;
};

const props = $props<{ data: ReadyData | ClientData }>();

const launchState = $derived({
	search: page.url.search,
	hash: page.url.hash,
});

let clientDetail = $state<AppDetailResponse | null>(null);
let clientError = $state("");
let clientLoading = $state(false);
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
let embedConnection: AppEmbedConnection | null = null;

const shell = $derived<AppRuntimeShellContext | undefined>(
	embed
		? {
				surface: "embed",
				...(embed.shell ?? { space: null, session: null, turn: null }),
			}
		: undefined,
);
const invocation = $derived<AppRuntimeInvocationContext | undefined>(
	embed
		? {
				surface: "page",
				source: "embed",
				...(embedder ? { embedder } : {}),
				...(embed.shell?.space ? { spaceId: embed.shell.space.id } : {}),
				...(embed.shell?.session ? { sessionId: embed.shell.session.id } : {}),
				...(embed.shell?.turn ? { turnId: embed.shell.turn.id } : {}),
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

const ready = $derived(
	props.data.mode === "ready"
		? props.data
		: clientDetail
			? {
					mode: "ready" as const,
					app: clientDetail.app,
					space: clientDetail.space,
					owner: clientDetail.owner,
					content: clientDetail.content,
					publicUrl: clientDetail.publicUrl,
					totalViews: clientDetail.totalViews ?? null,
					pathname: props.data.pathname,
					origin: props.data.origin,
				}
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

$effect(() => {
	if (props.data.mode !== "client") {
		clientDetail = null;
		clientError = "";
		clientLoading = false;
		return;
	}
	const { username, spaceSlug, appSlug } = props.data;
	let cancelled = false;
	clientLoading = true;
	clientError = "";
	clientDetail = null;
	void sdk.apps
		.getBySlug(username, spaceSlug, appSlug)
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
</script>

<AppPageHead meta={pageMeta} />

{#if ready && surfaceReady}
	<AppSurface
		app={ready.app}
		space={ready.space}
		owner={ready.owner}
		content={ready.content}
		totalViews={ready.totalViews}
		{launchState}
		{shell}
		{invocation}
		onCloseRequest={handleCloseRequest}
		onReady={handleSurfaceReady}
	/>
{:else if ready}
	<!-- SSR / first paint: head already has share meta; surface hydrates client-side. -->
	<div class="min-h-screen bg-bg-primary" aria-hidden="true"></div>
{:else if clientLoading}
	<div
		class="flex min-h-screen items-center justify-center bg-bg-primary px-4 text-[13px] text-text-tertiary"
	>
		Loading App…
	</div>
{:else}
	<div
		class="flex min-h-screen items-center justify-center bg-bg-primary px-4 text-[13px] text-text-secondary"
	>
		{clientError || "App is unavailable."}
	</div>
{/if}
