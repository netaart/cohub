<script lang="ts">
import type {
	DisplayInputEvent,
	DisplayModifierKey,
} from "@cohub/protocol/display";
import type { SpaceDisplaysApi, SpacePresenceUser } from "@neta-art/cohub";
import {
	ChevronLeft,
	Circle,
	Keyboard,
	Loader2,
	MonitorOff,
	MousePointer2,
	RefreshCw,
	Shrink,
	Square,
} from "lucide-svelte";
import { onDestroy, untrack } from "svelte";
import { MediaQuery } from "svelte/reactivity";
import { presentDeviceDisplay } from "$lib/device-display.svelte";
import { getLocale } from "$lib/i18n/locale.svelte";
import { claimKeyboard } from "$lib/keyboard";
import { m } from "$lib/paraglide/messages.js";
import { sdk } from "$lib/sdk";
import DisplayKeyboard, {
	DISPLAY_KEY_BAR_HEIGHT,
} from "./DisplayKeyboard.svelte";
import DisplayViewers from "./DisplayViewers.svelte";
import { createDisplayCamera } from "./display-camera.svelte";
import {
	containedRect,
	createModifierSync,
	eventModifiers,
	keyboardInput,
	remoteMeta,
	textBatches,
	toDisplayPoint,
	wheelFraction,
} from "./display-input";
import {
	createDisplayTouch,
	type DisplayTouchIntent,
	type DisplayTouchMode,
	readDisplayTouchMode,
	writeDisplayTouchMode,
} from "./display-touch";
import { createDisplayView, type DisplayProblem } from "./display-view.svelte";
import PreviewHeader from "./PreviewHeader.svelte";
import type { PreviewChrome, PreviewHeaderAction } from "./preview-header";
import type { Window } from "./windows";

type Props = {
	spaceId: string;
	displayId: string;
	active: boolean;
	windows: Window[];
	chrome: PreviewChrome;
	isMobile: boolean;
	canControl: boolean;
	people: SpacePresenceUser[];
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
	canControl,
	people,
	onActivateWindow,
	onCloseWindow,
}: Props = $props();

const SCROLL_INTERVAL_MS = 250;
const NOTICE_MS = 2_500;
const AUTO_KEYBOARD_MS = 1_500;
const FOCUS_LOST_MS = 400;
const REVEAL_SETTLE_MS = 250;
const FIELD_SLOP = 0.01;
const TRACKPAD_GAIN = { base: 1, max: 2.5, from: 4, per: 12 } as const;
const SCROLL_STEP = { notch: 1 / 20, fine: 1 / 500 } as const;

