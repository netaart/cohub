<script lang="ts">
import type { SpacePortStatus } from "@cohub/protocol/ports";
import {
	Check,
	Copy,
	ExternalLink,
	Globe,
	Loader2,
	RefreshCw,
	Rocket,
} from "lucide-svelte";
import { onDestroy } from "svelte";
import type { PreviewCaptureTarget } from "#lib/features/preview-mark/index.ts";
import PreviewMarkHost from "#lib/features/preview-mark/ui/PreviewMarkHost.svelte";
import PreviewHeader from "#lib/features/space/modules/PreviewHeader.svelte";
import type {
	PreviewChrome,
	PreviewHeaderAction,
} from "#lib/features/space/modules/preview-header.ts";
import type { Window } from "#lib/features/space/modules/windows.ts";
import { toIntlTag } from "#lib/i18n/format.ts";
import { getLocale } from "#lib/i18n/locale.svelte.ts";
import { m } from "#lib/paraglide/messages.js";

const {
	port,
	url,
	status = "unknown",
	observedAt,
	windows = [],
	chrome,
	isMobile,
	onActivateWindow,
	onCloseWindow,
	onPublish,
}: {
	port: string;
	url: string;
	status?: SpacePortStatus | "unknown";
	observedAt?: number;
	windows?: Window[];
	chrome: PreviewChrome;
	isMobile: boolean;
	onActivateWindow?: (kind: Window["kind"], key: string) => void;
	onCloseWindow?: (kind: Window["kind"], key: string) => void;
	onPublish?: () => void;
} = $props();

const locale = $derived(getLocale());

let frameVersion = $state(0);
let loading = $state(true);
let copied = $state(false);
let copiedTimer: ReturnType<typeof setTimeout> | null = null;
let loadTimer: ReturnType<typeof setTimeout> | null = null;
let slowLoad = $state(false);
// Keep the last successfully embedded URL so status/observedAt-only updates
// (or parent re-renders during panel resize) do not remount the iframe.
let committedUrl = $state("");
let iframeEl: HTMLIFrameElement | null = $state(null);
let markOpen = $state(false);

const markTarget = $derived.by((): PreviewCaptureTarget | null => {
	if (!iframeEl || !url) return null;
	return {
		kind: "iframe",
		element: iframeEl,
		source: { kind: "port", port, url },
	};
});

const canEmbed = $derived(status !== "closed" && Boolean(url));
const iframeSrc = $derived.by(() => {
	const base = committedUrl || url;
	if (!base) return "";
	return `${base}${base.includes("?") ? "&" : "?"}__cohub_preview=${frameVersion}`;
});

$effect(() => {
	if (!url) {
		if (committedUrl) committedUrl = "";
		return;
	}
	// Only adopt a new base URL when the public endpoint actually changes.
	if (committedUrl === url) return;
	committedUrl = url;
	loading = true;
	slowLoad = false;
});
const statusLabel = $derived.by(() => {
	if (status === "listening") return m.port_listening({}, { locale });
	if (status === "closed") return m.port_closed({}, { locale });
	return m.port_detecting({}, { locale });
});
const observedLabel = $derived.by(() => {
	if (!observedAt) return "";
	const date = new Date(observedAt);
	if (Number.isNaN(date.getTime())) return "";
	return new Intl.DateTimeFormat(toIntlTag(locale), {
		hour: "2-digit",
		minute: "2-digit",
	}).format(date);
});

function refresh() {
	if (!url) return;
	loading = true;
	slowLoad = false;
	frameVersion += 1;
}

async function copyUrl() {
	if (!url) return;
	await navigator.clipboard.writeText(url);
	copied = true;
	if (copiedTimer) clearTimeout(copiedTimer);
	copiedTimer = setTimeout(() => {
		copied = false;
	}, 1500);
}

const headerActions = $derived.by((): PreviewHeaderAction[] => {
	const list: PreviewHeaderAction[] = [
		{
			id: "refresh",
			label: m.port_refresh({}, { locale }),
			icon: RefreshCw,
			primary: true,
			disabled: !url,
			run: refresh,
		},
		{
			id: "open-external",
			label: m.port_open_external({}, { locale }),
			icon: ExternalLink,
			primary: true,
			disabled: !url,
			run: () => {
				if (url) window.open(url, "_blank", "noreferrer");
			},
		},
		{
			id: "copy-url",
			label: m.port_copy_url({}, { locale }),
			icon: copied ? Check : Copy,
			disabled: !url,
			run: () => copyUrl(),
		},
	];
	if (onPublish) {
		list.push({
			id: "publish",
			label: m.port_publish({}, { locale }),
			icon: Rocket,
			disabled: !url,
			run: () => onPublish?.(),
		});
	}
	return list;
});

