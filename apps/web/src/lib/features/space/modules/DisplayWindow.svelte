<script lang="ts">
import {
	type DisplayInputEvent,
	splitDisplayText,
} from "@cohub/protocol/display";
import {
	ChevronLeft,
	Circle,
	Loader2,
	MonitorOff,
	RefreshCw,
	Square,
} from "lucide-svelte";
import { onDestroy } from "svelte";
import { getLocale } from "$lib/i18n/locale.svelte";
import { m } from "$lib/paraglide/messages.js";
import {
	containedRect,
	keyboardInput,
	toDisplayPoint,
	wheelFraction,
} from "./display-input";
import { createDisplayView, type DisplayProblem } from "./display-view.svelte";
import PreviewHeader from "./PreviewHeader.svelte";
import {
	type PreviewChrome,
	type PreviewHeaderAction,
	previewHeaderVariant,
} from "./preview-header";
import type { Window } from "./windows";

type Props = {
	spaceId: string;
	displayId: string;
	active: boolean;
	windows: Window[];
	chrome: PreviewChrome;
	isMobile: boolean;
	onActivateWindow: (kind: Window["kind"], key: string) => void;
	onCloseWindow: (kind: Window["kind"], key: string) => void;
};

const {
	spaceId,
	displayId,
	active,
	windows,
	chrome,
	isMobile,
	onActivateWindow,
	onCloseWindow,
}: Props = $props();

const HIDDEN_GRACE_MS = 10_000;
const SCROLL_INTERVAL_MS = 250;
const NOTICE_MS = 2_500;
const MAX_PASTE_PIECES = 16;

const locale = $derived(getLocale());
const view = createDisplayView(
	() => spaceId,
	() => displayId,
);
const phase = $derived(view.phase);
const display = $derived(view.display);
const stats = $derived(view.stats);
const controllable = $derived(
	phase.kind === "live" &&
		display?.input === true &&
		view.connection?.control === true,
);
const desktop = $derived(display?.desktop === true);

let video = $state<HTMLVideoElement | null>(null);
let surface = $state<HTMLDivElement | null>(null);
let pageVisible = $state(
	typeof document === "undefined" || document.visibilityState === "visible",
);
let notice = $state<string | null>(null);
let noticeTimer: ReturnType<typeof setTimeout> | null = null;

$effect(() => {
	const wanted = active && pageVisible;
	if (wanted) {
		view.setWanted(true);
		return;
	}
	const timer = setTimeout(() => view.setWanted(false), HIDDEN_GRACE_MS);
	return () => clearTimeout(timer);
});

$effect(() => {
	const update = () => {
		pageVisible = document.visibilityState === "visible";
	};
	document.addEventListener("visibilitychange", update);
	return () => document.removeEventListener("visibilitychange", update);
});

$effect(() => {
	const element = video;
	if (!element) return;
	element.srcObject = view.connection?.stream ?? null;
});

$effect(() => {
	if (view.inputError > 0) flash(m.display_input_failed({}, { locale }));
});

onDestroy(() => {
	view.dispose();
	if (noticeTimer) clearTimeout(noticeTimer);
	if (frame) cancelAnimationFrame(frame);
	if (scrollTimer) clearTimeout(scrollTimer);
});

function flash(text: string) {
	notice = text;
	if (noticeTimer) clearTimeout(noticeTimer);
	noticeTimer = setTimeout(() => {
		notice = null;
	}, NOTICE_MS);
}

function send(events: DisplayInputEvent[]) {
	if (controllable) view.connection?.sendInput(events);
}

function contentRect() {
	if (!video) return null;
	const box = video.getBoundingClientRect();
	return containedRect(box, video.videoWidth, video.videoHeight);
}

const POINTER_BUTTONS = ["primary", "middle", "secondary"] as const;

let pointerId: number | null = null;
let pointerButton: (typeof POINTER_BUTTONS)[number] = "primary";
let pendingMove: { x: number; y: number } | null = null;
let frame = 0;

