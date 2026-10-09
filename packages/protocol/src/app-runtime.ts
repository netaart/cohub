export const APP_RUNTIME_PROTOCOL = "cohub.app.runtime";
export const APP_RUNTIME_VERSION = 1;

type RuntimeEnvelope = {
	protocol: typeof APP_RUNTIME_PROTOCOL;
	version: typeof APP_RUNTIME_VERSION;
};

export type AppRuntimeReadyMessage = RuntimeEnvelope & {
	type: "ready";
};

/** The App asks its host to close the surface it runs in. */
export type AppRuntimeCloseRequestMessage = RuntimeEnvelope & {
	type: "close.request";
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
	Boolean(value && typeof value === "object" && !Array.isArray(value));

export const parseAppRuntimeReady = (
	value: unknown,
): AppRuntimeReadyMessage | null => {
	if (
		!isRecord(value) ||
		value.protocol !== APP_RUNTIME_PROTOCOL ||
		value.version !== APP_RUNTIME_VERSION ||
		value.type !== "ready"
	) {
		return null;
	}
	return {
		protocol: APP_RUNTIME_PROTOCOL,
		version: APP_RUNTIME_VERSION,
		type: "ready",
	};
};

export const buildAppRuntimeReady = (): AppRuntimeReadyMessage => ({
	protocol: APP_RUNTIME_PROTOCOL,
	version: APP_RUNTIME_VERSION,
	type: "ready",
});

export const parseAppRuntimeCloseRequest = (
	value: unknown,
): AppRuntimeCloseRequestMessage | null => {
	if (
		!isRecord(value) ||
		value.protocol !== APP_RUNTIME_PROTOCOL ||
		value.version !== APP_RUNTIME_VERSION ||
		value.type !== "close.request"
	) {
		return null;
	}
	return {
		protocol: APP_RUNTIME_PROTOCOL,
		version: APP_RUNTIME_VERSION,
		type: "close.request",
	};
};

export const buildAppRuntimeCloseRequest = (): AppRuntimeCloseRequestMessage => ({
	protocol: APP_RUNTIME_PROTOCOL,
	version: APP_RUNTIME_VERSION,
	type: "close.request",
});

/** Axis-aligned rectangle in CSS pixels, overlay-local (top-left origin). */
export type AppRuntimeRect = {
	x: number;
	y: number;
	width: number;
	height: number;
};

/** Which corner of the overlay `geometry.x` / `geometry.y` are measured from. */
export type AppRuntimeAnchor =
	| "top-left"
	| "top-right"
	| "bottom-left"
	| "bottom-right"
	| "center";

/**
 * The App asks its overlay host to change where it sits or where it accepts
 * pointer events. The host clamps geometry to the viewport; an axis without a
 * size fills the layer.
 *
 * `inputRegion`: `"none"` (default) makes the overlay click-through, `"all"`
 * makes it fully interactive, and a rect list limits interaction to those
 * overlay-local rectangles.
 *
 * `geometry` is the complete shape: a present object replaces the current one
 * (absent axes fall back to the default — `{}` fills the layer), and omitting
 * the field leaves the current geometry untouched.
 */
export type AppRuntimeConfigureRequest = RuntimeEnvelope & {
	type: "configure.request";
	geometry?: {
		anchor?: AppRuntimeAnchor;
		x?: number;
		y?: number;
		width?: number;
		height?: number;
	};
	inputRegion?: "all" | "none" | AppRuntimeRect[];
};

const ANCHORS: readonly AppRuntimeAnchor[] = [
	"top-left",
	"top-right",
	"bottom-left",
	"bottom-right",
	"center",
];

const finite = (value: unknown): value is number =>
	typeof value === "number" && Number.isFinite(value);

const positive = (value: unknown): value is number => finite(value) && value > 0;

const parseRect = (value: unknown): AppRuntimeRect | null =>
	isRecord(value) &&
	finite(value.x) &&
	finite(value.y) &&
	positive(value.width) &&
	positive(value.height)
		? { x: value.x, y: value.y, width: value.width, height: value.height }
		: null;

export const parseAppRuntimeConfigureRequest = (
	value: unknown,
): AppRuntimeConfigureRequest | null => {
	if (
		!isRecord(value) ||
		value.protocol !== APP_RUNTIME_PROTOCOL ||
		value.version !== APP_RUNTIME_VERSION ||
		value.type !== "configure.request"
	) {
		return null;
	}
	const message: AppRuntimeConfigureRequest = {
		protocol: APP_RUNTIME_PROTOCOL,
		version: APP_RUNTIME_VERSION,
		type: "configure.request",
	};
	if (isRecord(value.geometry)) {
		const { anchor, x, y, width, height } = value.geometry;
		const valid =
			(anchor === undefined || ANCHORS.includes(anchor as AppRuntimeAnchor)) &&
			(x === undefined || finite(x)) &&
			(y === undefined || finite(y)) &&
			(width === undefined || positive(width)) &&
			(height === undefined || positive(height));
		// A malformed present field invalidates the whole shape. Dropping just
		// the bad axis would turn an invalid size into `{}` — i.e. a fill — and
		// could grow a fixed panel to the whole, interactive layer.
		if (valid) {
			message.geometry = {
				...(anchor !== undefined
					? { anchor: anchor as AppRuntimeAnchor }
					: {}),
				...(x !== undefined ? { x: x as number } : {}),
				...(y !== undefined ? { y: y as number } : {}),
				...(width !== undefined ? { width: width as number } : {}),
				...(height !== undefined ? { height: height as number } : {}),
			};
		}
	}
	if (value.inputRegion === "all" || value.inputRegion === "none") {
		message.inputRegion = value.inputRegion;
	} else if (Array.isArray(value.inputRegion)) {
		message.inputRegion = value.inputRegion
			.map(parseRect)
			.filter((rect): rect is AppRuntimeRect => rect !== null);
	}
	return message;
};

export const buildAppRuntimeConfigureRequest = (
	input: Omit<AppRuntimeConfigureRequest, keyof RuntimeEnvelope | "type">,
): AppRuntimeConfigureRequest => ({
	protocol: APP_RUNTIME_PROTOCOL,
	version: APP_RUNTIME_VERSION,
	type: "configure.request",
	...input,
});

/**
 * The App reports where the pointer is while its overlay owns it. A
 * cross-origin frame swallows pointer events for the whole window once the
 * host makes it interactive, so the host cannot tell whether a rect input
 * region is still hovered; the App — which sees those events — reports the
 * position instead, and the host releases the overlay when it leaves.
 *
 * Coordinates are frame-local CSS pixels (the same space as
 * `getBoundingClientRect()`), which equal overlay-local coordinates because the
 * frame fills the overlay. `down` keeps the host from releasing mid-drag.
 */
export type AppRuntimePointerMessage = RuntimeEnvelope & {
	type: "pointer";
	x: number;
	y: number;
	down: boolean;
};

export const buildAppRuntimePointer = (input: {
	x: number;
	y: number;
	down: boolean;
}): AppRuntimePointerMessage => ({
	protocol: APP_RUNTIME_PROTOCOL,
	version: APP_RUNTIME_VERSION,
	type: "pointer",
	x: input.x,
	y: input.y,
	down: input.down,
});

export const parseAppRuntimePointer = (
	value: unknown,
): AppRuntimePointerMessage | null => {
	if (
		!isRecord(value) ||
		value.protocol !== APP_RUNTIME_PROTOCOL ||
		value.version !== APP_RUNTIME_VERSION ||
		value.type !== "pointer" ||
		!finite(value.x) ||
		!finite(value.y)
	) {
		return null;
	}
	return {
		protocol: APP_RUNTIME_PROTOCOL,
		version: APP_RUNTIME_VERSION,
		type: "pointer",
		x: value.x,
		y: value.y,
		down: value.down === true,
	};
};

// --- Window, keyboard, and drops -----------------------------------------

const isRuntimeMessage = (
	value: unknown,
	type: string,
): value is Record<string, unknown> =>
	isRecord(value) &&
	value.protocol === APP_RUNTIME_PROTOCOL &&
	value.version === APP_RUNTIME_VERSION &&
	value.type === type;

const envelope = <T extends string>(type: T): RuntimeEnvelope & { type: T } => ({
	protocol: APP_RUNTIME_PROTOCOL,
	version: APP_RUNTIME_VERSION,
	type,
});

const boundedText = (value: unknown, max: number): string | null => {
	if (typeof value !== "string") return null;
	const text = value.replace(/\s+/g, " ").trim();
	return text ? text.slice(0, max) : null;
};

/** After each frame load, the host asks the document to announce its state again. */
export type AppRuntimeAnnounceMessage = RuntimeEnvelope & { type: "announce" };

export const buildAppRuntimeAnnounce = (): AppRuntimeAnnounceMessage =>
	envelope("announce");

export const parseAppRuntimeAnnounce = (
	value: unknown,
): AppRuntimeAnnounceMessage | null =>
	isRuntimeMessage(value, "announce") ? buildAppRuntimeAnnounce() : null;

export const APP_WINDOW_TITLE_MAX = 120;

export type AppWindowStatus = "idle" | "saving" | "error";

/** Tab title and status; `dirty` makes the host flush before closing. */
export type AppWindowState = {
	title: string | null;
	status: AppWindowStatus;
	dirty: boolean;
};

export type AppRuntimeWindowStateMessage = RuntimeEnvelope & {
	type: "window.state";
} & AppWindowState;

export const buildAppRuntimeWindowState = (
	state: AppWindowState,
): AppRuntimeWindowStateMessage => ({
	...envelope("window.state"),
	title: state.title,
	status: state.status,
	dirty: state.dirty,
});

export const parseAppRuntimeWindowState = (
	value: unknown,
): AppRuntimeWindowStateMessage | null => {
	if (!isRuntimeMessage(value, "window.state")) return null;
	const status =
		value.status === "saving" || value.status === "error" ? value.status : "idle";
	return buildAppRuntimeWindowState({
		title: boundedText(value.title, APP_WINDOW_TITLE_MAX),
		status,
		dirty: value.dirty === true,
	});
};

/** The host asks the App to persist pending work before its window closes. */
export type AppRuntimeClosePrepareMessage = RuntimeEnvelope & {
	type: "close.prepare";
	requestId: string;
};

/** The App answers `close.prepare`; `ok: false` keeps the window open. */
export type AppRuntimeClosePreparedMessage = RuntimeEnvelope & {
	type: "close.prepared";
	requestId: string;
	ok: boolean;
};

const requestIdOf = (value: Record<string, unknown>) =>
	typeof value.requestId === "string" && value.requestId && value.requestId.length <= 128
		? value.requestId
		: null;

export const buildAppRuntimeClosePrepare = (
	requestId: string,
): AppRuntimeClosePrepareMessage => ({ ...envelope("close.prepare"), requestId });

export const parseAppRuntimeClosePrepare = (
	value: unknown,
): AppRuntimeClosePrepareMessage | null => {
	if (!isRuntimeMessage(value, "close.prepare")) return null;
	const requestId = requestIdOf(value);
	return requestId ? buildAppRuntimeClosePrepare(requestId) : null;
};

export const buildAppRuntimeClosePrepared = (input: {
	requestId: string;
	ok: boolean;
}): AppRuntimeClosePreparedMessage => ({
	...envelope("close.prepared"),
	requestId: input.requestId,
	ok: input.ok,
});

export const parseAppRuntimeClosePrepared = (
	value: unknown,
): AppRuntimeClosePreparedMessage | null => {
	if (!isRuntimeMessage(value, "close.prepared")) return null;
	const requestId = requestIdOf(value);
	return requestId
		? buildAppRuntimeClosePrepared({ requestId, ok: value.ok === true })
		: null;
};

/** An unhandled Ctrl / Meta chord the host replays for its shortcuts. */
export type AppRuntimeKeyMessage = RuntimeEnvelope & {
	type: "key";
	key: string;
	code: string;
	altKey: boolean;
	ctrlKey: boolean;
	metaKey: boolean;
	shiftKey: boolean;
};

export type AppRuntimeKeyInput = Omit<AppRuntimeKeyMessage, keyof RuntimeEnvelope | "type">;

/** Select all, copy, paste, cut, undo, redo: the browser's, and the App's. */
const EDITING_CHORD_KEYS = new Set(["a", "c", "v", "x", "y", "z"]);

/** Whether a Ctrl / Meta chord may reach the host; both sides apply this rule. */
export const isAppRuntimeHostChord = (input: {
	key: string;
	ctrlKey: boolean;
	metaKey: boolean;
}): boolean =>
	(input.ctrlKey || input.metaKey) && !EDITING_CHORD_KEYS.has(input.key.toLowerCase());

export const buildAppRuntimeKey = (input: AppRuntimeKeyInput): AppRuntimeKeyMessage => ({
	...envelope("key"),
	key: input.key,
	code: input.code,
	altKey: input.altKey,
	ctrlKey: input.ctrlKey,
	metaKey: input.metaKey,
	shiftKey: input.shiftKey,
});

export const parseAppRuntimeKey = (value: unknown): AppRuntimeKeyMessage | null => {
	if (!isRuntimeMessage(value, "key")) return null;
	if (typeof value.key !== "string" || !value.key || value.key.length > 32) return null;
	const chord = { key: value.key, ctrlKey: value.ctrlKey === true, metaKey: value.metaKey === true };
	if (!isAppRuntimeHostChord(chord)) return null;
	return buildAppRuntimeKey({
		key: value.key,
		code: typeof value.code === "string" ? value.code.slice(0, 32) : "",
		altKey: value.altKey === true,
		ctrlKey: value.ctrlKey === true,
		metaKey: value.metaKey === true,
		shiftKey: value.shiftKey === true,
	});
};

/** Resource kinds the Cohub host can drop into an App. */
export const APP_DROP_RESOURCE_TYPES = ["file", "task", "app", "session", "checkpoint"] as const;

export type AppDropResourceType = (typeof APP_DROP_RESOURCE_TYPES)[number];

const isDropResourceType = (value: unknown): value is AppDropResourceType =>
	APP_DROP_RESOURCE_TYPES.includes(value as AppDropResourceType);

/** A dropped Cohub resource; `ref` identifies it (the path, for files). */
export type AppDropResource = {
	type: AppDropResourceType;
	ref: string;
	title?: string;
	path?: string;
	mimeType?: string;
	size?: number;
	mtimeMs?: number;
	appId?: string;
	href?: string;
	taskRunId?: string;
	/** Resource-specific snapshot, e.g. a Task Run summary. */
	snapshot?: Record<string, unknown>;
};

const MAX_DROP_RESOURCES = 100;

const parseDropResource = (value: unknown): AppDropResource | null => {
	if (!isRecord(value) || !isDropResourceType(value.type)) return null;
	const ref = boundedText(value.ref, 4096);
	if (!ref) return null;
	const resource: AppDropResource = { type: value.type, ref };
	for (const key of ["title", "path", "mimeType", "appId", "href", "taskRunId"] as const) {
		const text = boundedText(value[key], 4096);
		if (text) resource[key] = text;
	}
	if (finite(value.size) && value.size >= 0) resource.size = value.size;
	if (finite(value.mtimeMs)) resource.mtimeMs = value.mtimeMs;
	if (isRecord(value.snapshot)) resource.snapshot = value.snapshot;
	return resource;
};

const parseDropTypes = (value: unknown): AppDropResourceType[] =>
	Array.isArray(value) ? [...new Set(value.filter(isDropResourceType))] : [];

/** The App declares which resource kinds it accepts; `[]` stops accepting. */
export type AppRuntimeDropConfigMessage = RuntimeEnvelope & {
	type: "drop.config";
	accept: AppDropResourceType[];
};

export const buildAppRuntimeDropConfig = (
	accept: readonly AppDropResourceType[],
): AppRuntimeDropConfigMessage => ({ ...envelope("drop.config"), accept: [...accept] });

export const parseAppRuntimeDropConfig = (
	value: unknown,
): AppRuntimeDropConfigMessage | null =>
	isRuntimeMessage(value, "drop.config")
		? buildAppRuntimeDropConfig(parseDropTypes(value.accept))
		: null;

/** A host drag in frame-local pixels; resources only cross on `drop`. */
export type AppRuntimeDragMessage = RuntimeEnvelope & {
	type: "drag";
	phase: "over" | "leave" | "drop";
	x: number;
	y: number;
	types: AppDropResourceType[];
	resources?: AppDropResource[];
};

export const buildAppRuntimeDrag = (
	input: Omit<AppRuntimeDragMessage, keyof RuntimeEnvelope | "type">,
): AppRuntimeDragMessage => ({
	...envelope("drag"),
	phase: input.phase,
	x: input.x,
	y: input.y,
	types: [...input.types],
	...(input.phase === "drop" ? { resources: input.resources ?? [] } : {}),
});

export const parseAppRuntimeDrag = (value: unknown): AppRuntimeDragMessage | null => {
	if (!isRuntimeMessage(value, "drag")) return null;
	if (value.phase !== "over" && value.phase !== "leave" && value.phase !== "drop") return null;
	if (!finite(value.x) || !finite(value.y)) return null;
	const resources =
		value.phase === "drop" && Array.isArray(value.resources)
			? value.resources
					.slice(0, MAX_DROP_RESOURCES)
					.map(parseDropResource)
					.filter((resource): resource is AppDropResource => resource !== null)
			: undefined;
	return buildAppRuntimeDrag({
		phase: value.phase,
		x: value.x,
		y: value.y,
		types: parseDropTypes(value.types),
		...(resources ? { resources } : {}),
	});
};

// --- Appearance -----------------------------------------------------------

/** Public design tokens, sent as resolved CSS values. */
export const APP_APPEARANCE_TOKENS = [
	"bg-primary",
	"bg-content",
	"bg-surface",
	"bg-elevated",
	"bg-input",
	"bg-hover",
	"bg-active",
	"text-primary",
	"text-secondary",
	"text-tertiary",
	"text-placeholder",
	"text-disabled",
	"border-primary",
	"border-subtle",
	"brand",
	"brand-hover",
	"brand-soft",
	"brand-muted",
	"brand-border",
	"brand-ring",
	"brand-contrast-fg",
	"error-fg",
	"selection-bg",
	"overlay-scrim",
	"shadow-subtle",
	"shadow-medium",
	"shadow-strong",
	"font-sans",
	"font-mono",
] as const;

export type AppAppearanceToken = (typeof APP_APPEARANCE_TOKENS)[number];

export type AppAppearance = {
	colorScheme: "light" | "dark";
	/** The host theme id, as a hint; not a stable enumeration. */
	theme: string;
	tokens: Partial<Record<AppAppearanceToken, string>>;
	reducedMotion: boolean;
};

/** CSS custom property an App reads a shared token from, e.g. `--cohub-bg-primary`. */
export const appAppearanceVar = (token: AppAppearanceToken) => `--cohub-${token}`;
