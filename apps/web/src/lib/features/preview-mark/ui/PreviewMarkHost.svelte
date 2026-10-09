<script lang="ts">
import { Loader2, Scissors } from "lucide-svelte";
import { onDestroy, tick } from "svelte";
import { fade, scale } from "svelte/transition";
import { portal } from "$lib/actions/portal";
import {
	DURATION_MODAL_IN,
	DURATION_MODAL_OUT,
	svelteEaseIn,
	svelteEaseOut,
} from "$lib/motion.svelte";
import { attachComposerFiles } from "../attach/to-composer";
import {
	detectCaptureCapabilities,
	iframeCaptureSupportedMessage,
} from "../capture/capabilities";
import {
	captureIframeElementFromStream,
	captureViewportFromStream,
	requestDisplayMedia,
} from "../capture/iframe-capture";
import { captureImageSource } from "../capture/image-capture";
import { copyMarkedFrameToClipboard, exportMarkedFrame } from "../mark/export";
import { createMarkSession, type MarkSession } from "../mark/session.svelte";
import type { CaptureResult, PreviewCaptureTarget } from "../types";
import { suggestedMarkedName } from "../types";
import ImageMarkSurface from "./ImageMarkSurface.svelte";
import MarkToolbar from "./MarkToolbar.svelte";

type Props = {
	open?: boolean;
	/**
	 * Preview capture target. When null/undefined and `allowViewport` is true,
	 * capture falls back to the full shared tab (global hotkey path).
	 */
	target?: PreviewCaptureTarget | null;
	/** Allow full-tab capture without a preview target (global shortcut). */
	allowViewport?: boolean;
	/** When false, only the overlay UI is rendered (no scissors chrome button). */
	showTrigger?: boolean;
	onAttached?: () => void;
};

let {
	open = $bindable(false),
	target = null,
	allowViewport = false,
	showTrigger = true,
	onAttached,
}: Props = $props();

let session = $state<MarkSession | null>(null);
let phase = $state<"idle" | "capturing" | "marking" | "copying" | "attaching">(
	"idle",
);
let error = $state<string | null>(null);
/** Lightweight toast for dismissals (cancel / permission deny) — not the full panel. */
let softNotice = $state<string | null>(null);
let copied = $state(false);
let captureGen = 0;
let disposed = false;
let panelEl: HTMLDivElement | null = $state(null);
let copiedTimer: ReturnType<typeof setTimeout> | null = null;
let softNoticeTimer: ReturnType<typeof setTimeout> | null = null;

const isApplePlatform = $derived.by(() => {
	if (typeof navigator === "undefined") return false;
	const platform = navigator.platform ?? "";
	const ua = navigator.userAgent ?? "";
	return /Mac|iPhone|iPad|iPod/.test(platform) || /Mac OS X/.test(ua);
});
const triggerTitle = $derived(
	isApplePlatform ? "Capture & mark (⌘⇧S)" : "Capture & mark (Ctrl+Shift+S)",
);
const triggerAriaLabel = $derived(
	isApplePlatform
		? "Capture and mark preview (Command Shift S)"
		: "Capture and mark preview (Control Shift S)",
);

const usesDisplayMedia = $derived(
	Boolean(target?.kind === "iframe" || (!target && allowViewport)),
);
const canRecapture = $derived(usesDisplayMedia);
const canStart = $derived(Boolean(target) || allowViewport);
const canCropApply = $derived(
	Boolean(session?.cropDraft && session.getCropRect()),
);
const busy = $derived(phase === "copying" || phase === "attaching");

/** User can sit on the share picker; after this we surface an error instead of spinning forever. */
const SHARE_PICKER_TIMEOUT_MS = 90_000;

const TRANSITION_IN = { duration: DURATION_MODAL_IN, easing: svelteEaseOut };
const TRANSITION_OUT = { duration: DURATION_MODAL_OUT, easing: svelteEaseIn };
const SCALE_IN = { ...TRANSITION_IN, start: 0.98 };
const SCALE_OUT = { ...TRANSITION_OUT, start: 0.98 };

