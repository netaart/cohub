<script lang="ts">
import type {
	AppNavigationOpenMessage,
	AppNavigationOpenResponse,
} from "@cohub/protocol/app-navigation";
import type { AppComposerChip } from "@cohub/protocol/app-surface";
import { MEDIA_VARIANT_MAX } from "@neta-art/cohub/media";
import { page } from "$app/state";
import { type CohubAppUrl, parseCohubAppUrl } from "$lib/app-url";
import NewChatAppBackground from "$lib/components/NewChatAppBackground.svelte";
import NewChatBoardBackground from "$lib/components/NewChatBoardBackground.svelte";
import NewChatSpaceBackground from "$lib/components/NewChatSpaceBackground.svelte";
import { getLocale } from "$lib/i18n/locale.svelte";
import { parseNewChatBackgroundAction } from "$lib/new-chat-background-bridge";
import { m } from "$lib/paraglide/messages.js";
import MediaVideo from "$lib/resource-kit/MediaVideo.svelte";
import type { NewChatBackgroundConfig } from "$lib/space-config";
import { emitSpaceConfigBackgroundAction } from "$lib/space-config";
import { isDecorativeNewChatBackground } from "$lib/space-config-parse";

type Props = {
	background: NewChatBackgroundConfig;
	/** Current Space, used to serve space-local file backgrounds. */
	spaceId?: string | null;
	chromeHeight?: number;
	onAppComposerChip?: (appId: string, chip: AppComposerChip | null) => void;
	onNavigationOpen?: (
		message: AppNavigationOpenMessage,
	) => Promise<
		Omit<
			AppNavigationOpenResponse,
			"protocol" | "version" | "type" | "requestId"
		>
	>;
};

const {
	background,
	spaceId = null,
	chromeHeight = 0,
	onAppComposerChip,
	onNavigationOpen,
}: Props = $props();

const locale = $derived(getLocale());

const externalUrl = $derived(
	background.source.kind === "url" ? background.source.url : null,
);
const spacePath = $derived(
	background.type === "html" && background.source.kind === "space"
		? background.source.path
		: null,
);

const objectFit = $derived(background.fit === "fill" ? "fill" : background.fit);
let iframeEl = $state<HTMLIFrameElement | null>(null);

// An html background is a live document with focusable controls, so it must
// stay in the accessibility tree; only image/video are safe to hide.
const decorative = $derived(isDecorativeNewChatBackground(background));

function getBackgroundOrigin() {
	if (!externalUrl) return null;
	try {
		return new URL(externalUrl, page.url.href).origin;
	} catch {
		return null;
	}
}

// Memoize by origin+pathname so ?preview= changes don't produce a new
// object identity and trigger a guide refetch.
let appUrlKey = "";
let appUrlCache: CohubAppUrl | null = null;
const appUrl = $derived.by((): CohubAppUrl | null => {
	if (background.type !== "html" || !externalUrl) return null;
	const key = `${externalUrl}|${page.url.origin}${page.url.pathname}`;
	if (key === appUrlKey) return appUrlCache;
	appUrlKey = key;
	appUrlCache = parseCohubAppUrl(
		externalUrl,
		`${page.url.origin}${page.url.pathname}`,
	);
	return appUrlCache;
});

const sandbox = $derived.by(() => {
	if (background.type !== "html" || !externalUrl || appUrl) return undefined;
	const origin = getBackgroundOrigin();
	if (typeof window !== "undefined" && origin === window.location.origin) {
		return "allow-scripts";
	}
	return "allow-scripts allow-same-origin";
});

$effect(() => {
	if (typeof document === "undefined") return;
	if (background.type !== "html" || !externalUrl || appUrl) return;
	const origin = getBackgroundOrigin();
	if (!origin) return;
	const link = document.createElement("link");
	link.rel = "preconnect";
	link.href = origin;
	link.crossOrigin = "anonymous";
	document.head.append(link);
	return () => link.remove();
});