function flushMove() {
	if (frame) cancelAnimationFrame(frame);
	frame = 0;
	if (!pendingMove) return;
	send([{ type: "pointer", action: "move", ...pendingMove }]);
	pendingMove = null;
}

function onPointerDown(event: PointerEvent) {
	if (!controllable || !event.isPrimary || pointerId !== null) return;
	const button = POINTER_BUTTONS[event.button];
	if (!button || (button !== "primary" && !desktop)) return;
	const rect = contentRect();
	const point = rect && toDisplayPoint(event.clientX, event.clientY, rect);
	if (!point) return;
	event.preventDefault();
	surface?.focus({ preventScroll: true });
	surface?.setPointerCapture(event.pointerId);
	pointerId = event.pointerId;
	pointerButton = button;
	send([{ type: "pointer", action: "down", ...point, button }]);
}

function onPointerMove(event: PointerEvent) {
	const hover =
		pointerId === null &&
		controllable &&
		desktop &&
		event.pointerType === "mouse";
	if (event.pointerId !== pointerId && !hover) return;
	const rect = contentRect();
	const point =
		rect && toDisplayPoint(event.clientX, event.clientY, rect, !hover);
	if (!point) return;
	pendingMove = point;
	frame ||= requestAnimationFrame(flushMove);
}

function onPointerEnd(event: PointerEvent) {
	if (event.pointerId !== pointerId) return;
	pointerId = null;
	flushMove();
	const rect = contentRect();
	const point =
		rect && toDisplayPoint(event.clientX, event.clientY, rect, true);
	if (event.type === "pointercancel" || !point) {
		send([{ type: "pointer", action: "cancel", x: 0, y: 0 }]);
		return;
	}
	send([{ type: "pointer", action: "up", ...point, button: pointerButton }]);
}

let scroll = { dx: 0, dy: 0, x: 0.5, y: 0.5 };
let scrollTimer: ReturnType<typeof setTimeout> | null = null;

function onWheel(event: WheelEvent) {
	if (!controllable) return;
	const rect = contentRect();
	const point = rect && toDisplayPoint(event.clientX, event.clientY, rect);
	if (!rect || !point) return;
	event.preventDefault();
	scroll = {
		dx: scroll.dx + wheelFraction(event.deltaX, event.deltaMode, rect.width),
		dy: scroll.dy + wheelFraction(event.deltaY, event.deltaMode, rect.height),
		...point,
	};
	scrollTimer ??= setTimeout(() => {
		scrollTimer = null;
		const clamp = (value: number) => Math.max(-1, Math.min(1, value));
		const { dx, dy, x, y } = scroll;
		scroll = { dx: 0, dy: 0, x, y };
		if (dx || dy)
			send([{ type: "scroll", x, y, dx: clamp(dx), dy: clamp(dy) }]);
	}, SCROLL_INTERVAL_MS);
}

function onKeyDown(event: KeyboardEvent) {
	if (!controllable) return;
	const input = keyboardInput(event, desktop);
	if (!input.length) return;
	event.preventDefault();
	send(input);
}

function onPaste(event: ClipboardEvent) {
	if (!controllable) return;
	const text = event.clipboardData?.getData("text/plain");
	if (!text) return;
	event.preventDefault();
	for (const piece of splitDisplayText(text).slice(0, MAX_PASTE_PIECES))
		send([{ type: "text", text: piece }]);
}

/**
 * The remote surface takes pointer, wheel, key and paste input itself, the
 * way the Board stage does; wheel must be non-passive to keep the page still.
 */