$effect(() => {
	if (!open) return;
	// Focus the panel so keyboard shortcuts work without an extra click.
	queueMicrotask(() => panelEl?.focus({ preventScroll: true }));
	const onKey = (event: KeyboardEvent) => {
		if (busy) return;
		if (event.key === "Escape") {
			event.preventDefault();
			// Layered cancel: draft/crop selection first, then close the overlay.
			if (session?.draft || session?.cropDraft) {
				session.cancelDraft();
				return;
			}
			close();
			return;
		}
		if (
			event.key === "Enter" &&
			session?.tool === "crop" &&
			canCropApply &&
			!event.metaKey &&
			!event.ctrlKey &&
			!event.altKey
		) {
			event.preventDefault();
			void handleApplyCrop();
		}
	};
	window.addEventListener("keydown", onKey);
	return () => window.removeEventListener("keydown", onKey);
});

function clearSoftNotice() {
	softNotice = null;
	if (softNoticeTimer) {
		clearTimeout(softNoticeTimer);
		softNoticeTimer = null;
	}
}

function showSoftNotice(message: string, ms = 2200) {
	softNotice = message;
	if (softNoticeTimer) clearTimeout(softNoticeTimer);
	softNoticeTimer = setTimeout(() => {
		softNotice = null;
		softNoticeTimer = null;
	}, ms);
}

function close() {
	captureGen += 1;
	session?.dispose();
	session = null;
	phase = "idle";
	error = null;
	copied = false;
	clearSoftNotice();
	if (copiedTimer) {
		clearTimeout(copiedTimer);
		copiedTimer = null;
	}
	open = false;
}

/** User dismissed share UI or denied permission — keep feedback light. */
function isSoftCaptureDismissal(name: string): boolean {
	return (
		name === "NotAllowedError" ||
		name === "PermissionDeniedError" ||
		name === "AbortError"
	);
}

function applyCaptureResult(
	result: CaptureResult,
	gen: number,
	hadSession: boolean,
) {
	if (gen !== captureGen || disposed) {
		if (result.ok) {
			try {
				result.frame.bitmap.close();
			} catch {
				// ignore
			}
		}
		return;
	}

	if (!result.ok) {
		error = result.message;
		// Keep existing marks if recapture failed; otherwise show status UI.
		phase = hadSession ? "marking" : "idle";
		open = true;
		return;
	}

	if (session) {
		session.replaceCapture(result.frame);
	} else {
		session = createMarkSession(result.frame);
	}
	error = null;
	phase = "marking";
	open = true;
}

/**
 * Capture must start getDisplayMedia in the same user-gesture turn as the
 * keydown/click — before any await that yields past the gesture.
 */
