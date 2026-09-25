import { appWindowKey, parseAppWindowKey } from "./app-window-key";
import {
	alignWindowNavigation,
	beginWindowNavigation,
	createWindowNavigationState,
	isCurrentWindowNavigation,
	type WindowNavigationSource,
	windowRefsEqual,
} from "./window-navigation";
import type { WindowKind, WindowRef } from "./window-route";
import { isValidAppKey, isValidPortKey } from "./window-route";
import type { WorkspaceAppOpenContext } from "./workspace-app-context";

type FileTabLike = {
	path: string;
	response: unknown;
	draft: string;
};

type BoardTabLike = {
	path: string;
	saving: boolean;
};

type PortTabLike = {
	port: string;
	url: string;
};

type AppTabLike = {
	/** The window key: an App id, or an App id bound to a file. */
	key: string;
	loading: boolean;
	/** Unsaved work lives in the App document; unmounting it would lose it. */
	windowState?: { dirty: boolean };
};

type WindowManagerOptions = {
	getFileTabs: () => FileTabLike[];
	getActiveFilePath: () => string | null;
	getBoardTabs: () => BoardTabLike[];
	getActiveBoardPath: () => string | null;
	getPortTabs: () => PortTabLike[];
	getActivePort: () => string | null;
	getAppTabs: () => AppTabLike[];
	getActiveAppKey: () => string | null;
	openFile: (
		path: string,
		options?: { preserveHistory?: boolean; position?: unknown },
	) => Promise<void>;
	activateFile: (path: string) => void;
	closeFile: (path?: string | null, skipConfirm?: boolean) => void;
	goBackFile: () => Promise<string | null>;
	openBoard: (path: string) => Promise<void>;
	activateBoard: (path: string) => void;
	closeBoard: (path?: string | null) => void;
	openPort: (
		port: string,
		url: string,
		options?: { autoOpened?: boolean },
	) => void;
	activatePort: (port: string) => void;
	closePort: (port?: string | null) => void;
	openApp: (input: {
		appId: string;
		label?: string;
		launch?: { search?: string; hash?: string } | null;
		openContext: WorkspaceAppOpenContext;
	}) => void;
	activateApp: (key: string) => void;
	closeApp: (key?: string | null) => void;
	getPortEndpointUrl: (port: string) => string | null | undefined;
	syncUrl: (ref: WindowRef | null, replace?: boolean) => void;
	onBudgetCleanup?: () => void;
	weightLimit?: number;
	/** App tabs kept mounted in the background; the rest stay as data-only tabs. */
	appKeepAliveLimit?: number;
};

const DEFAULT_WEIGHT_LIMIT = 16;
const DEFAULT_APP_KEEP_ALIVE_LIMIT = 3;

function asFileResponse(response: unknown): {
	kind?: string;
	content?: string;
} | null {
	if (!response || typeof response !== "object") return null;
	return response as { kind?: string; content?: string };
}

function isBinaryFileTab(tab: FileTabLike) {
	const response = asFileResponse(tab.response);
	return response?.kind === "binary";
}

function isDirtyFileTab(tab: FileTabLike) {
	const response = asFileResponse(tab.response);
	if (!response || typeof response.content !== "string") return false;
	return tab.draft !== response.content;
}

/**
 * Single active-tab coordinator over file/board/port/app domain controllers.
 * Owns: the active preview ref, access order, budget, URL sync, open/close.
 * Does not own: file drafts, board docs, port endpoints (domain controllers do).
 *
 * The active ref is canonical here, but it is only ever reported once the owning
 * domain actually has that tab mounted as its active surface. That is what keeps
 * an "active" kind from outliving its surface and painting an empty panel.
 */
