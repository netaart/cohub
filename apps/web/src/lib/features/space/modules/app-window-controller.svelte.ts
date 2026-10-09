import type { AppWindowState } from "@cohub/protocol/app-runtime";
import type { AppComposerChip } from "@cohub/protocol/app-surface";
import type { AppDetailResponse } from "@neta-art/cohub";
import { appDisplayTitle } from "$lib/app-page-meta";
import { loadAppPreview } from "$lib/features/app/app-open";
import { isNewerAppSnapshot } from "$lib/features/app/app-realtime";
import type { AppSurfaceRegistry } from "$lib/features/app/surface-registry";
import { getLocale } from "$lib/i18n/locale.svelte";
import { m } from "$lib/paraglide/messages.js";
import { appWindowKey } from "./app-window-key";
import { createRequestDedupe } from "./request-dedupe";
import {
	createWorkspaceAppInvocation,
	type WorkspaceAppInvocation,
	type WorkspaceAppOpenContext,
} from "./workspace-app-context";

export type AppLaunchState = { search?: string; hash?: string };

export type InlineAppPreview = {
	/** Stable for the window's lifetime, so a rename never remounts its frame. */
	id: number;
	/** Window key: the App id, or the App id bound to the file it opened. */
	key: string;
	appId: string;
	mountKey: number;
	label: string;
	detail: AppDetailResponse | null;
	loading: boolean;
	error: string | null;
	refreshError: string | null;
	launch: AppLaunchState | null;
	invocation: WorkspaceAppInvocation;
	composerChip: AppComposerChip | null;
	/** What the App last reported about its window. */
	windowState: AppWindowState;
	/** The host is waiting for the App to persist its work. */
	flushing: boolean;
};

const INITIAL_WINDOW_STATE: AppWindowState = {
	title: null,
	status: "idle",
	dirty: false,
};

type AppPreviewControllerOptions = {
	getSpaceId: () => string;
	surfaces: AppSurfaceRegistry;
	onOpenPanel?: () => void;
	onClosePanel?: () => void;
	/** A tab actually went away, so a coordinator can re-derive the active ref. */
	onAppClosed?: (key: string) => void;
	loadApp?: (appId: string) => Promise<AppDetailResponse>;
	loadPublicApp?: (appId: string) => Promise<AppDetailResponse>;
	/** Ask a mounted App window to persist its work; resolves whether that worked. */
	prepareClose?: (key: string) => Promise<boolean>;
	/** Ask the viewer whether unsaved work may be discarded. */
	confirmDiscard?: (label: string) => boolean;
};

function invocationContextsEqual(
	left: WorkspaceAppInvocation,
	right: WorkspaceAppInvocation,
) {
	return (
		left?.surface === right?.surface &&
		left?.source === right?.source &&
		left?.spaceId === right?.spaceId &&
		left?.sessionId === right?.sessionId &&
		left?.turnId === right?.turnId &&
		left?.toolCallId === right?.toolCallId &&
		left?.file?.path === right?.file?.path &&
		left?.id === right?.id
	);
}

const confirmDiscardInBrowser = (label: string) =>
	confirm(m.app_close_unsaved({ name: label }, { locale: getLocale() }));

