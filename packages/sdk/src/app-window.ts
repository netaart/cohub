import {
	APP_APPEARANCE_TOKENS,
	type AppDropResource,
	type AppDropResourceType,
	type AppWindowState,
	appAppearanceVar,
	buildAppRuntimeClosePrepared,
	buildAppRuntimeDropConfig,
	buildAppRuntimeKey,
	buildAppRuntimeWindowState,
	isAppRuntimeHostChord,
	parseAppRuntimeAnnounce,
	parseAppRuntimeClosePrepare,
	parseAppRuntimeDrag,
} from "@cohub/protocol/app-runtime";
import type {
	AppContextChangedListener,
	AppRuntimeContext,
	AppRuntimeTransport,
} from "./app-runtime.js";

export type { AppDropResource, AppDropResourceType, AppWindowState };

/** The file a window holds, from a click, a link, `cohub desktop open`, or a rename. */
export type AppLaunch = { file: { spaceId: string; path: string } };

export type AppDropPoint = {
	/** Frame-local CSS pixels, the same space as `getBoundingClientRect()`. */
	x: number;
	y: number;
	/** Kinds being dragged; the resources arrive on drop. */
	types: AppDropResourceType[];
};

export type AppDropEvent = AppDropPoint & { resources: AppDropResource[] };

export type AppDropHandler = {
	/** Resource kinds this App accepts. The host only offers matching drags. */
	accept: AppDropResourceType[];
	over?: (point: AppDropPoint) => void;
	leave?: () => void;
	drop: (event: AppDropEvent) => void;
};

type RuntimeContextSource = {
	context: () => Promise<AppRuntimeContext | null>;
	onContextChanged: (listener: AppContextChangedListener) => () => void;
};

/** One document listener for all clients, so a chord reaches the host once. */
const keyTransports = new Set<AppRuntimeTransport>();

function forwardKey(event: KeyboardEvent) {
	if (event.isComposing || !isAppRuntimeHostChord(event)) return;
	// Decide once dispatch is over, so App handlers registered after the client
	// can still keep the chord with preventDefault().
	setTimeout(() => {
		if (event.defaultPrevented) return;
		// Only a host that answered the runtime receives chords, so a page that
		// merely embeds this document learns nothing about the keyboard.
		const transport = [...keyTransports].find((candidate) => candidate.isHostConnected?.());
		transport?.notify?.(
			buildAppRuntimeKey({
				key: event.key,
				code: event.code,
				altKey: event.altKey,
				ctrlKey: event.ctrlKey,
				metaKey: event.metaKey,
				shiftKey: event.shiftKey,
			}),
		);
	}, 0);
}

function attachKeys(transport: AppRuntimeTransport) {
	if (keyTransports.size === 0) window.addEventListener("keydown", forwardKey);
	keyTransports.add(transport);
}

function detachKeys(transport: AppRuntimeTransport) {
	if (!keyTransports.delete(transport)) return;
	if (keyTransports.size === 0) window.removeEventListener("keydown", forwardKey);
}

/** The App's side of its host window; a no-op outside a Cohub host. */
export class AppWindowApi {
	private state: AppWindowState = { title: null, status: "idle", dirty: false };
	/** Only a client that reported state re-announces it; others must not reset it. */
	private stateReported = false;
	private beforeClose: (() => unknown) | null = null;
	private dropHandler: AppDropHandler | null = null;
	private hostUnsubscribe: (() => void) | null = null;

	constructor(
		private readonly transport: AppRuntimeTransport,
		private readonly runtime: RuntimeContextSource,
	) {
		if (typeof window === "undefined" || !transport.notify) return;
		if (window.parent === window || typeof window.addEventListener !== "function") return;
		attachKeys(transport);
	}

	/** Report the tab title, save status, and whether work is still unsaved. */
	setState(patch: Partial<AppWindowState>) {
		this.state = { ...this.state, ...patch };
		this.stateReported = true;
		this.listen();
		this.transport.notify?.(buildAppRuntimeWindowState(this.state));
	}

	/** Persist work before a `dirty` window closes; `false` or throw keeps it open. */
	onBeforeClose(handler: () => unknown) {
		this.beforeClose = handler;
		this.listen();
		return () => {
			if (this.beforeClose === handler) this.beforeClose = null;
		};
	}