function remoteInput(node: HTMLElement, enabled: boolean) {
	const contextMenu = (event: Event) => {
		if (controllable) event.preventDefault();
	};
	const listeners: Array<
		[string, (event: never) => void, AddEventListenerOptions?]
	> = [
		["pointerdown", onPointerDown],
		["pointermove", onPointerMove],
		["pointerup", onPointerEnd],
		["pointercancel", onPointerEnd],
		["wheel", onWheel, { passive: false }],
		["keydown", onKeyDown],
		["paste", onPaste],
		["contextmenu", contextMenu],
	];
	for (const [type, listener, options] of listeners)
		node.addEventListener(type, listener as EventListener, options);
	const focusable = (value: boolean) => {
		node.tabIndex = value ? 0 : -1;
	};
	focusable(enabled);
	return {
		update: focusable,
		destroy() {
			for (const [type, listener] of listeners)
				node.removeEventListener(type, listener as EventListener);
		},
	};
}

const statusLabel = $derived.by(() => {
	if (phase.kind === "connecting") return m.display_connecting({}, { locale });
	if (phase.kind !== "live") return "";
	const parts: string[] = [m.display_live({}, { locale })];
	if (stats?.path)
		parts.push(
			stats.path === "relay"
				? m.display_path_relay({}, { locale })
				: m.display_path_direct({}, { locale }),
		);
	if (stats?.rttMs != null) parts.push(`${stats.rttMs} ms`);
	if (stats?.fps != null) parts.push(`${Math.round(stats.fps)} fps`);
	return parts.join(" · ");
});

const headerActions = $derived.by((): PreviewHeaderAction[] => {
	const system = (action: "back" | "home" | "recents") => ({
		hidden: !controllable || !display?.system?.includes(action),
		run: () => send([{ type: "system", action }]),
	});
	return [
		{
			id: "back",
			label: m.display_back({}, { locale }),
			icon: ChevronLeft,
			primary: true,
			...system("back"),
		},
		{
			id: "home",
			label: m.display_home({}, { locale }),
			icon: Circle,
			primary: true,
			...system("home"),
		},
		{
			id: "recents",
			label: m.display_recents({}, { locale }),
			icon: Square,
			primary: true,
			...system("recents"),
		},
		{
			id: "reconnect",
			label: m.display_reconnect({}, { locale }),
			icon: RefreshCw,
			run: () => view.reconnect(),
		},
	];
});

const problemCopy = $derived.by(() => {
	if (phase.kind !== "problem") return null;
	const copy: Record<DisplayProblem, { title: string; hint: string }> = {
		unavailable: display?.needs?.includes("screenRecording")
			? {
					title: m.display_screen_recording_title({}, { locale }),
					hint: m.display_screen_recording_hint({}, { locale }),
				}
			: {
					title: m.display_unavailable_title({}, { locale }),
					hint: m.display_unavailable_hint({}, { locale }),
				},
		offline: {
			title: m.display_offline_title({}, { locale }),
			hint: m.display_offline_hint({}, { locale }),
		},
		outdated: {
			title: m.display_failed_title({}, { locale }),
			hint: m.display_outdated_hint({}, { locale }),
		},
		busy: {
			title: m.display_failed_title({}, { locale }),
			hint: m.display_busy_hint({}, { locale }),
		},
		failed: {
			title: m.display_failed_title({}, { locale }),
			hint: m.display_failed_hint({}, { locale }),
		},
	};
	return copy[phase.problem];
});
</script>