function handleMessage(event: MessageEvent) {
	if (background.type !== "html" || !externalUrl || appUrl) return;
	if (event.source !== iframeEl?.contentWindow) return;
	const origin = getBackgroundOrigin();
	if (!origin) return;
	if (event.origin !== origin && event.origin !== "null") return;
	const payload = parseNewChatBackgroundAction(event.data);
	if (!payload) return;
	emitSpaceConfigBackgroundAction(payload);
}

function handleWorkBackgroundError(error: unknown) {
	console.warn("[NewChatBackground] work background failed", error);
}

$effect(() => {
	if (
		typeof window === "undefined" ||
		background.type !== "html" ||
		!externalUrl ||
		appUrl
	)
		return;
	window.addEventListener("message", handleMessage);
	return () => window.removeEventListener("message", handleMessage);
});
</script>

<div
  class="new-chat-background"
  class:board={background.type === "board"}
  style:opacity={background.opacity}
  style:padding-bottom={background.type === "board" ? `${chromeHeight}px` : undefined}
  aria-hidden={decorative ? "true" : undefined}
>
  {#if background.type === "image"}
    <img src={background.source.url} alt="" style:object-fit={objectFit} style:object-position={background.position} draggable="false" />
  {:else if background.type === "video"}
    <MediaVideo src={background.source.url} size={MEDIA_VARIANT_MAX} style="object-fit: {objectFit}; object-position: {background.position}" autoplay muted loop playsinline preload="metadata" />
  {:else if background.type === "board"}
    {#if spaceId}
      <NewChatBoardBackground
        {spaceId}
        path={background.source.path}
        launch={background.source.launch}
        {onNavigationOpen}
      />
    {/if}
  {:else if spacePath && spaceId}
    <NewChatSpaceBackground spaceId={spaceId} path={spacePath} />
  {:else if appUrl}
    <svelte:boundary onerror={handleWorkBackgroundError}>
      <NewChatAppBackground
        appUrl={appUrl}
        currentSpaceId={spaceId}
        onComposerChip={onAppComposerChip}
        onNavigationOpen={onNavigationOpen}
      />
      {#snippet failed()}
        <div class="new-chat-background-state">{m.newchat_bg_app_unavailable({}, { locale })}</div>
      {/snippet}
    </svelte:boundary>
  {:else if externalUrl}
    <iframe bind:this={iframeEl} src={externalUrl} title={m.newchat_bg_title({}, { locale })} sandbox={sandbox} referrerpolicy="no-referrer" loading="eager"></iframe>
  {:else}
    <div class="new-chat-background-state">{m.newchat_bg_unavailable({}, { locale })}</div>
  {/if}
</div>

<style>
  .new-chat-background {
    position: absolute;
    inset: 0;
    z-index: 0;
    overflow: hidden;
    background: var(--bg-content);
    pointer-events: auto;
  }

  .new-chat-background:not(.board)::after {
    content: "";
    position: absolute;
    right: 0;
    bottom: 0;
    left: 0;
    height: min(22dvh, 160px);
    background: linear-gradient(
      to top,
      color-mix(in srgb, var(--bg-content) 82%, transparent) 0%,
      color-mix(in srgb, var(--bg-content) 40%, transparent) 50%,
      transparent 100%
    );
    pointer-events: none;
  }

  img,
  .new-chat-background > :global(video),
  iframe,
  :global(.new-chat-background > svelte-boundary) {
    display: block;
    width: 100%;
    height: 100%;
    border: 0;
    user-select: none;
  }

  .new-chat-background-state {
    display: flex;
    width: 100%;
    height: 100%;
    align-items: center;
    justify-content: center;
    background: var(--bg-content);
    font-size: 0.875rem;
    color: var(--text-tertiary);
  }

  img,
  .new-chat-background > :global(video) {
    pointer-events: none;
  }
</style>