$effect(() => {
	// Only restart the loading indicator when the embeddable src identity changes.
	const src = iframeSrc;
	const embeddable = canEmbed;
	if (!embeddable || !src) {
		loading = false;
		slowLoad = false;
		return;
	}
	loading = true;
	slowLoad = false;
	if (loadTimer) clearTimeout(loadTimer);
	loadTimer = setTimeout(() => {
		slowLoad = true;
	}, 4500);
	return () => {
		if (loadTimer) clearTimeout(loadTimer);
	};
});

onDestroy(() => {
	if (copiedTimer) clearTimeout(copiedTimer);
	if (loadTimer) clearTimeout(loadTimer);
});
</script>

<div class="port-preview relative flex h-full min-w-0 flex-col bg-bg-content">
	<PreviewHeader
		{windows}
		variant={isMobile ? "mobile" : "dock"}
		actions={headerActions}
		{chrome}
		onActivate={onActivateWindow ?? (() => {})}
		onClose={onCloseWindow ?? (() => {})}
	>
		{#snippet controls()}
			<span
				class="port-status-dot {status === 'listening'
					? 'is-listening'
					: status === 'closed'
						? 'is-closed'
						: ''}"
				title={statusLabel}
			></span>
			{#if observedLabel}
				<span class="port-observed hidden sm:inline">{observedLabel}</span>
			{/if}
			{#if canEmbed}
				<PreviewMarkHost bind:open={markOpen} target={markTarget} />
			{/if}
		{/snippet}
	</PreviewHeader>

	{#if status === "closed"}
		<div class="flex min-h-0 flex-1 items-center justify-center p-6">
			<div class="max-w-sm text-center">
				<div class="mx-auto mb-3 flex h-10 w-10 items-center justify-center rounded-lg border border-border-subtle bg-bg-surface text-text-tertiary">
					<Globe class="h-5 w-5" />
				</div>
				<div class="mb-1 text-sm font-medium text-text-primary">{m.port_closed_title({ port }, { locale })}</div>
				<div class="mb-4 text-xs leading-5 text-text-tertiary">{m.port_closed_hint({}, { locale })}</div>
				<div class="flex items-center justify-center gap-2">
					<button type="button" class="secondary-key" onclick={refresh}>{m.files_refresh({}, { locale })}</button>
					<a class="primary-key" href={url} target="_blank" rel="noreferrer">{m.port_open_external({}, { locale })}</a>
				</div>
			</div>
		</div>
	{:else if url && iframeSrc}
		<div class="relative min-h-0 flex-1 bg-bg-primary" data-drawer-swipe-ignore>
			{#if loading}
				<div
					class="pointer-events-none absolute inset-x-0 top-0 z-10 flex items-center gap-2 border-b border-border-subtle bg-bg-content/95 px-3 py-2 text-[11px] text-text-tertiary"
				>
					<Loader2 class="h-3.5 w-3.5 animate-spin" />
					<span>{slowLoad ? m.port_loading_slow({}, { locale }) : m.port_loading({}, { locale })}</span>
				</div>
			{/if}
			<div class="h-full w-full" data-drawer-swipe-ignore>
				<iframe
					bind:this={iframeEl}
					class="h-full w-full border-0 bg-overlay-control-text"
					src={iframeSrc}
					title={m.port_preview_title({ port }, { locale })}
					sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-downloads allow-modals"
					referrerpolicy="no-referrer"
					onload={() => {
						loading = false;
						slowLoad = false;
					}}
				></iframe>
			</div>
		</div>
	{:else}
		<div class="flex min-h-0 flex-1 items-center justify-center p-6 text-xs text-text-tertiary">{m.port_no_url({}, { locale })}</div>
	{/if}
</div>

<style>
	.port-status-dot {
		height: 7px;
		width: 7px;
		flex: 0 0 auto;
		border-radius: 999px;
		background: var(--text-placeholder);
	}

	.port-status-dot.is-listening {
		background: var(--color-success-soft);
	}

	.port-status-dot.is-closed {
		background: var(--color-error-soft);
	}

	.port-observed {
		flex: 0 0 auto;
		color: var(--text-tertiary);
		font-size: 11px;
		white-space: nowrap;
	}

	.secondary-key,
	.primary-key {
		min-height: 32px;
		padding: 0 10px;
		font-size: 12px;
		text-decoration: none;
	}

	@container preview-header (max-width: 460px) {
		.port-observed {
			display: none;
		}
	}
</style>