async function runCapture() {
	if (!canStart || disposed) return;
	if (phase === "capturing" || busy) return;

	const gen = ++captureGen;
	const hadSession = Boolean(session);
	const captureTarget = target;
	clearSoftNotice();

	if (captureTarget?.kind === "image") {
		error = null;
		phase = "capturing";
		const result = await captureImageSource({
			src: captureTarget.src,
			path: captureTarget.path,
		});
		applyCaptureResult(result, gen, hadSession);
		return;
	}

	const caps = detectCaptureCapabilities();
	const blocked = iframeCaptureSupportedMessage(caps);
	if (blocked) {
		if (gen !== captureGen || disposed) return;
		error = blocked;
		phase = hadSession ? "marking" : "idle";
		open = true;
		return;
	}

	// 1) Start the picker first, still inside the gesture call stack.
	// 2) Only then flip reactive UI state.
	let streamPromise: Promise<MediaStream>;
	try {
		streamPromise = requestDisplayMedia();
	} catch (caught) {
		if (gen !== captureGen || disposed) return;
		const message =
			caught instanceof Error
				? caught.message
				: "Screen capture isn’t available.";
		phase = hadSession ? "marking" : "idle";
		if (hadSession) {
			error = message;
			open = true;
		} else {
			showSoftNotice(message);
		}
		return;
	}

	error = null;
	clearSoftNotice();
	phase = "capturing";
	// Keep the page free of our overlays under the share UI and while grabbing.
	// No in-page capture toast — it paints into the tab and ends up in the frame.
	open = false;

	let stream: MediaStream;
	try {
		stream = await new Promise<MediaStream>((resolve, reject) => {
			const timer = setTimeout(() => {
				reject(
					new Error(
						"Share dialog timed out. Press the shortcut again and choose this tab.",
					),
				);
			}, SHARE_PICKER_TIMEOUT_MS);
			streamPromise.then(
				(value) => {
					clearTimeout(timer);
					resolve(value);
				},
				(err) => {
					clearTimeout(timer);
					reject(err);
				},
			);
		});
	} catch (caught) {
		if (gen !== captureGen || disposed) return;
		const name =
			caught && typeof caught === "object" && "name" in caught
				? String((caught as { name?: string }).name)
				: "";
		phase = hadSession ? "marking" : "idle";
		if (gen !== captureGen || disposed) return;

		// Soft dismissals: cancel / deny should not open the heavy mark panel.
		if (isSoftCaptureDismissal(name)) {
			error = null;
			if (hadSession) open = true;
			else showSoftNotice("Capture cancelled");
			return;
		}

		const message =
			caught instanceof Error
				? caught.message
				: "Failed to start screen capture.";
		if (hadSession) {
			error = message;
			open = true;
		} else {
			showSoftNotice(message, 3200);
		}
		return;
	}

	if (gen !== captureGen || disposed) {
		for (const track of stream.getTracks()) track.stop();
		return;
	}

	// One paint after the share picker closes so the page is clean of chrome.
	await tick();
	await new Promise<void>((resolve) => {
		requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
	});
	if (gen !== captureGen || disposed) {
		for (const track of stream.getTracks()) track.stop();
		return;
	}

	const result =
		captureTarget?.kind === "iframe"
			? await captureIframeElementFromStream({
					stream,
					element: captureTarget.element,
					source: captureTarget.source,
				})
			: await captureViewportFromStream({ stream });
	applyCaptureResult(result, gen, hadSession);
}

/** Start capture from a trusted user gesture (click or global hotkey). */
export function triggerCapture() {
	if (phase === "capturing" || busy) return;
	if ((phase === "marking" || phase === "copying") && session) {
		open = true;
		return;
	}
	void runCapture();
}

async function handleMarkClick() {
	triggerCapture();
}

async function handleRecapture() {
	if (!canRecapture) return;
	await runCapture();
}

async function ensureCropApplied(): Promise<boolean> {
	if (!session?.cropDraft) return true;
	const ok = await session.applyCropDraft();
	if (!ok) {
		error = "Drag a larger area to crop, or switch tools to discard.";
		return false;
	}
	error = null;
	return true;
}

async function handleCopy() {
	if (!session || busy) return;
	phase = "copying";
	error = null;
	copied = false;
	try {
		if (!(await ensureCropApplied())) {
			phase = "marking";
			return;
		}
		await copyMarkedFrameToClipboard({
			frame: session.frame,
			strokes: session.strokes,
		});
		copied = true;
		phase = "marking";
		if (copiedTimer) clearTimeout(copiedTimer);
		copiedTimer = setTimeout(() => {
			copied = false;
			copiedTimer = null;
		}, 1600);
	} catch (err) {
		error =
			err instanceof Error ? err.message : "Failed to copy image to clipboard.";
		phase = "marking";
	}
}

async function handleAttach() {
	if (!session || busy) return;
	phase = "attaching";
	error = null;
	try {
		if (!(await ensureCropApplied())) {
			phase = "marking";
			return;
		}
		const file = await exportMarkedFrame({
			frame: session.frame,
			strokes: session.strokes,
			filename: suggestedMarkedName(session.frame.source),
		});
		attachComposerFiles(file);
		onAttached?.();
		close();
	} catch (err) {
		error =
			err instanceof Error ? err.message : "Failed to export marked image.";
		phase = "marking";
	}
}

async function handleApplyCrop() {
	if (!session) return;
	const ok = await session.applyCropDraft();
	if (!ok) error = "Drag a larger area to crop.";
	else error = null;
}

