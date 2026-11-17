<script lang="ts">
import { untrack } from "svelte";
import { getLocale } from "#lib/i18n/locale.svelte.ts";
import { parseNewChatBackgroundAction } from "#lib/new-chat-background-bridge.ts";
import { m } from "#lib/paraglide/messages.js";
import { emitSpaceConfigBackgroundAction } from "#lib/space-config.ts";
import {
	createSpacePreviewSessionController,
	type SpacePreviewTarget,
} from "#lib/space-preview-session.svelte.ts";
import { PUBLIC_PREVIEW_ORIGIN } from "$app/env/public";

type Props = {
	spaceId: string;
	/** Space-relative file path, e.g. `onboarding/index.html`. */
	path: string;
};

const { spaceId, path }: Props = $props();

const locale = $derived(getLocale());
const previewOrigin = PUBLIC_PREVIEW_ORIGIN?.replace(/\/+$/, "") ?? "";
let frame = $state<HTMLIFrameElement | null>(null);

const canPreview = $derived(Boolean(previewOrigin && spaceId && path));
const previewKey = $derived(`${previewOrigin}:${spaceId}:${path}`);
const previewSession = createSpacePreviewSessionController({
	getTarget: (): SpacePreviewTarget | null =>
		canPreview ? { origin: previewOrigin, spaceId, path } : null,
	errorMessage: () => m.preview_background_failed({}, { locale }),
});

function handleFrameMessage(event: MessageEvent) {
	if (event.source !== frame?.contentWindow) return;
	if (event.origin !== previewOrigin) return;
	const action = parseNewChatBackgroundAction(event.data);
	if (action) emitSpaceConfigBackgroundAction(action);
}

$effect(() => {
	previewKey;
	void untrack(() => previewSession.reset());
	return previewSession.stop;
});

$effect(() => {
	window.addEventListener("message", handleFrameMessage);
	return () => window.removeEventListener("message", handleFrameMessage);
});
</script>

{#if previewSession.error}
	<div class="new-chat-space-state">{previewSession.error}</div>
{:else if previewSession.src}
	<iframe
		bind:this={frame}
		title="New chat content"
		sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-downloads allow-modals"
		referrerpolicy="no-referrer"
		loading="eager"
		src={previewSession.src}
	></iframe>
{:else}
	<div class="new-chat-space-state" aria-hidden="true"></div>
{/if}

<style>
	iframe {
		display: block;
		width: 100%;
		height: 100%;
		border: 0;
		user-select: none;
	}
	.new-chat-space-state {
		display: flex;
		width: 100%;
		height: 100%;
		align-items: center;
		justify-content: center;
		background: var(--bg-content);
		font-size: 0.875rem;
		color: var(--text-tertiary);
	}
</style>
