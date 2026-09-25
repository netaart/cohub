import type { AppRuntimeConfigureRequest } from "@cohub/protocol/app-runtime";
import type { AppComposerChip } from "@cohub/protocol/app-surface";
import type {
	AppDetailResponse,
	AppRuntimeInvocationContext,
} from "@neta-art/cohub";
import { appDisplayTitle } from "$lib/app-page-meta";
import { loadAppPreview } from "$lib/features/app/app-open";
import type { AppSurfaceRegistry } from "$lib/features/app/surface-registry";
import {
	type OverlayGeometry,
	type OverlayInputRegion,
	sameGeometry,
	sameInputRegion,
} from "./desktop-layer-geometry";

/** Upper bound on simultaneously mounted overlay iframes. */
export const OVERLAY_MAX = 8;

export type DesktopOverlay = {
	/** One overlay per App, so the App id doubles as the stable key. */
	readonly id: string;
	readonly appId: string;
	/** Bumped on retry so the iframe remounts. */
	mountKey: number;
	label: string;
	detail: AppDetailResponse | null;
	error: string | null;
	invocation: AppRuntimeInvocationContext;
	geometry: OverlayGeometry;
	inputRegion: OverlayInputRegion;
	composerChip: AppComposerChip | null;
};

type DesktopLayerManagerOptions = {
	surfaces: AppSurfaceRegistry;
	loadApp?: (appId: string) => Promise<AppDetailResponse>;
	loadPublicApp?: (appId: string) => Promise<AppDetailResponse>;
};

/**
 * Owns the App surfaces that float above the workspace. Unlike the tab-based
 * preview controllers there is no "active" overlay: every overlay is visible
 * at once and positions itself through `configure.request`.
 */
export function createDesktopLayerManager(options: DesktopLayerManagerOptions) {
	let overlays = $state<DesktopOverlay[]>([]);
	let nextMountKey = 0;
	/** Detail fetch per overlay, so a call issued right after opening waits for it. */
	const detailSettled = new Map<string, Promise<void>>();

	const loadApp =
		options.loadApp ??
		(async (appId: string) => (await import("$lib/sdk")).sdk.apps.get(appId));
	const loadPublicApp =
		options.loadPublicApp ??
		(async (appId: string) =>
			(await import("$lib/sdk")).sdk.apps.getPublicById(appId));

	function find(appId: string) {
		return overlays.find((overlay) => overlay.appId === appId);
	}

	function patch(appId: string, next: Partial<DesktopOverlay>) {
		overlays = overlays.map((overlay) =>
			overlay.appId === appId ? { ...overlay, ...next } : overlay,
		);
	}

	function loadDetail(appId: string) {
		const settle = (async () => {
			try {
				const detail = await loadAppPreview(
					{ get: loadApp, getPublicById: loadPublicApp },
					appId,
				);
				if (!find(appId)) return;
				patch(appId, {
					detail,
					error: null,
					label: appDisplayTitle(detail.app.meta, detail.app.slug),
				});
			} catch (cause) {
				if (!find(appId)) return;
				patch(appId, {
					error:
						cause instanceof Error ? cause.message : "Failed to load this App.",
				});
			}
		})();
		detailSettled.set(appId, settle);
	}

	/** Opens an overlay, or refreshes the invocation of one already showing. */
	function openOverlay(input: {
		appId: string;
		label?: string;
		invocation: AppRuntimeInvocationContext;
	}): "opened" | "activated" | "limit" {
		if (find(input.appId)) {
			patch(input.appId, { invocation: input.invocation });
			return "activated";
		}
		if (overlays.length >= OVERLAY_MAX) return "limit";
		overlays = [
			...overlays,
			{
				id: `overlay:${input.appId}`,
				appId: input.appId,
				mountKey: ++nextMountKey,
				label: input.label?.trim() || "Overlay",
				detail: null,
				error: null,
				invocation: input.invocation,
				geometry: {},
				inputRegion: "none",
				composerChip: null,
			},
		];
		loadDetail(input.appId);
		return "opened";
	}

	function closeOverlay(appId: string) {
		overlays = overlays.filter((overlay) => overlay.appId !== appId);
		detailSettled.delete(appId);
		options.surfaces.unregister({ id: appId, surface: "overlay" });
	}

	function dismissAll() {
		for (const overlay of overlays) closeOverlay(overlay.appId);
	}

	/** Calls a method the App registered via `client.app.surface.handle()`. */
	function callSurface(input: {
		appId: string;
		method: string;
		input?: unknown;
		commandId: string;
	}) {
		return options.surfaces.call({
			key: { id: input.appId, surface: "overlay" },
			method: input.method,
			input: input.input,
			commandId: input.commandId,
			settled: detailSettled.get(input.appId),
			getTarget: () => find(input.appId) ?? null,
		});
	}

	/**
	 * Overlays have no "active" one, so the chip shown in the composer is the
	 * most recently set: setting moves the overlay to the end of the list.
	 */
	function setComposerChip(appId: string, chip: AppComposerChip | null) {
		const overlay = find(appId);
		if (!overlay) return;
		const rest = overlays.filter((item) => item.appId !== appId);
		overlays = chip
			? [...rest, { ...overlay, composerChip: chip }]
			: overlays.map((item) =>
					item.appId === appId ? { ...item, composerChip: null } : item,
				);
	}

	/**
	 * Applies a `configure.request`. A present `geometry` replaces the current
	 * shape (`{}` fills the layer); omitting it keeps the current one. Apps
	 * re-send their geometry freely (every render, on resize), so an unchanged
	 * request must not produce a new overlay list.
	 */
	function configure(appId: string, request: AppRuntimeConfigureRequest) {
		const overlay = find(appId);
		if (!overlay) return;
		const geometry = request.geometry ?? overlay.geometry;
		const inputRegion = request.inputRegion ?? overlay.inputRegion;
		if (
			sameGeometry(geometry, overlay.geometry) &&
			sameInputRegion(inputRegion, overlay.inputRegion)
		)
			return;
		patch(appId, { geometry, inputRegion });
	}

	function retry(appId: string) {
		if (!find(appId)) return;
		patch(appId, { mountKey: ++nextMountKey, error: null, detail: null });
		loadDetail(appId);
	}

	return {
		get overlays() {
			return overlays;
		},
		get count() {
			return overlays.length;
		},
		/** The chip the composer should show for overlays, if any. */
		get composerChip() {
			for (let i = overlays.length - 1; i >= 0; i -= 1) {
				const overlay = overlays[i];
				if (overlay.composerChip) {
					return { appId: overlay.appId, chip: overlay.composerChip };
				}
			}
			return null;
		},
		find,
		openOverlay,
		closeOverlay,
		dismissAll,
		callSurface,
		configure,
		retry,
		setComposerChip,
	};
}

export type DesktopLayerManager = ReturnType<typeof createDesktopLayerManager>;