function onBackdropPointer(event: MouseEvent) {
	if (event.target !== event.currentTarget) return;
	if (busy) return;
	close();
}

onDestroy(() => {
	disposed = true;
	captureGen += 1;
	if (copiedTimer) clearTimeout(copiedTimer);
	if (softNoticeTimer) clearTimeout(softNoticeTimer);
	session?.dispose();
	session = null;
});
</script>

{#if showTrigger}
	<button
		type="button"
		class="preview-mark-trigger"
		title={triggerTitle}
		aria-label={triggerAriaLabel}
		disabled={!canStart || phase === "capturing" || busy}
		onclick={() => void handleMarkClick()}
	>
		{#if phase === "capturing"}
			<Loader2 class="h-4 w-4 animate-spin" />
		{:else}
			<Scissors class="h-4 w-4" />
		{/if}
	</button>
{/if}

{#if softNotice && !open && phase !== "capturing"}
	<div
		use:portal
		class="mark-soft-notice"
		role="status"
		aria-live="polite"
		in:fade={TRANSITION_IN}
	>
		{softNotice}
	</div>
{/if}

{#if open}
	<!-- svelte-ignore a11y_no_static_element_interactions -->
	<div
		use:portal
		class="mark-overlay"
		role="presentation"
		in:fade={TRANSITION_IN}
		out:fade={TRANSITION_OUT}
		onmousedown={onBackdropPointer}
	>
		<div
			bind:this={panelEl}
			class="mark-panel"
			role="dialog"
			aria-modal="true"
			aria-label="Mark preview"
			tabindex="-1"
			in:scale|local={SCALE_IN}
			out:scale|local={SCALE_OUT}
		>
			{#if (phase === "marking" || phase === "copying" || phase === "attaching") && session}
				<MarkToolbar
					tool={session.tool}
					color={session.color}
					canUndo={session.canUndo}
					canClear={session.canClear}
					canCropApply={canCropApply}
					canResetCrop={session.isCropped}
					canRecapture={canRecapture}
					{busy}
					copying={phase === "copying"}
					{copied}
					attaching={phase === "attaching"}
					onTool={(t) => session?.setTool(t)}
					onColor={(c) => session?.setColor(c)}
					onUndo={() => session?.undo()}
					onClear={() => session?.clear()}
					onApplyCrop={() => void handleApplyCrop()}
					onResetCrop={() => session?.resetCrop()}
					onRecapture={canRecapture ? () => void handleRecapture() : undefined}
					onCopy={() => void handleCopy()}
					onAttach={() => void handleAttach()}
					onClose={close}
				/>
				<div class="mark-stage">
					<ImageMarkSurface
						{session}
						onApplyCrop={() => void handleApplyCrop()}
					/>
				</div>
				{#if error}
					<div class="mark-error" role="alert">{error}</div>
				{/if}
			{:else}
				<div class="mark-status">
					{#if error}
						<div class="mark-status-title">Couldn’t capture</div>
						<div class="mark-status-hint">{error}</div>
						<div class="mark-status-actions">
							<button
								type="button"
								class="mark-status-btn"
								onclick={() => void runCapture()}>Try again</button
							>
							<button type="button" class="mark-status-btn ghost" onclick={close}
								>Close</button
							>
						</div>
					{:else}
						<div class="mark-status-title">Capture & mark</div>
						<div class="mark-status-hint">
							Share this Cohub tab when prompted, then annotate the snapshot.
						</div>
						<button
							type="button"
							class="mark-status-btn"
							onclick={() => void runCapture()}>Capture</button
						>
					{/if}
				</div>
			{/if}
		</div>
	</div>
{/if}

<style>
	/* Self-contained chrome button: parent scoped classes cannot reach
	   across the component boundary, so alignment must not depend on them. */
	.preview-mark-trigger {
		display: inline-flex;
		width: 32px;
		height: 32px;
		flex-shrink: 0;
		align-items: center;
		justify-content: center;
		border: 0;
		border-radius: 6px;
		background: transparent;
		color: var(--text-tertiary);
		cursor: pointer;
		transition: background-color 120ms ease, color 120ms ease, transform 120ms ease;
	}

	.preview-mark-trigger:hover:not(:disabled) {
		background: var(--bg-hover);
		color: var(--text-secondary);
	}

	.preview-mark-trigger:active:not(:disabled) {
		transform: scale(0.96);
	}

	.preview-mark-trigger:disabled {
		opacity: 0.45;
		cursor: not-allowed;
	}

	.mark-soft-notice {
		position: fixed;
		bottom: max(20px, env(safe-area-inset-bottom, 0px));
		left: 50%;
		z-index: var(--z-mark);
		transform: translateX(-50%);
		max-width: min(360px, calc(100vw - 32px));
		border: 1px solid var(--border-subtle);
		border-radius: 8px;
		background: var(--bg-content);
		padding: 8px 12px;
		color: var(--text-secondary);
		font-size: 12px;
		font-weight: 500;
		line-height: 1.35;
		text-align: center;
		box-shadow: 0 8px 24px
			color-mix(in srgb, var(--overlay-scrim-strong) 18%, transparent);
	}

	.mark-overlay {
		position: fixed;
		inset: 0;
		z-index: var(--z-mark);
		display: flex;
		align-items: stretch;
		justify-content: center;
		padding: 0;
		background: var(--overlay-scrim);
	}
	@media (min-width: 720px) {
		.mark-overlay {
			align-items: center;
			padding: max(16px, env(safe-area-inset-top, 0px))
				max(16px, env(safe-area-inset-right, 0px))
				max(16px, env(safe-area-inset-bottom, 0px))
				max(16px, env(safe-area-inset-left, 0px));
		}
	}

	.mark-panel {
		display: flex;
		width: 100%;
		height: 100%;
		max-height: 100%;
		flex-direction: column;
		overflow: hidden;
		padding-top: env(safe-area-inset-top, 0px);
		--safe-area-top: 0px;
		background: var(--bg-content);
		outline: none;
	}
	@media (min-width: 720px) {
		.mark-panel {
			width: min(960px, 100%);
			height: min(800px, 100%);
			max-height: min(90dvh, 100%);
			padding-top: 0;
			border: 1px solid var(--border-subtle);
			border-radius: 10px;
			box-shadow: 0 24px 64px
				color-mix(in srgb, var(--overlay-scrim-strong) 32%, transparent);
		}
	}

	.mark-stage {
		display: flex;
		min-height: 0;
		flex: 1;
		align-items: center;
		justify-content: center;
		container-type: size;
		padding: 12px;
		overflow: hidden;
		background: var(--bg-primary);
	}
	@media (min-width: 720px) {
		.mark-stage {
			padding: 18px;
		}
	}

	.mark-error {
		padding: 8px 12px;
		border-top: 1px solid var(--border-subtle);
		color: var(--color-error-soft);
		font-size: 12px;
	}

	.mark-status {
		display: flex;
		min-height: 0;
		flex: 1;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		gap: 8px;
		padding: 28px 24px;
		text-align: center;
	}
	.mark-status-title {
		color: var(--text-primary);
		font-size: 14px;
		font-weight: 600;
	}
	.mark-status-hint {
		max-width: 32ch;
		color: var(--text-tertiary);
		font-size: 12px;
		line-height: 1.5;
	}
	.mark-status-actions {
		display: flex;
		gap: 8px;
		margin-top: 6px;
	}
	.mark-status-btn {
		display: inline-flex;
		min-height: 32px;
		align-items: center;
		justify-content: center;
		border: 1px solid transparent;
		border-radius: 7px;
		background: var(--brand);
		padding: 0 12px;
		color: var(--brand-contrast-fg);
		font-size: 12px;
		font-weight: 600;
		cursor: pointer;
	}
	.mark-status-btn:hover {
		filter: brightness(1.05);
	}
	.mark-status-btn.ghost {
		border-color: var(--border-subtle);
		background: var(--bg-hover);
		color: var(--text-secondary);
		filter: none;
	}
</style>