const locale = $derived(getLocale());
const coarse = new MediaQuery("(pointer: coarse)");
const view = createDisplayView(
	() => spaceId,
	() => displayId,
	() => canControl,
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
const meta = $derived(remoteMeta(display?.platform));
const remoteFocus = $derived(controllable ? view.focus : null);

let video = $state<HTMLVideoElement | null>(null);
let surface = $state<HTMLDivElement | null>(null);
let keyboard = $state<DisplayKeyboard | null>(null);
let keyboardOpen = $state(false);
let touchMode = $state<DisplayTouchMode>(readDisplayTouchMode());
const pointerMode = $derived<DisplayTouchMode>(desktop ? touchMode : "touch");
let pageVisible = $state(
	typeof document === "undefined" || document.visibilityState === "visible",
);
let notice = $state<string | null>(null);
let noticeTimer: ReturnType<typeof setTimeout> | null = null;
let showDetails = $state(false);

const camera = createDisplayCamera({
	surface: () => surface,
	video: () => video,
	covered: () => (keyboardOpen ? DISPLAY_KEY_BAR_HEIGHT : 0),
});
const touch = createDisplayTouch({
	mode: () => pointerMode,
	emit: onTouch,
});

$effect(() => {
	view.setWanted(active && pageVisible);
});

$effect(() => {
	if (active) return presentDeviceDisplay({ spaceId, display: displayId });
});

$effect(() => {
	const release = () => send([], []);
	const update = () => {
		pageVisible = document.visibilityState === "visible";
		if (!pageVisible) release();
	};
	document.addEventListener("visibilitychange", update);
	window.addEventListener("blur", release);
	return () => {
		document.removeEventListener("visibilitychange", update);
		window.removeEventListener("blur", release);
	};
});

// Access can arrive after the window opened, e.g. from a link: follow it.
$effect(() => {
	const wanted = canControl;
	const current = view.connection;
	if (current && current.control !== wanted) untrack(() => view.reconnect());
});

$effect(() => {
	const element = video;
	if (!element) return;
	element.srcObject = view.connection?.stream ?? null;
});

$effect(() => {
	if (view.inputError === 0) return;
	flash(m.display_input_failed({}, { locale }));
	untrack(() => {
		if (!modifiers.held.length) return;
		modifiers.forget();
		send([], []);
	});
});

$effect(() => {
	if (!(active && controllable)) untrack(() => keyboard?.hide());
});

$effect(() => {
	const element = surface;
	if (!element) return;
	const refit = () => {
		camera.refit();
		if (keyboardOpen) scheduleReveal();
	};
	const observer = new ResizeObserver(refit);
	observer.observe(element);
	window.visualViewport?.addEventListener("resize", refit);
	return () => {
		observer.disconnect();
		window.visualViewport?.removeEventListener("resize", refit);
	};
});

$effect(() => {
	const focus = remoteFocus;
	untrack(() => followFocus(focus));
});

onDestroy(() => {
	view.dispose();
	touch.dispose();
	camera.dispose();
	for (const timer of [noticeTimer, scrollTimer, focusLostTimer, revealTimer])
		if (timer) clearTimeout(timer);
	if (frame) cancelAnimationFrame(frame);
	if (scrollFrame) cancelAnimationFrame(scrollFrame);
});

async function agentAction(
	action: (displays: SpaceDisplaysApi) => Promise<unknown>,
) {
	try {
		await action(sdk.space(spaceId).displays);
	} catch {
		flash(m.display_action_failed({}, { locale }));
	}
}

function flash(text: string) {
	notice = text;
	if (noticeTimer) clearTimeout(noticeTimer);
	noticeTimer = setTimeout(() => {
		notice = null;
	}, NOTICE_MS);
}

const modifiers = createModifierSync();
let modifiersOn: typeof view.connection = null;

function send(
	events: DisplayInputEvent[],
	held?: readonly DisplayModifierKey[],
) {
	const connection = view.connection;
	if (!controllable || !connection) return;
	if (connection !== modifiersOn) {
		modifiersOn = connection;
		modifiers.clear();
	}
	const lead = held && desktop ? modifiers.to(held) : [];
	const batch = [...lead, ...events];
	if (batch.length && !connection.sendInput(batch) && lead.length)
		modifiers.clear();
}

function latched(): DisplayModifierKey[] {
	return keyboard?.modifiers() ?? [];
}

function unlatch() {
	keyboard?.consume();
	send([], []);
}

function contentRect() {
	if (!video) return null;
	const box = video.getBoundingClientRect();
	return containedRect(box, video.videoWidth, video.videoHeight);
}

function pointAt(clientX: number, clientY: number, clamp = false) {
	const rect = contentRect();
	return rect && toDisplayPoint(clientX, clientY, rect, clamp);
}

const POINTER_BUTTONS = ["primary", "middle", "secondary"] as const;
type Point = { x: number; y: number };

let pointerId: number | null = null;
let pointerButton: (typeof POINTER_BUTTONS)[number] = "primary";
let pendingMove: Point | null = null;
let frame = 0;

function flushMove() {
	if (frame) cancelAnimationFrame(frame);
	frame = 0;
	if (!pendingMove) return;
	send([{ type: "pointer", action: "move", ...pendingMove }]);
	pendingMove = null;
}

function queueMove(point: Point) {
	pendingMove = point;
	frame ||= requestAnimationFrame(flushMove);
}

function click(point: Point, button: (typeof POINTER_BUTTONS)[number]) {
	flushMove();
	send(
		[
			{ type: "pointer", action: "down", ...point, button },
			{ type: "pointer", action: "up", ...point, button },
		],
		latched(),
	);
	unlatch();
}

function focusSurface() {
	if (!keyboardOpen) surface?.focus({ preventScroll: true });
}

let tappedAt = Number.NEGATIVE_INFINITY;
let lastTap: Point | null = null;

function noteTap(point: Point) {
	tappedAt = performance.now();
	lastTap = point;
	keyboard?.reset();
}

function onPointerDown(event: PointerEvent) {
	if (!controllable) return;
	if (event.pointerType === "touch") {
		event.preventDefault();
		focusSurface();
		surface?.setPointerCapture(event.pointerId);
		touch.down(event.pointerId, event.clientX, event.clientY, event.timeStamp);
		return;
	}
	if (!event.isPrimary || pointerId !== null) return;
	const button = POINTER_BUTTONS[event.button];
	if (!button || (button !== "primary" && !desktop)) return;
	const point = pointAt(event.clientX, event.clientY);
	if (!point) return;
	event.preventDefault();
	focusSurface();
	surface?.setPointerCapture(event.pointerId);
	pointerId = event.pointerId;
	pointerButton = button;
	noteTap(point);
	send(
		[{ type: "pointer", action: "down", ...point, button }],
		eventModifiers(event, meta),
	);
}

function onPointerMove(event: PointerEvent) {
	if (event.pointerType === "touch") {
		touch.move(event.pointerId, event.clientX, event.clientY);
		return;
	}
	const hover =
		pointerId === null &&
		controllable &&
		desktop &&
		event.pointerType === "mouse";
	if (event.pointerId !== pointerId && !hover) return;
	const point = pointAt(event.clientX, event.clientY, !hover);
	if (point) queueMove(point);
}

function onPointerEnd(event: PointerEvent) {
	if (event.pointerType === "touch") {
		if (event.type === "pointercancel") touch.cancel(event.pointerId);
		else
			touch.up(event.pointerId, event.clientX, event.clientY, event.timeStamp);
		return;
	}
	if (event.pointerId !== pointerId) return;
	pointerId = null;
	flushMove();
	const point = pointAt(event.clientX, event.clientY, true);
	if (event.type === "pointercancel" || !point) {
		send([{ type: "pointer", action: "cancel", x: 0, y: 0 }]);
		return;
	}
	send(
		[{ type: "pointer", action: "up", ...point, button: pointerButton }],
		eventModifiers(event, meta),
	);
}

let cursor: Point | null = null;

function cursorAt(): Point | null {
	if (cursor) return cursor;
	const box = surface?.getBoundingClientRect();
	return box
		? pointAt(box.left + box.width / 2, box.top + box.height / 2, true)
		: null;
}

function moveCursor(dx: number, dy: number) {
	const rect = contentRect();
	const from = cursorAt();
	if (!rect || !from || rect.width <= 0 || rect.height <= 0) return;
	const { base, max, from: start, per } = TRACKPAD_GAIN;
	const gain = Math.min(
		max,
		base + Math.max(0, (Math.hypot(dx, dy) - start) / per),
	);
	const unit = (value: number) => Math.min(1, Math.max(0, value));
	cursor = {
		x: unit(from.x + (dx * gain) / rect.width),
		y: unit(from.y + (dy * gain) / rect.height),
	};
	queueMove(cursor);
	camera.follow(cursor.x, cursor.y);
}

let touchScroll = { dx: 0, dy: 0, x: 0.5, y: 0.5 };
let scrollFrame = 0;

function scrollBy(dx: number, dy: number, at: Point | null) {
	const rect = contentRect();
	if (!rect || !at || rect.width <= 0 || rect.height <= 0) return;
	touchScroll = {
		dx: touchScroll.dx - dx / rect.width,
		dy: touchScroll.dy - dy / rect.height,
		...at,
	};
	scrollFrame ||= requestAnimationFrame(flushScroll);
}

function flushScroll() {
	scrollFrame = 0;
	const step =
		display?.platform === "macos" ? SCROLL_STEP.fine : SCROLL_STEP.notch;
	const take = (value: number) => Math.trunc(value / step) * step;
	const dx = take(touchScroll.dx);
	const dy = take(touchScroll.dy);
	touchScroll = {
		...touchScroll,
		dx: touchScroll.dx - dx,
		dy: touchScroll.dy - dy,
	};
	const clamp = (value: number) => Math.max(-1, Math.min(1, value));
	if (dx || dy)
		send([
			{
				type: "scroll",
				x: touchScroll.x,
				y: touchScroll.y,
				dx: clamp(dx),
				dy: clamp(dy),
			},
		]);
}

let pressed = false;

function onTouch(intent: DisplayTouchIntent) {
	switch (intent.type) {
		case "press": {
			const point = pointAt(intent.x, intent.y);
			pressed = point !== null;
			if (!point) return;
			noteTap(point);
			send(
				[{ type: "pointer", action: "down", ...point, button: "primary" }],
				latched(),
			);
			return;
		}
		case "drag": {
			const point = pressed && pointAt(intent.x, intent.y, true);
			if (point) queueMove(point);
			return;
		}
		case "release": {
			if (!pressed) return;
			pressed = false;
			flushMove();
			const point = pointAt(intent.x, intent.y, true);
			send([
				{
					type: "pointer",
					action: point ? "up" : "cancel",
					...(point ?? { x: 0, y: 0 }),
				},
			]);
			unlatch();
			if (point) tapField(point);
			return;
		}
		case "cancel":
			if (!pressed) return;
			pressed = false;
			pendingMove = null;
			send([{ type: "pointer", action: "cancel", x: 0, y: 0 }]);
			return;
		case "move":
			moveCursor(intent.dx, intent.dy);
			return;
		case "tap":
		case "hold":
		case "drop": {
			const point = cursorAt();
			if (!point) return;
			if (intent.type === "tap") {
				noteTap(point);
				click(point, "primary");
				tapField(point);
				return;
			}
			flushMove();
			const hold = intent.type === "hold";
			send(
				[
					{
						type: "pointer",
						action: hold ? "down" : "up",
						...point,
						button: "primary",
					},
				],
				hold ? latched() : undefined,
			);
			if (!hold) unlatch();
			return;
		}
		case "secondary": {
			const point =
				pointerMode === "trackpad" ? cursorAt() : pointAt(intent.x, intent.y);
			if (desktop && point) click(point, "secondary");
			return;
		}
		case "pinch": {
			if (intent.zoom) camera.zoom(intent.scale, intent.x, intent.y);
			const scrolls = !intent.zoom && desktop;
			const rest =
				scrolls && pointerMode === "trackpad"
					? intent
					: camera.pan(intent.dx, intent.dy);
			if (scrolls) {
				const at =
					pointerMode === "trackpad"
						? cursorAt()
						: pointAt(intent.x, intent.y, true);
				scrollBy(rest.dx, rest.dy, at);
			}
			return;
		}
		case "settle":
			touchScroll = { ...touchScroll, dx: 0, dy: 0 };
			return;
	}
}

let wheelScroll = {
	dx: 0,
	dy: 0,
	x: 0.5,
	y: 0.5,
	held: [] as DisplayModifierKey[],
};
let scrollTimer: ReturnType<typeof setTimeout> | null = null;

function onWheel(event: WheelEvent) {
	if (!controllable) return;
	const rect = contentRect();
	const point = rect && toDisplayPoint(event.clientX, event.clientY, rect);
	if (!rect || !point) return;
	event.preventDefault();
	wheelScroll = {
		dx:
			wheelScroll.dx + wheelFraction(event.deltaX, event.deltaMode, rect.width),
		dy:
			wheelScroll.dy +
			wheelFraction(event.deltaY, event.deltaMode, rect.height),
		...point,
		// The browser has already turned ⇧-wheel sideways; ⌃-wheel (and a pinch) zooms.
		held: eventModifiers(event, meta).filter((key) => key !== "Shift"),
	};
	scrollTimer ??= setTimeout(() => {
		scrollTimer = null;
		const clamp = (value: number) => Math.max(-1, Math.min(1, value));
		const { dx, dy, x, y, held } = wheelScroll;
		wheelScroll = { dx: 0, dy: 0, x, y, held: [] };
		const scroll: DisplayInputEvent = {
			type: "scroll",
			x,
			y,
			dx: clamp(dx),
			dy: clamp(dy),
		};
		if (dx || dy) send(desktop ? modifiers.around(held, [scroll]) : [scroll]);
	}, SCROLL_INTERVAL_MS);
}

function remoteKeys(event: KeyboardEvent) {
	return controllable ? keyboardInput(event, desktop, meta) : null;
}

function onKeyDown(event: KeyboardEvent) {
	const input = remoteKeys(event);
	if (!input) return;
	event.preventDefault();
	event.stopPropagation();
	send(input.events, input.held);
}

function onKeyUp(event: KeyboardEvent) {
	const still = eventModifiers(event, meta);
	send(
		[],
		modifiers.held.filter((key) => still.includes(key)),
	);
}

function onPaste(event: ClipboardEvent) {
	if (!controllable) return;
	const text = event.clipboardData?.getData("text/plain");
	if (!text) return;
	event.preventDefault();
	for (const batch of textBatches(text)) send(batch, []);
}

/**
 * The remote surface takes pointer, wheel, key and paste input itself, the
 * way the Board stage does; wheel and Safari's pinch must be non-passive to
 * keep the page still.
 */
function remoteInput(node: HTMLElement, enabled: boolean) {
	const keepStill = (event: Event) => {
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
		["gesturestart", keepStill, { passive: false }],
		["keydown", onKeyDown],
		["keyup", onKeyUp],
		["blur", () => send([], [])],
		["paste", onPaste],
		["contextmenu", keepStill],
	];
	for (const [type, listener, options] of listeners)
		node.addEventListener(type, listener as EventListener, options);
	const release = claimKeyboard(node, (event) => remoteKeys(event) !== null);
	const focusable = (value: boolean) => {
		node.tabIndex = value ? 0 : -1;
	};
	focusable(enabled);
	return {
		update: focusable,
		destroy() {
			for (const [type, listener] of listeners)
				node.removeEventListener(type, listener as EventListener);
			release();
		},
	};
}

let autoKeyboard = false;
let focusLostTimer: ReturnType<typeof setTimeout> | null = null;
let revealTimer: ReturnType<typeof setTimeout> | null = null;
let zoomedFor = "";

function followFocus(focus: typeof remoteFocus) {
	if (focusLostTimer) clearTimeout(focusLostTimer);
	focusLostTimer = null;
	if (!focus) {
		if (autoKeyboard)
			focusLostTimer = setTimeout(() => {
				focusLostTimer = null;
				if (autoKeyboard) keyboard?.hide();
			}, FOCUS_LOST_MS);
		return;
	}
	if (keyboardOpen) scheduleReveal();
	else if (coarse.current && performance.now() - tappedAt < AUTO_KEYBOARD_MS) {
		autoKeyboard = true;
		keyboard?.show(true);
	}
}

function tapField(point: Point) {
	const focus = remoteFocus;
	if (!focus || keyboardOpen || !coarse.current) return;
	const [x, y, width, height] = focus.bounds;
	const slop = FIELD_SLOP;
	const inside =
		point.x >= x - slop &&
		point.x <= x + width + slop &&
		point.y >= y - slop &&
		point.y <= y + height + slop;
	if (!inside) return;
	autoKeyboard = true;
	keyboard?.show();
}

function showKeyboard() {
	autoKeyboard = false;
	keyboard?.show();
}

function onKeyboardOpen(open: boolean) {
	keyboardOpen = open;
	if (open) {
		scheduleReveal();
		return;
	}
	autoKeyboard = false;
	zoomedFor = "";
	send([], []);
	camera.refit();
}

function scheduleReveal() {
	if (revealTimer) clearTimeout(revealTimer);
	revealTimer = setTimeout(revealCaret, REVEAL_SETTLE_MS);
}

function revealCaret() {
	revealTimer = null;
	if (!keyboardOpen) return;
	const focus = remoteFocus;
	if (focus) {
		const key = focus.bounds.join();
		camera.reveal(focus.bounds, key !== zoomedFor);
		zoomedFor = key;
	} else if (lastTap) camera.reveal([lastTap.x, lastTap.y, 0, 0], false);
}

function setTouchMode(mode: DisplayTouchMode) {
	touchMode = mode;
	cursor = null;
	writeDisplayTouchMode(mode);
}

function onVideoResize() {
	cursor = null;
	camera.reset();
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

function formatBitrate(bps: number) {
	return bps >= 1_000_000
		? `${(bps / 1_000_000).toFixed(1)} Mbps`
		: `${Math.round(bps / 1_000)} kbps`;
}

const details = $derived.by((): Array<[label: string, value: string]> => {
	if (!stats || phase.kind !== "live") return [];
	const rows: Array<[string, string | null]> = [
		[
			m.display_stats_path({}, { locale }),
			stats.path &&
				[
					stats.path === "relay"
						? m.display_path_relay({}, { locale })
						: m.display_path_direct({}, { locale }),
					stats.relayProtocol?.toUpperCase(),
				]
					.filter(Boolean)
					.join(" · "),
		],
		[
			m.display_stats_ping({}, { locale }),
			stats.rttMs != null ? `${stats.rttMs} ms` : null,
		],
		[
			m.display_stats_video({}, { locale }),
			stats.width && stats.height
				? `${stats.width} × ${stats.height}${stats.fps != null ? ` · ${Math.round(stats.fps)} fps` : ""}`
				: null,
		],
		[
			m.display_stats_bitrate({}, { locale }),
			stats.bitrate != null ? formatBitrate(stats.bitrate) : null,
		],
		[
			m.display_stats_jitter_buffer({}, { locale }),
			stats.jitterBufferMs != null ? `${stats.jitterBufferMs} ms` : null,
		],
		[
			m.display_stats_decode({}, { locale }),
			stats.decodeMs != null ? `${stats.decodeMs} ms` : null,
		],
		[
			m.display_stats_packets_lost({}, { locale }),
			stats.packetsLost != null ? String(stats.packetsLost) : null,
		],
		[
			m.display_stats_freezes({}, { locale }),
			stats.freezes != null ? String(stats.freezes) : null,
		],
	];
	return rows.filter((row): row is [string, string] => row[1] != null);
});

const headerActions = $derived.by((): PreviewHeaderAction[] => {
	const system = (action: "back" | "home" | "recents") => ({
		hidden: !controllable || !display?.system?.includes(action),
		run: () => send([{ type: "system", action }]),
	});
	return [
		{
			id: "keyboard",
			label: m.display_keyboard({}, { locale }),
			icon: Keyboard,
			primary: true,
			active: keyboardOpen,
			keepFocus: true,
			hidden: !controllable || !(coarse.current || keyboardOpen),
			run: () => (keyboardOpen ? keyboard?.hide() : showKeyboard()),
		},
		{
			id: "trackpad",
			label: m.display_trackpad({}, { locale }),
			icon: MousePointer2,
			primary: true,
			active: pointerMode === "trackpad",
			keepFocus: true,
			hidden: !controllable || !desktop || !coarse.current,
			run: () => setTouchMode(touchMode === "trackpad" ? "touch" : "trackpad"),
		},
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
		variant={isMobile ? "mobile" : "dock"}
		actions={headerActions}
		{chrome}
		onActivate={onActivateWindow}
		onClose={onCloseWindow}
	>
		{#snippet controls()}
			<span class="display-dot" data-phase={phase.kind} aria-hidden="true"></span>
			{#if statusLabel}
				<button
					type="button"
					class="display-status hidden sm:inline"
					title={m.display_stats_toggle({}, { locale })}
					aria-expanded={showDetails}
					onclick={() => (showDetails = !showDetails)}
				>{statusLabel}</button>
			{/if}
			{#if phase.kind === "live"}<DisplayViewers viewers={display?.viewers} {people} />{/if}
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
				onloadeddata={() => view.frameShown()}
				onresize={onVideoResize}
			></video>
		</div>
		<DisplayKeyboard
			bind:this={keyboard}
			{desktop}
			platform={display?.platform}
			{meta}
			password={remoteFocus?.password === true}
			{send}
			{onKeyUp}
			onOpenChange={onKeyboardOpen}
		/>

		{#if showDetails && details.length}
			<dl class="display-details">
				{#each details as [label, value], index (index)}
					<dt>{label}</dt>
					<dd>{value}</dd>
				{/each}
			</dl>
		{/if}

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
					<button type="button" class="display-action primary-key" onclick={() => view.reconnect()}>{m.display_retry({}, { locale })}</button>
				</div>
			</div>
		{/if}

		<div class="display-float">
			{#if controllable && coarse.current && remoteFocus && !keyboardOpen}
				<button type="button" class="display-chip" onclick={showKeyboard}>
					<Keyboard class="h-4 w-4" />
					<span>{m.display_keyboard_show({}, { locale })}</span>
				</button>
			{/if}
			{#if phase.kind === "live" && display && !display.input}
				<div class="display-pill">{display.desktop ? m.display_view_only_desktop({}, { locale }) : m.display_view_only({}, { locale })}</div>
			{:else if phase.kind === "live" && view.connection && !view.connection.control}
				<div class="display-pill">{m.display_view_only_permission({}, { locale })}</div>
			{:else if notice}
				<div class="display-pill" role="status">{notice}</div>
			{:else if phase.kind === "live" && display?.handover && !display.held}
				<div class="display-pill is-asking" role="status">{m.runtime_display_needs_you({ reason: display.handover.reason }, { locale })}</div>
				{#if controllable}
					<div class="display-chips">
						<button type="button" class="display-chip" onclick={() => void agentAction((displays) => displays.interrupt(displayId))}>{m.display_stop_agent({}, { locale })}</button>
						<button type="button" class="display-chip" onclick={() => void agentAction((displays) => displays.handback(displayId))}>{m.display_handback({}, { locale })}</button>
					</div>
				{/if}
			{:else if phase.kind === "live" && display?.held}
				<div class="display-pill" role="status">{m.runtime_display_held({}, { locale })}</div>
			{:else if phase.kind === "live" && display?.activity}
				<div class="display-pill" role="status">{display.activity.label ? m.runtime_display_activity({ label: display.activity.label }, { locale }) : m.runtime_display_working({}, { locale })}</div>
				{#if controllable}
					<button type="button" class="display-chip" onclick={() => void agentAction((displays) => displays.interrupt(displayId))}>{m.display_stop_agent({}, { locale })}</button>
				{/if}
			{/if}
		</div>

		{#if phase.kind === "live" && camera.scale > 1.01}
			<button
				type="button"
				class="display-fit"
				title={m.display_fit({}, { locale })}
				aria-label={m.display_fit({}, { locale })}
				onclick={() => camera.fit()}
			>
				<Shrink class="h-3.5 w-3.5" />
				<span>{camera.scale.toFixed(1)}×</span>
			</button>
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
		background: var(--color-success-soft);
	}
	.display-dot[data-phase="problem"] {
		background: var(--color-error-soft);
	}
	.display-status {
		flex: 0 0 auto;
		border: 0;
		background: none;
		padding: 0;
		color: var(--text-tertiary);
		font: inherit;
		font-size: 11px;
		font-variant-numeric: tabular-nums;
		white-space: nowrap;
		cursor: pointer;
	}
	.display-status:hover {
		color: var(--text-secondary);
	}
	.display-status:focus-visible {
		outline: 2px solid var(--brand);
		outline-offset: 2px;
		border-radius: 3px;
	}
	.display-details {
		position: absolute;
		top: 8px;
		right: 8px;
		display: grid;
		grid-template-columns: auto auto;
		gap: 2px 12px;
		margin: 0;
		padding: 8px 10px;
		border: 1px solid var(--border-subtle);
		border-radius: 7px;
		background: var(--bg-elevated);
		color: var(--text-secondary);
		font-size: 11px;
		line-height: 1.5;
		font-variant-numeric: tabular-nums;
		pointer-events: none;
	}
	.display-details dt {
		color: var(--text-tertiary);
	}
	.display-details dd {
		margin: 0;
		text-align: right;
		white-space: nowrap;
	}
	.display-surface {
		position: absolute;
		inset: 0;
		display: flex;
		align-items: center;
		justify-content: center;
		overflow: hidden;
		outline: none;
		user-select: none;
		-webkit-user-select: none;
		-webkit-touch-callout: none;
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
		transform-origin: 0 0;
		transition: transform 220ms cubic-bezier(0.2, 0.8, 0.2, 1);
		will-change: transform;
	}
	@media (prefers-reduced-motion: reduce) {
		.display-video {
			transition: none;
		}
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
	.display-float {
		position: absolute;
		left: 50%;
		bottom: max(12px, env(safe-area-inset-bottom));
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 8px;
		width: max-content;
		max-width: calc(100% - 24px);
		transform: translateX(-50%);
		pointer-events: none;
	}
	.display-chip,
	.display-fit {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		border: 1px solid var(--border-subtle);
		background: var(--bg-elevated);
		color: var(--text-secondary);
		font: inherit;
		cursor: pointer;
		pointer-events: auto;
	}
	.display-chip {
		min-height: 40px;
		padding: 0 14px;
		border-radius: 999px;
		font-size: 13px;
		box-shadow: 0 4px 16px rgb(0 0 0 / 0.12);
	}
	.display-fit {
		position: absolute;
		right: 12px;
		bottom: max(12px, env(safe-area-inset-bottom));
		min-height: 32px;
		padding: 0 10px;
		border-radius: 7px;
		font-size: 12px;
		font-variant-numeric: tabular-nums;
	}
	.display-chips {
		display: flex;
		flex-wrap: wrap;
		justify-content: center;
		gap: 8px;
	}
	.display-chip:hover,
	.display-fit:hover {
		color: var(--text-primary);
	}
	.display-chip:focus-visible,
	.display-fit:focus-visible {
		outline: 2px solid var(--brand);
		outline-offset: 2px;
	}
	.display-pill {
		max-width: 100%;
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
	.display-pill.is-asking {
		color: var(--text-primary);
		border-color: var(--brand);
	}
	.display-action {
		min-height: 32px;
		padding: 0 12px;
		font-size: 12px;
	}
	@media (max-width: 640px) {
		.display-action {
			min-height: 44px;
		}
	}
</style>