export function createAppPreviewController(
	options: AppPreviewControllerOptions,
) {
	let previews = $state<InlineAppPreview[]>([]);
	let activeKey = $state<string | null>(null);
	let nextMountKey = 0;
	let nextWindowId = 0;
	const requests = createRequestDedupe();
	// Per-window bookkeeping follows the stable window id, so a rename that
	// changes the key mid-flight never strands or misroutes it.
	const detailSettled = new Map<number, Promise<void>>();
	const loadTokens = new Map<number, number>();
	/** Windows persisting their work, shared by every caller that waits on it. */
	const flushing = new Map<number, Promise<boolean>>();
	/** Windows settling a close or reload, so the viewer is asked once. */
	const settling = new Map<number, Promise<boolean>>();
	const confirmDiscard = options.confirmDiscard ?? confirmDiscardInBrowser;

	const loadApp =
		options.loadApp ??
		(async (appId: string) => (await import("$lib/sdk")).sdk.apps.get(appId));
	const loadPublicApp =
		options.loadPublicApp ??
		(async (appId: string) =>
			(await import("$lib/sdk")).sdk.apps.getPublicById(appId));

	/**
	 * A public App in a Space we cannot view is still previewable, and
	 * desktop commands accept public references, so a denied member read falls
	 * back to the public one rather than showing a permission error.
	 */
	async function loadDetailFor(appId: string): Promise<AppDetailResponse> {
		return loadAppPreview(
			{ get: loadApp, getPublicById: loadPublicApp },
			appId,
		);
	}

	const find = (key: string) => previews.find((item) => item.key === key);
	const byId = (id: number) => previews.find((item) => item.id === id);

	function patch(id: number, next: Partial<InlineAppPreview>) {
		previews = previews.map((item) =>
			item.id === id ? { ...item, ...next } : item,
		);
	}

	async function loadDetail(
		key: string,
		loadOptions: {
			force?: boolean;
			remount?: boolean;
			/** The viewer already settled unsaved work, so a remount may drop it. */
			settled?: boolean;
		} = {},
	) {
		const tab = find(key);
		if (!tab) return;
		const { id, appId } = tab;
		const requestSpaceId = options.getSpaceId();
		const token = (loadTokens.get(id) ?? 0) + 1;
		loadTokens.set(id, token);
		patch(id, { loading: true, error: null, refreshError: null });
		const settle = (async () => {
			try {
				// Windows of the same App share one request.
				const detail = await requests.run(
					`app:${appId}`,
					() => loadDetailFor(appId),
					{ force: loadOptions.force },
				);
				const current = byId(id);
				if (
					options.getSpaceId() !== requestSpaceId ||
					loadTokens.get(id) !== token ||
					!current
				)
					return;
				const changed = isNewerAppSnapshot(
					current.detail?.app ?? null,
					detail.app,
				);
				if (current.detail && !changed) {
					patch(id, { loading: false, refreshError: null });
					return;
				}
				// A new version waits for the next reload while work is unsaved.
				const remount =
					loadOptions.remount &&
					changed &&
					(loadOptions.settled || !current.windowState.dirty);
				patch(id, {
					detail,
					loading: false,
					error: null,
					refreshError: null,
					label: appDisplayTitle(detail.app.meta, detail.app.slug),
					// The new document starts clean and reports its own state.
					...(remount
						? { mountKey: ++nextMountKey, windowState: INITIAL_WINDOW_STATE }
						: {}),
				});
			} catch (cause) {
				if (
					options.getSpaceId() !== requestSpaceId ||
					loadTokens.get(id) !== token
				)
					return;
				if (byId(id)?.detail) {
					patch(id, {
						loading: false,
						refreshError:
							cause instanceof Error
								? cause.message
								: "Failed to refresh this App.",
					});
					return;
				}
				patch(id, {
					loading: false,
					error:
						cause instanceof Error ? cause.message : "Failed to load this App.",
				});
			}
		})();
		detailSettled.set(id, settle);
		await settle;
	}

	function openApp(input: {
		appId: string;
		label?: string;
		launch?: AppLaunchState | null;
		openContext: WorkspaceAppOpenContext;
	}) {
		const key = appWindowKey(input.appId, input.openContext.file?.path);
		const invocation = createWorkspaceAppInvocation(
			options.getSpaceId(),
			input.openContext,
		);
		const existing = find(key);
		if (existing && input.openContext.source === "route") {
			// Back / forward and URL sync show a window; they do not open it again.
			activeKey = key;
			options.onOpenPanel?.();
			return;
		}
		if (existing) {
			const launch = input.launch ?? null;
			const launchChanged =
				input.launch !== undefined &&
				((existing.launch?.search ?? "") !== (launch?.search ?? "") ||
					(existing.launch?.hash ?? "") !== (launch?.hash ?? ""));
			const invocationChanged = !invocationContextsEqual(
				existing.invocation,
				invocation,
			);
			if (launchChanged || invocationChanged) {
				patch(existing.id, {
					...(launchChanged ? { launch } : {}),
					invocation,
				});
			}
			activeKey = key;
			options.onOpenPanel?.();
			if (!existing.detail && !existing.loading) void loadDetail(key);
			return;
		}
		previews = [
			...previews,
			{
				id: ++nextWindowId,
				key,
				appId: input.appId,
				mountKey: ++nextMountKey,
				label: input.label?.trim() || "App",
				detail: null,
				loading: true,
				error: null,
				launch: input.launch ?? null,
				invocation,
				composerChip: null,
				refreshError: null,
				windowState: INITIAL_WINDOW_STATE,
				flushing: false,
			},
		];
		activeKey = key;
		options.onOpenPanel?.();
		void loadDetail(key);
	}

	function activateApp(key: string) {
		if (!find(key)) return;
		activeKey = key;
		options.onOpenPanel?.();
	}

	function isDirty(key: string) {
		return find(key)?.windowState.dirty === true;
	}

	/** Let a dirty App persist its work. Resolves whether it is clean now. */
	function flush(key: string): Promise<boolean> {
		const tab = find(key);
		if (!tab?.windowState.dirty) return Promise.resolve(true);
		const { id } = tab;
		const existing = flushing.get(id);
		if (existing) return existing;
		// The tab shows the wait, even if the App never reports `saving` itself.
		patch(id, { flushing: true });
		const run = (async () => {
			const flushed = (await options.prepareClose?.(key)) ?? false;
			return flushed || byId(id)?.windowState.dirty !== true;
		})().finally(() => {
			flushing.delete(id);
			patch(id, { flushing: false });
		});
		flushing.set(id, run);
		return run;
	}

	/** Flush, then ask only if that failed. Resolves whether it may close. */
	function settle(key: string): Promise<boolean> {
		const tab = find(key);
		if (!tab?.windowState.dirty) return Promise.resolve(true);
		const { id } = tab;
		const existing = settling.get(id);
		if (existing) return existing;
		const run = (async () => {
			const clean = await flush(key);
			const current = byId(id);
			if (!current) return false;
			return (
				clean || confirmDiscard(current.windowState.title ?? current.label)
			);
		})().finally(() => settling.delete(id));
		settling.set(id, run);
		return run;
	}

	function closeApp(key = activeKey, skipConfirm = false) {
		if (!key) return;
		const index = previews.findIndex((item) => item.key === key);
		if (index < 0) return;
		const { id } = previews[index];
		if (!skipConfirm && isDirty(key)) {
			// Deferred like a file flushing its autosave; the close reports itself.
			// The file may move meanwhile, so close whatever key it holds by then.
			void settle(key).then((ok) => {
				const current = byId(id);
				if (ok && current) closeApp(current.key, true);
			});
			return;
		}
		const nextPreviews = previews.filter((item) => item.id !== id);
		previews = nextPreviews;
		options.surfaces.unregister({ id: key, surface: "app" });
		detailSettled.delete(id);
		loadTokens.delete(id);
		if (activeKey === key) {
			activeKey =
				nextPreviews[Math.max(0, index - 1)]?.key ??
				nextPreviews[0]?.key ??
				null;
		}
		if (nextPreviews.length === 0) options.onClosePanel?.();
		options.onAppClosed?.(key);
	}

	/** Context teardown; the navigation guard already settled dirty Apps. */
	function closeAll() {
		for (const item of [...previews]) closeApp(item.key, true);
	}

	/** Windows bound to `path`, or to files under it when it is a folder. */
	const boundTo = (
		item: InlineAppPreview,
		path: string,
		recursive: boolean,
	) => {
		const file = item.invocation.file?.path;
		return Boolean(
			file && (file === path || (recursive && file.startsWith(`${path}/`))),
		);
	};

	/**
	 * Windows follow a moved file. A window on a replaced file closes: saving it
	 * would overwrite the moved-in content. Returns `[fromKey, toKey]` pairs.
	 */
	function renamePath(fromPath: string, toPath: string) {
		// A local rename and its realtime echo both land here; the echo finds
		// nothing left at `fromPath` and must not touch the moved windows.
		if (!previews.some((entry) => boundTo(entry, fromPath, true))) return [];
		for (const item of previews.filter(
			(entry) =>
				boundTo(entry, toPath, true) && !boundTo(entry, fromPath, true),
		)) {
			closeApp(item.key, true);
		}
		const moved = new Map<string, string>();
		previews = previews.map((item) => {
			const file = item.invocation.file?.path;
			if (!file || !boundTo(item, fromPath, true)) return item;
			const path = `${toPath}${file.slice(fromPath.length)}`;
			const key = appWindowKey(item.appId, path);
			moved.set(item.key, key);
			return {
				...item,
				key,
				invocation: { ...item.invocation, file: { path } },
			};
		});
		for (const [from, to] of moved) {
			if (activeKey === from) activeKey = to;
		}
		return [...moved];
	}

	/** A deleted file closes its clean windows; dirty ones stay for the viewer. */
	function closeFilesAtPath(path: string, recursive = false) {
		for (const item of previews.filter(
			(entry) => boundTo(entry, path, recursive) && !entry.windowState.dirty,
		)) {
			closeApp(item.key, true);
		}
	}

	async function retry(key: string) {
		const tab = find(key);
		if (!tab || !(await settle(key))) return;
		// The file may have moved while it flushed; reload whatever key it holds.
		const current = byId(tab.id);
		if (!current) return;
		void loadDetail(current.key, { force: true, remount: true, settled: true });
	}

	/** A republished App refreshes every window it has open. */
	function refreshIfOpen(appId: string) {
		for (const item of previews.filter((entry) => entry.appId === appId)) {
			void loadDetail(item.key, { force: true, remount: true });
		}
	}

	function setWindowState(key: string, windowState: AppWindowState) {
		const tab = find(key);
		if (tab) patch(tab.id, { windowState });
	}

	/** Whether any App window still holds unsaved work. */
	function hasDirty() {
		return previews.some((item) => item.windowState.dirty);
	}

	/** Flushes every dirty App; resolves whether all are clean. */
	async function flushAll() {
		const flushed = await Promise.all(previews.map((item) => flush(item.key)));
		return flushed.every(Boolean) || !hasDirty();
	}

	function setComposerChip(key: string, chip: AppComposerChip | null) {
		const tab = find(key);
		if (tab) patch(tab.id, { composerChip: chip });
	}

	function callSurface(input: {
		key: string;
		method: string;
		input?: unknown;
		commandId: string;
	}) {
		const tab = find(input.key);
		return options.surfaces.call({
			key: { id: input.key, surface: "app" },
			method: input.method,
			input: input.input,
			commandId: input.commandId,
			// A call right after showing races the fetch and the iframe mount.
			settled: tab && detailSettled.get(tab.id),
			getTarget: () => find(input.key) ?? null,
		});
	}

	function dispose() {
		requests.clear();
		detailSettled.clear();
		loadTokens.clear();
	}

	return {
		get previews() {
			return previews;
		},
		get preview() {
			return (activeKey && find(activeKey)) || null;
		},
		get activeKey() {
			return activeKey;
		},
		openApp,
		activateApp,
		closeApp,
		closeAll,
		renamePath,
		closeFilesAtPath,
		retry,
		refreshIfOpen,
		setWindowState,
		hasDirty,
		flushAll,
		setComposerChip,
		callSurface,
		dispose,
	};
}

export type AppPreviewController = ReturnType<
	typeof createAppPreviewController
>;