	/** Accept Cohub resources dragged from the host onto this App. */
	onDrop(handler: AppDropHandler) {
		this.dropHandler = handler;
		this.listen();
		this.transport.notify?.(buildAppRuntimeDropConfig(handler.accept));
		return () => {
			if (this.dropHandler !== handler) return;
			this.dropHandler = null;
			this.transport.notify?.(buildAppRuntimeDropConfig([]));
		};
	}

	/** The window's file: on open, on reopen, and after a rename or move. */
	onLaunch(listener: (launch: AppLaunch) => void) {
		// Context also changes for theme or visibility; only a new launch counts.
		let last: string | null = null;
		const handle = (context: AppRuntimeContext | null) => {
			const invocation = context?.invocation;
			if (!invocation?.file || !invocation.spaceId) return;
			const key = `${invocation.id ?? ""}:${invocation.spaceId}:${invocation.file.path}`;
			if (key === last) return;
			last = key;
			listener({ file: { spaceId: invocation.spaceId, path: invocation.file.path } });
		};
		const unsubscribe = this.runtime.onContextChanged(handle);
		void this.runtime.context().then(handle, () => {});
		return unsubscribe;
	}

	dispose() {
		this.hostUnsubscribe?.();
		this.hostUnsubscribe = null;
		detachKeys(this.transport);
	}

	private listen() {
		if (this.hostUnsubscribe || !this.transport.subscribeHostMessages) return;
		this.hostUnsubscribe = this.transport.subscribeHostMessages((data) => {
			if (parseAppRuntimeAnnounce(data)) {
				this.announce();
				return;
			}
			// Drops and close requests act on the App, so like shortcuts they only
			// come from a host that answered the runtime, not any embedding page.
			if (!this.transport.isHostConnected?.()) return;
			const prepare = parseAppRuntimeClosePrepare(data);
			if (prepare) {
				void this.prepareClose(prepare.requestId);
				return;
			}
			const drag = parseAppRuntimeDrag(data);
			if (drag) this.dispatchDrag(drag);
		});
		// The handshake that proves the host; an App may never ask for context itself.
		void this.runtime.context().catch(() => {});
	}

	/** A reloaded frame forgot the tab state and drops; report them again. */
	private announce() {
		if (this.stateReported) this.transport.notify?.(buildAppRuntimeWindowState(this.state));
		if (this.dropHandler) this.transport.notify?.(buildAppRuntimeDropConfig(this.dropHandler.accept));
	}

	private async prepareClose(requestId: string) {
		let ok: boolean;
		try {
			ok = this.beforeClose ? (await this.beforeClose()) !== false : !this.state.dirty;
		} catch {
			ok = false;
		}
		this.transport.notify?.(buildAppRuntimeClosePrepared({ requestId, ok }));
	}

	private dispatchDrag(drag: NonNullable<ReturnType<typeof parseAppRuntimeDrag>>) {
		const handler = this.dropHandler;
		if (!handler) return;
		const point = { x: drag.x, y: drag.y, types: drag.types };
		if (drag.phase === "over") handler.over?.(point);
		else if (drag.phase === "leave") handler.leave?.();
		else handler.drop({ ...point, resources: drag.resources ?? [] });
	}
}

/** Writes host tokens (`--cohub-*`), color scheme, and `lang` onto `root`. */
export function applyAppAppearance(
	root: HTMLElement,
	context: Pick<AppRuntimeContext, "appearance" | "locale"> | null | undefined,
) {
	const appearance = context?.appearance;
	for (const token of APP_APPEARANCE_TOKENS) {
		const value = appearance?.tokens[token];
		if (value) root.style.setProperty(appAppearanceVar(token), value);
		else root.style.removeProperty(appAppearanceVar(token));
	}
	if (appearance) {
		root.style.colorScheme = appearance.colorScheme;
		root.dataset.cohubColorScheme = appearance.colorScheme;
		root.dataset.cohubReducedMotion = String(appearance.reducedMotion);
	}
	if (context?.locale) root.lang = context.locale;
}