<div class="flex h-full min-w-0 flex-col bg-bg-content">
	<PreviewHeader
		{windows}
		variant={previewHeaderVariant({ isMobile, immersive: chrome.immersive })}
		actions={headerActions}
		{chrome}
		onActivate={onActivateWindow}
		onClose={onCloseWindow}
	>
		{#snippet controls()}
			<span class="display-dot" data-phase={phase.kind} aria-hidden="true"></span>
			{#if statusLabel}<span class="display-status hidden sm:inline">{statusLabel}</span>{/if}
		{/snippet}
	</PreviewHeader>

	<div class="relative min-h-0 flex-1 bg-bg-primary" data-drawer-swipe-ignore>
		<div
			bind:this={surface}
			class="display-surface"
			class:is-controllable={controllable}
			role="application"
			aria-label={display?.name ?? displayId}
			use:remoteInput={controllable}
		>
			<video
				bind:this={video}
				class="display-video"
				class:is-hidden={phase.kind !== "live"}
				autoplay
				muted
				playsinline
				disablepictureinpicture
			></video>
		</div>

		{#if phase.kind === "connecting" || phase.kind === "idle"}
			<div class="display-overlay">
				<Loader2 class="h-4 w-4 animate-spin motion-reduce:animate-none" />
				<span>{m.display_connecting({}, { locale })}</span>
			</div>
		{:else if problemCopy}
			<div class="display-overlay">
				<div class="max-w-sm text-center">
					<div class="mx-auto mb-3 flex h-10 w-10 items-center justify-center rounded-lg border border-border-subtle bg-bg-surface text-text-tertiary">
						<MonitorOff class="h-5 w-5" />
					</div>
					<div class="mb-1 text-sm font-medium text-text-primary">{problemCopy.title}</div>
					<div class="mb-4 text-xs leading-5 text-text-tertiary">{problemCopy.hint}</div>
					<button type="button" class="display-action" onclick={() => view.reconnect()}>{m.display_retry({}, { locale })}</button>
				</div>
			</div>
		{/if}

		{#if phase.kind === "live" && display && !display.input}
			<div class="display-pill">{display.desktop ? m.display_view_only_desktop({}, { locale }) : m.display_view_only({}, { locale })}</div>
		{:else if notice}
			<div class="display-pill" role="status">{notice}</div>
		{/if}
	</div>
</div>

<style>
	.display-dot {
		height: 7px;
		width: 7px;
		flex: 0 0 auto;
		border-radius: 999px;
		background: var(--text-placeholder);
	}
	.display-dot[data-phase="live"] {
		background: var(--success-soft);
	}
	.display-dot[data-phase="problem"] {
		background: var(--error-soft);
	}
	.display-status {
		flex: 0 0 auto;
		color: var(--text-tertiary);
		font-size: 11px;
		font-variant-numeric: tabular-nums;
		white-space: nowrap;
	}
	.display-surface {
		position: absolute;
		inset: 0;
		display: flex;
		align-items: center;
		justify-content: center;
		outline: none;
		user-select: none;
		-webkit-user-select: none;
	}
	.display-surface.is-controllable {
		cursor: default;
		/* Every touch is the device's, not the page's. */
		touch-action: none;
	}
	.display-surface.is-controllable:focus-visible {
		box-shadow: inset 0 0 0 1px var(--border-strong);
	}
	.display-video {
		max-height: 100%;
		max-width: 100%;
		height: 100%;
		width: 100%;
		object-fit: contain;
		pointer-events: none;
	}
	.display-video.is-hidden {
		visibility: hidden;
	}
	.display-overlay {
		position: absolute;
		inset: 0;
		display: flex;
		align-items: center;
		justify-content: center;
		gap: 8px;
		padding: 24px;
		color: var(--text-tertiary);
		font-size: 12px;
	}
	.display-pill {
		position: absolute;
		left: 50%;
		bottom: max(12px, env(safe-area-inset-bottom));
		transform: translateX(-50%);
		max-width: calc(100% - 24px);
		padding: 6px 10px;
		border: 1px solid var(--border-subtle);
		border-radius: 7px;
		background: var(--bg-elevated);
		color: var(--text-secondary);
		font-size: 12px;
		line-height: 1.4;
		text-align: center;
		pointer-events: none;
	}
	.display-action {
		display: inline-flex;
		min-height: 32px;
		align-items: center;
		justify-content: center;
		border-radius: 6px;
		border: 1px solid var(--brand);
		background: var(--brand);
		padding: 0 12px;
		color: var(--brand-contrast-fg);
		font-size: 12px;
		cursor: pointer;
	}
	.display-action:hover {
		background: var(--brand-hover);
	}
	.display-action:focus-visible {
		outline: 2px solid var(--brand);
		outline-offset: 2px;
	}
	@media (max-width: 640px) {
		.display-action {
			min-height: 44px;
		}
	}
</style>