export function createWindowManager(options: WindowManagerOptions) {
	let activeRef = $state<WindowRef | null>(null);
	/** Monotonic access order. A counter, not a clock: two tabs touched inside the
	 * same millisecond must still compare, or the MRU fallback silently degrades
	 * to whatever order the domains happen to report. */
	let accessedAt = $state<Record<string, number>>({});
	let accessCounter = 0;
	let navigation = $state(createWindowNavigationState());
	/** Compact session navigation hides surfaces without disposing their state. */
	let suspended = $state(false);
	const weightLimit = options.weightLimit ?? DEFAULT_WEIGHT_LIMIT;
	const appKeepAliveLimit =
		options.appKeepAliveLimit ?? DEFAULT_APP_KEEP_ALIVE_LIMIT;
	/** Set while closes are already accounted for here — a close this controller
	 * drives, or a context teardown. Domain "tab closed" reports are then ignored,
	 * so tearing down an old context cannot write over the URL of the new one. */
	let suppressCloseReports = false;

	function beginNavigation(
		ref: WindowRef | null,
		source: WindowNavigationSource,
	) {
		navigation = beginWindowNavigation(navigation, ref, source);
		return navigation.transitionId;
	}

	function tabId(kind: WindowKind, key: string) {
		return `${kind}:${key}`;
	}

	function touch(kind: WindowKind, key: string) {
		accessCounter += 1;
		accessedAt = { ...accessedAt, [tabId(kind, key)]: accessCounter };
	}

	/** Drop access order for a tab that no longer exists, so a long session does
	 * not accumulate entries for closed previews. */
	function forget(kind: WindowKind, key: string) {
		const id = tabId(kind, key);
		if (!(id in accessedAt)) return;
		const { [id]: _dropped, ...rest } = accessedAt;
		accessedAt = rest;
	}

	function lastAccessed(ref: WindowRef) {
		return accessedAt[tabId(ref.kind, ref.key)] ?? 0;
	}

	/**
	 * App tabs whose surface should stay mounted while they are inactive. The
	 * active App and dirty Apps are always kept; remaining slots go to the most
	 * recently used others.
	 */
	function retainedAppKeys(): ReadonlySet<string> {
		const tabs = options.getAppTabs();
		const keys = tabs.map((tab) => tab.key);
		if (keys.length <= appKeepAliveLimit) return new Set(keys);
		const active = options.getActiveAppKey();
		const ranked = keys
			.map((key, index) => ({
				key,
				index,
				lastAccessed: accessedAt[tabId("app", key)] ?? 0,
			}))
			.sort((a, b) => b.lastAccessed - a.lastAccessed || b.index - a.index);
		const kept = new Set<string>(
			tabs.filter((tab) => tab.windowState?.dirty).map((tab) => tab.key),
		);
		if (active && keys.includes(active)) kept.add(active);
		for (const item of ranked) {
			if (kept.size >= appKeepAliveLimit) break;
			kept.add(item.key);
		}
		return kept;
	}

	/** Whether a domain still holds this tab, active or not. */
	function hasTab(kind: WindowKind, key: string) {
		if (kind === "file")
			return options.getFileTabs().some((tab) => tab.path === key);
		if (kind === "board")
			return options.getBoardTabs().some((tab) => tab.path === key);
		if (kind === "port")
			return options.getPortTabs().some((tab) => tab.port === key);
		return options.getAppTabs().some((tab) => tab.key === key);
	}

	/** Every domain's currently mounted surface, as preview refs. */
	function mountedRefs(): WindowRef[] {
		const refs: WindowRef[] = [];
		const filePath = options.getActiveFilePath();
		if (filePath) refs.push({ kind: "file", key: filePath });
		const boardPath = options.getActiveBoardPath();
		if (boardPath) refs.push({ kind: "board", key: boardPath });
		const port = options.getActivePort();
		if (port) refs.push({ kind: "port", key: port });
		const appKey = options.getActiveAppKey();
		if (appKey) refs.push({ kind: "app", key: appKey });
		return refs;
	}

	/**
	 * The active ref, reconciled against what the domains actually have mounted.
	 * When the committed ref is gone, the most recently used mounted surface wins
	 * rather than a fixed kind order, so closing a tab reveals what the user saw
	 * last.
	 */
	function resolveMountedActiveRef(): WindowRef | null {
		const mounted = mountedRefs();
		if (mounted.length === 0) return null;
		const committed = activeRef;
		const exact =
			committed && mounted.find((ref) => windowRefsEqual(ref, committed));
		if (exact) return exact;
		return mounted.reduce((best, ref) =>
			lastAccessed(ref) > lastAccessed(best) ? ref : best,
		);
	}

	function resolveActiveRef(): WindowRef | null {
		return suspended ? null : resolveMountedActiveRef();
	}

	function currentRef(): WindowRef | null {
		return resolveActiveRef();
	}

	/** Commit the active ref and mark it most recently used, in one step. */
	function commitActive(ref: WindowRef) {
		suspended = false;
		activeRef = ref;
		touch(ref.kind, ref.key);
	}

	/** Re-derive the active ref after tabs changed underneath us. */
	function reconcileActive() {
		activeRef = resolveMountedActiveRef();
		return activeRef;
	}

	/** Hide the active preview for compact session navigation, keeping every tab. */
	function suspendForRoute() {
		const ref = resolveMountedActiveRef();
		if (!ref) return false;
		activeRef = ref;
		suspended = true;
		beginNavigation(null, "route");
		return true;
	}

	function enforceBudget() {
		const candidates = [
			...options.getFileTabs().map((tab) => ({
				kind: "file" as const,
				key: tab.path,
				weight: isBinaryFileTab(tab) ? 2 : 1,
				protected: isDirtyFileTab(tab),
			})),
			...options.getBoardTabs().map((tab) => ({
				kind: "board" as const,
				key: tab.path,
				weight: 2,
				protected: tab.saving,
			})),
			...options.getPortTabs().map((tab) => ({
				kind: "port" as const,
				key: tab.port,
				weight: 3,
				protected: false,
			})),
			...options.getAppTabs().map((tab) => ({
				kind: "app" as const,
				key: tab.key,
				// An embedded Work costs about as much as a port preview.
				weight: 3,
				protected: tab.loading || tab.windowState?.dirty === true,
			})),
		];
		let total = candidates.reduce((sum, tab) => sum + tab.weight, 0);
		if (total <= weightLimit) return;
		const removable = candidates
			.filter((tab) => !tab.protected)
			.sort(
				(a, b) =>
					(accessedAt[tabId(a.kind, a.key)] ?? 0) -
					(accessedAt[tabId(b.kind, b.key)] ?? 0),
			);
		let closed = 0;
		for (const tab of removable) {
			if (total <= weightLimit) break;
			closeInDomain(tab.kind, tab.key, true);
			forget(tab.kind, tab.key);
			total -= tab.weight;
			closed += 1;
		}
		if (closed > 0) {
			const ref = reconcileActive();
			navigation = alignWindowNavigation(navigation, ref);
			options.syncUrl(ref, true);
			options.onBudgetCleanup?.();
		}
	}

	/** Run domain closes without letting their reports re-enter reconciliation. */
	function withSuppressedCloseReports(run: () => void) {
		const previous = suppressCloseReports;
		suppressCloseReports = true;
		try {
			run();
		} finally {
			suppressCloseReports = previous;
		}
	}

	function closeInDomain(
		kind: WindowKind,
		key?: string | null,
		skipConfirm = false,
	) {
		withSuppressedCloseReports(() => {
			if (kind === "file") options.closeFile(key, skipConfirm);
			else if (kind === "board") options.closeBoard(key);
			else if (kind === "port") options.closePort(key);
			else options.closeApp(key);
		});
	}

	async function openFile(
		path: string,
		opts: {
			syncUrl?: boolean;
			preserveHistory?: boolean;
			position?: unknown;
			source?: WindowNavigationSource;
		} = {},
	) {
		const syncUrl = opts.syncUrl ?? true;
		const hadPreview = Boolean(currentRef());
		const ref = { kind: "file" as const, key: path };
		const transitionId = beginNavigation(
			ref,
			opts.source ?? (syncUrl ? "user" : "route"),
		);
		commitActive(ref);
		// Domain open creates its loading tab synchronously. URL sync follows in
		// the same task, while route reconciliation only observes route changes.
		const pending = options.openFile(path, {
			preserveHistory: opts.preserveHistory,
			position: opts.position,
		});
		if (syncUrl) options.syncUrl(ref, hadPreview);
		await pending;
		enforceBudget();
		if (syncUrl && isCurrentWindowNavigation(navigation, transitionId)) {
			const current = currentRef();
			if (current) options.syncUrl(current, true);
		}
	}

	async function openBoard(
		path: string,
		opts: {
			syncUrl?: boolean;
			source?: WindowNavigationSource;
		} = {},
	) {
		const syncUrl = opts.syncUrl ?? true;
		const hadPreview = Boolean(currentRef());
		const ref = { kind: "board" as const, key: path };
		const transitionId = beginNavigation(
			ref,
			opts.source ?? (syncUrl ? "user" : "route"),
		);
		commitActive(ref);
		if (hasTab("board", path)) {
			options.activateBoard(path);
			if (syncUrl) options.syncUrl(ref, hadPreview);
			enforceBudget();
			return;
		}
		const pending = options.openBoard(path);
		if (syncUrl) options.syncUrl(ref, hadPreview);
		await pending;
		enforceBudget();
		if (syncUrl && isCurrentWindowNavigation(navigation, transitionId)) {
			const current = currentRef();
			if (current) options.syncUrl(current, true);
		}
	}

	function openPort(
		port: string,
		url: string,
		opts: {
			autoOpened?: boolean;
			syncUrl?: boolean;
			source?: WindowNavigationSource;
		} = {},
	) {
		if (!isValidPortKey(port)) return;
		const syncUrl = opts.syncUrl ?? true;
		const hadPreview = Boolean(currentRef());
		const ref = { kind: "port" as const, key: port };
		beginNavigation(ref, opts.source ?? (syncUrl ? "user" : "route"));
		commitActive(ref);
		options.openPort(port, url, { autoOpened: opts.autoOpened });
		if (syncUrl) options.syncUrl(ref, hadPreview);
		enforceBudget();
		if (syncUrl) {
			const current = currentRef();
			if (current) options.syncUrl(current, true);
		}
	}

	/**
	 * Show an App preview. Idempotent by window key: repeating re-activates the
	 * existing tab and refreshes its launch state. A file opens its own window.
	 */
	function openApp(
		input: {
			appId: string;
			label?: string;
			launch?: { search?: string; hash?: string } | null;
			openContext: WorkspaceAppOpenContext;
		},
		opts: { syncUrl?: boolean; source?: WindowNavigationSource } = {},
	) {
		const key = appWindowKey(input.appId, input.openContext.file?.path);
		if (!isValidAppKey(key)) return;
		const syncUrl = opts.syncUrl ?? true;
		const hadPreview = Boolean(currentRef());
		const ref = { kind: "app" as const, key };
		beginNavigation(ref, opts.source ?? (syncUrl ? "user" : "route"));
		commitActive(ref);
		options.openApp(input);
		if (syncUrl) options.syncUrl(ref, hadPreview);
		enforceBudget();
		if (syncUrl) {
			const current = currentRef();
			if (current) options.syncUrl(current, true);
		}
	}

	function activate(kind: WindowKind, key: string, syncUrl = true) {
		const ref = { kind, key };
		beginNavigation(ref, syncUrl ? "user" : "route");
		commitActive(ref);
		if (kind === "file") options.activateFile(key);
		else if (kind === "board") options.activateBoard(key);
		else if (kind === "port") options.activatePort(key);
		else options.activateApp(key);
		if (syncUrl) options.syncUrl(ref, true);
	}

	function close(kind: WindowKind, key?: string | null, skipConfirm = false) {
		const current = currentRef();
		const target = key ?? (current?.kind === kind ? current.key : null);
		closeInDomain(kind, key, skipConfirm);
		// A domain may defer the close (e.g. a file flushing its autosave). Only
		// forget what actually went away; `tabClosed` finishes deferred ones.
		if (target && !hasTab(kind, target)) forget(kind, target);
		const ref = reconcileActive();
		beginNavigation(ref, "user");
		options.syncUrl(ref, true);
	}

	/** A tab got a new key (its file moved); keep its order, active ref, and URL. */
	function renameTab(kind: WindowKind, fromKey: string, toKey: string) {
		const from = tabId(kind, fromKey);
		if (from in accessedAt) {
			const { [from]: order, ...rest } = accessedAt;
			accessedAt = { ...rest, [tabId(kind, toKey)]: order };
		}
		if (!windowRefsEqual(activeRef, { kind, key: fromKey })) return;
		activeRef = { kind, key: toKey };
		if (suspended) return;
		navigation = alignWindowNavigation(navigation, activeRef);
		options.syncUrl(activeRef, true);
	}

	/**
	 * A domain finished closing a tab on its own schedule — a deferred file close
	 * waiting on autosave, or an external delete. Re-derive the active surface so
	 * the URL and panel cannot keep pointing at a tab that no longer exists.
	 */
	function tabClosed(kind: WindowKind, key: string) {
		if (suppressCloseReports) return;
		forget(kind, key);
		const previous = activeRef;
		const ref = reconcileActive();
		if (suspended) return;
		if (windowRefsEqual(previous, ref)) return;
		navigation = alignWindowNavigation(navigation, ref);
		options.syncUrl(ref, true);
	}

	function closeActive() {
		const ref = currentRef();
		if (!ref) return;
		close(ref.kind, ref.key);
	}

	function closeAll(
		opts: { syncUrl?: boolean; source?: WindowNavigationSource } = {},
	) {
		const syncUrl = opts.syncUrl ?? true;
		beginNavigation(null, opts.source ?? (syncUrl ? "user" : "route"));
		suspended = false;
		activeRef = null;
		accessedAt = {};
		withSuppressedCloseReports(() => {
			for (const tab of [...options.getFileTabs()]) {
				options.closeFile(tab.path, true);
			}
			for (const tab of [...options.getBoardTabs()]) {
				options.closeBoard(tab.path);
			}
			for (const tab of [...options.getPortTabs()]) {
				options.closePort(tab.port);
			}
			for (const tab of [...options.getAppTabs()]) {
				options.closeApp(tab.key);
			}
		});
		if (syncUrl) options.syncUrl(null, true);
	}

	async function goBackFile() {
		const transitionId = beginNavigation(currentRef(), "user");
		const previous = await options.goBackFile();
		if (!previous || !isCurrentWindowNavigation(navigation, transitionId))
			return null;
		const ref = { kind: "file" as const, key: previous };
		navigation = alignWindowNavigation(navigation, ref);
		commitActive(ref);
		options.syncUrl(ref, true);
		return previous;
	}

	function applyRoute(ref: WindowRef | null) {
		const current = currentRef();
		if (!ref) {
			if (!current && navigation.desiredRef === null)
				return { ok: true as const };
			closeAll({ syncUrl: false, source: "route" });
			return { ok: true as const };
		}
		if (windowRefsEqual(current, ref)) {
			// A shallow-route acknowledgement must not supersede the user transition
			// that produced it; only external route changes begin a new transition.
			if (!windowRefsEqual(navigation.desiredRef, ref))
				beginNavigation(ref, "route");
			commitActive(ref);
			return { ok: true as const };
		}
		if (hasTab(ref.kind, ref.key)) {
			beginNavigation(ref, "route");
			commitActive(ref);
			if (ref.kind === "file") options.activateFile(ref.key);
			else if (ref.kind === "board") options.activateBoard(ref.key);
			else if (ref.kind === "port") options.activatePort(ref.key);
			else options.activateApp(ref.key);
			return { ok: true as const };
		}
		if (ref.kind === "file") {
			void openFile(ref.key, { syncUrl: false, source: "route" });
			return { ok: true as const };
		}
		if (ref.kind === "board") {
			void openBoard(ref.key, { syncUrl: false, source: "route" });
			return { ok: true as const };
		}
		if (ref.kind === "app") {
			const target = parseAppWindowKey(ref.key);
			if (!target) return { ok: true as const };
			openApp(
				{
					appId: target.appId,
					openContext: {
						source: "route",
						...(target.path ? { file: { path: target.path } } : {}),
					},
				},
				{ syncUrl: false, source: "route" },
			);
			return { ok: true as const };
		}
		// Port routes wait for a trusted endpoint before activating a surface.
		const url = options.getPortEndpointUrl(ref.key);
		if (!url) {
			beginNavigation(ref, "route");
			return { ok: false as const, reason: "port-endpoint-pending" as const };
		}
		openPort(ref.key, url, { syncUrl: false, source: "route" });
		return { ok: true as const };
	}

	/**
	 * Leave a Space / FS context. The caller's teardown runs with close reports
	 * suppressed and never syncs the URL: the route this navigation is heading to
	 * is already in the address bar, so a dying context must not write over it.
	 */
	function resetForContext(teardown?: () => void) {
		beginNavigation(null, "restore");
		suspended = false;
		activeRef = null;
		accessedAt = {};
		if (teardown) withSuppressedCloseReports(teardown);
	}

	function syncCurrent() {
		const ref = currentRef();
		beginNavigation(ref, "user");
		options.syncUrl(ref, true);
	}

	return {
		get activeKind() {
			return resolveActiveRef()?.kind ?? null;
		},
		get activeRef() {
			return resolveActiveRef();
		},
		get navigation() {
			return navigation;
		},
		get suspended() {
			return suspended;
		},
		resetForContext,
		suspendForRoute,
		syncCurrent,
		currentRef,
		touch,
		tabClosed,
		retainedAppKeys,
		renameTab,
		openFile,
		openBoard,
		openPort,
		openApp,
		activate,
		close,
		closeActive,
		closeAll,
		goBackFile,
		applyRoute,
		enforceBudget,
	};
}
