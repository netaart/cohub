<script lang="ts">
import type { AppNavigationOpenMessage } from "@cohub/protocol/app-navigation";
import type { AppWindowState } from "@cohub/protocol/app-runtime";
import type { AppComposerChip } from "@cohub/protocol/app-surface";
import type { AppRuntimeShellContext } from "@neta-art/cohub";
import { ExternalLink, Loader2, RefreshCw } from "lucide-svelte";
import AppSurface from "$lib/components/app/AppSurface.svelte";
import CenteredLoading from "$lib/components/CenteredLoading.svelte";
import type { AppSurfaceHost } from "$lib/features/app/surface-host";
import { getLocale } from "$lib/i18n/locale.svelte";
import { m } from "$lib/paraglide/messages.js";
import type { InlineAppPreview } from "./app-window-controller.svelte";
import PreviewHeader from "./PreviewHeader.svelte";
import type { PreviewChrome, PreviewHeaderAction } from "./preview-header";
import { previewHeaderVariant } from "./preview-header";
import type { Window } from "./windows";

type Props = {
	preview: InlineAppPreview;
	shell: AppRuntimeShellContext;
	windows: Window[];
	chrome: PreviewChrome;
	isMobile: boolean;
	/** Whether this App is the visible tab. Background tabs mount no chrome. */
	active?: boolean;
	onActivateWindow: (kind: Window["kind"], key: string) => void;
	onCloseWindow: (kind: Window["kind"], key: string) => void;
	onRetry: (key: string) => void;
	onRegisterSurface: (key: string, host: AppSurfaceHost | null) => void;
	onComposerChip: (key: string, chip: AppComposerChip | null) => void;
	onWindowState: (key: string, state: AppWindowState) => void;
	onNavigationOpen?: (message: AppNavigationOpenMessage) => Promise<{
		handled: boolean;
		reason?: "unsupported" | "invalid_target" | "inaccessible" | "timeout";
		call?:
			| { ok: true; result?: unknown }
			| { ok: false; code: string; message: string };
	}>;
};

const {
	preview,
	shell,
	windows,
	chrome,
	isMobile,
	active = true,
	onActivateWindow,
	onCloseWindow,
	onRetry,
	onRegisterSurface,
	onComposerChip,
	onWindowState,
	onNavigationOpen = undefined,
}: Props = $props();

const locale = $derived(getLocale());

const detail = $derived(preview.detail);
const publicUrl = $derived(detail?.publicUrl ?? null);
const immersive = $derived(chrome.immersive);

/** The surface host of the mounted App frame. */
let surfaceHost = $state.raw<AppSurfaceHost | null>(null);

/**
 * The window key the surface is registered under, in a plain local so the
 * frame's callbacks never read a preview that is already gone.
 */
let surfaceKey: string | null = null;

/** Releases only its own host, so a replacement mounted first survives. */
function handleSurfaceHost(host: AppSurfaceHost) {
	surfaceHost = host;
	return () => {
		if (surfaceHost === host) surfaceHost = null;
	};
}

// A renamed file moves its window to a new key; the surface follows it.
$effect(() => {
	const host = surfaceHost;
	const key = preview.key;
	if (!host) return;
	surfaceKey = key;
	onRegisterSurface(key, host);
	return () => onRegisterSurface(key, null);
});

function handleComposerChip(chip: AppComposerChip | null) {
	if (surfaceKey) onComposerChip(surfaceKey, chip);
}

function handleWindowState(state: AppWindowState) {
	if (surfaceKey) onWindowState(surfaceKey, state);
}
const launchState = $derived({
	search: preview.launch?.search ?? "",
	hash: preview.launch?.hash ?? "",
});
const isDisabled = $derived(detail?.app.status === "disabled");

const headerActions = $derived.by((): PreviewHeaderAction[] => {
	const actions: PreviewHeaderAction[] = [
		{
			id: "reload",
			label: m.window_reload_app({}, { locale }),
			icon: RefreshCw,
			primary: true,
			run: () => onRetry(preview.key),
		},
	];
	if (publicUrl) {
		actions.push({
			id: "open-external",
			label: m.window_open_in_new_tab({}, { locale }),
			icon: ExternalLink,
			primary: true,
			run: () => {
				window.open(publicUrl, "_blank", "noopener");
			},
		});
	}
	return actions;
});
</script>

<div class="flex h-full min-w-0 flex-col bg-bg-content">
	{#if active}
		<PreviewHeader
			{windows}
			variant={previewHeaderVariant({ isMobile, immersive })}
			actions={headerActions}
			{chrome}
			onActivate={onActivateWindow}
			onClose={onCloseWindow}
		/>
	{/if}

	<div class="relative min-h-0 flex-1" data-drawer-swipe-ignore>
		{#if preview.error}
			<div class="flex h-full items-center justify-center p-6">
				<div class="max-w-sm text-center">
					<div class="mb-1 text-sm font-medium text-text-primary">{m.app_unavailable({}, { locale })}</div>
					<div class="mb-4 text-xs leading-5 text-text-tertiary">{preview.error}</div>
					<button
						type="button"
						class="inline-flex min-h-8 items-center rounded-[5px] bg-bg-elevated px-3 text-[12px] text-text-secondary transition-colors hover:bg-bg-hover hover:text-text-primary"
						onclick={() => onRetry(preview.key)}
					>
						{m.app_try_again({}, { locale })}
					</button>
				</div>
			</div>
		{:else if !detail}
			<CenteredLoading label={m.app_loading({}, { locale })} size="panel" />
		{:else if !detail.content}
			<div class="flex h-full items-center justify-center p-6 text-center text-xs leading-5 text-text-tertiary">
				{isDisabled
					? m.app_disabled_no_content({}, { locale })
					: m.app_no_content({}, { locale })}
			</div>
		{:else}
			{#key preview.mountKey}
				<AppSurface
					mode="app"
					app={detail.app}
					space={detail.space}
					owner={detail.owner}
					content={detail.content}
					{launchState}
					invocation={preview.invocation}
					{shell}
					visible={active}
					onWindowState={handleWindowState}
					onSurfaceHost={handleSurfaceHost}
					onComposerChip={handleComposerChip}
					onNavigationOpen={onNavigationOpen}
					onCloseRequest={() => onCloseWindow("app", preview.key)}
				/>
			{/key}
		{/if}
		{#if preview.loading && detail}
			<div class="pointer-events-none absolute right-2 top-2 z-10 inline-flex items-center gap-1.5 rounded-md border border-border-subtle bg-bg-content/95 px-2 py-1 text-[11px] text-text-tertiary">
				<Loader2 class="h-3 w-3 animate-spin" />
				<span>{m.app_refreshing({}, { locale })}</span>
			</div>
		{/if}
		{#if preview.refreshError && detail}
			<div class="absolute bottom-2 left-2 right-2 z-10 flex items-center gap-2 rounded-md border border-error-soft/30 bg-bg-content/95 px-2.5 py-1.5 text-[11px] text-error-soft shadow-sm">
				<span class="min-w-0 flex-1 truncate">{preview.refreshError}</span>
				<button
					type="button"
					class="shrink-0 text-text-secondary underline underline-offset-2 hover:text-text-primary"
					onclick={() => onRetry(preview.key)}
				>
					Retry
				</button>
			</div>
		{/if}
	</div>
</div>
