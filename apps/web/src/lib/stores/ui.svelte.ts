// UI state shared across layout and pages
// Using a class to wrap $state so it can be mutated from imports

import { MAIN_PANEL_MIN_WIDTH } from "#lib/features/space/modules/layout-geometry.ts";
import {
	resolveDefaultLayoutGeometry,
	type WorkspaceDefaultLayout,
} from "#lib/features/space/modules/workspace-default-layout.ts";

type LayoutPrefKey =
	| "leftSidebarWidth"
	| "rightSidebarWidth"
	| "mainPanelWidth"
	| "rightSidebarCollapsed"
	| "leftSidebarCollapsed"
	| "filesColumnHidden"
	| "workspacePresentation"
	| "mainPanelHidden"
	| "workspaceLayoutSnapshot";

const LEGACY_STORAGE_KEYS: Partial<Record<LayoutPrefKey, string>> = {
	leftSidebarWidth: "cohub:layout:left-sidebar-width",
	rightSidebarWidth: "cohub:layout:right-sidebar-width",
	rightSidebarCollapsed: "cohub:layout:right-sidebar-collapsed",
	leftSidebarCollapsed: "cohub:layout:left-sidebar-collapsed",
	filesColumnHidden: "cohub:layout:files-column-hidden",
	workspacePresentation: "cohub:layout:workspace-presentation",
	workspaceLayoutSnapshot: "cohub:layout:workspace-layout-snapshot",
};

const STORAGE_PREFIX = "cohub:layout:v2";
const GLOBAL_LAYOUT_SCOPE = "global";

export type WorkspacePresentation = "default" | "focus";

export type WorkspaceLayoutSnapshot = {
	leftSidebarCollapsed: boolean;
	rightSidebarCollapsed: boolean;
	filesColumnHidden: boolean;
	mainPanelWidth: number;
	mainPanelHidden: boolean;
};

function layoutStorageKey(scope: string, key: string) {
	return `${STORAGE_PREFIX}:${scope}:${key}`;
}

function layoutScopeKey(spaceId?: string | null) {
	return spaceId ? `space:${encodeURIComponent(spaceId)}` : GLOBAL_LAYOUT_SCOPE;
}

const LEFT_SIDEBAR_MIN = 220;
const LEFT_SIDEBAR_MAX = 420;
const LEFT_SIDEBAR_DEFAULT = 240;
/** Collapsed desktop rail width (icon column). */
const LEFT_SIDEBAR_RAIL = 52;
const RIGHT_SIDEBAR_MIN = 260;
const RIGHT_SIDEBAR_MAX = 520;
const RIGHT_SIDEBAR_DEFAULT = 320;
const MAIN_PANEL_DEFAULT_WIDTH = 400;

function clamp(value: number, min: number, max: number) {
	return Math.min(max, Math.max(min, value));
}

function readStorage(key: string) {
	if (typeof window === "undefined") return null;

	try {
		return window.localStorage.getItem(key);
	} catch {
		return null;
	}
}

function writeStorage(key: string, value: string) {
	if (typeof window === "undefined") return;

	try {
		window.localStorage.setItem(key, value);
	} catch {
		// Ignore storage failures so layout interactions remain functional.
	}
}

class UIState {
	mobileDrawerOpen = $state(false);
	mobileRightDrawerOpen = $state(false);
	/**
	 * Right drawer is temporarily slid away so the surface behind it can receive
	 * a drop. Transient (never persisted): a touch drag out of the files drawer
	 * needs the board underneath to be visible and hit-testable.
	 */
	mobileRightDrawerRetracted = $state(false);
	/** Drag offset for right drawer gesture tracking (shared from layout) */
	rightDragOffsetPx = $state(0);
	/** Whether a right drawer drag is in progress (shared from layout) */
	rightIsDragging = $state(false);
	settingsOverlayOpen = $state(false);
	leftSidebarWidth = $state(LEFT_SIDEBAR_DEFAULT);
	rightSidebarWidth = $state(RIGHT_SIDEBAR_DEFAULT);
	mainPanelWidth = $state(MAIN_PANEL_DEFAULT_WIDTH);
	leftSidebarCollapsed = $state(false);
	rightSidebarCollapsed = $state(false);
	/** Hide the whole Files column (preview stage + tree). Space-scoped. */
	filesColumnHidden = $state(false);
	workspacePresentation = $state<WorkspacePresentation>("default");
	mainPanelHidden = $state(false);
	workspaceLayoutSnapshot = $state<WorkspaceLayoutSnapshot | null>(null);
	private layoutScope: string | null = null;
	/** Scope for which a space default layout has been evaluated already. */
	private defaultLayoutAppliedScope: string | null = null;

	private readLayoutPref(key: LayoutPrefKey) {
		const legacyKey = LEGACY_STORAGE_KEYS[key];
		return (
			readStorage(
				layoutStorageKey(this.layoutScope ?? GLOBAL_LAYOUT_SCOPE, key),
			) ?? (legacyKey ? readStorage(legacyKey) : null)
		);
	}

	private writeLayoutPref(key: LayoutPrefKey, value: string) {
		writeStorage(
			layoutStorageKey(this.layoutScope ?? GLOBAL_LAYOUT_SCOPE, key),
			value,
		);
	}

	/**
	 * Whether the given scope has any scoped layout pref stored (ignores legacy).
	 * A stored key means the layout was settled here before — either by a prior
	 * default-layout application or by an explicit user change — so a space
	 * default must no longer override it.
	 */
	private hasStoredLayoutPrefs(scope: string) {
		const keys = [
			"leftSidebarCollapsed",
			"rightSidebarCollapsed",
			"filesColumnHidden",
			"workspacePresentation",
			"mainPanelWidth",
			"mainPanelHidden",
			"workspacePreviewWidth",
		];
		return keys.some(
			(key) => readStorage(layoutStorageKey(scope, key)) !== null,
		);
	}

	private parseWidth(
		raw: string | null,
		fallback: number,
		min: number,
		max: number,
	) {
		if (!raw) return fallback;
		const parsed = Number(raw);
		return Number.isFinite(parsed) ? clamp(parsed, min, max) : fallback;
	}

	private parseCollapsed(raw: string | null, fallback: boolean) {
		return raw === "true" || raw === "false" ? raw === "true" : fallback;
	}

	private parsePresentation(raw: string | null): WorkspacePresentation {
		return raw === "focus" || raw === "immersive" ? "focus" : "default";
	}

	private parseLayoutSnapshot(
		raw: string | null,
	): WorkspaceLayoutSnapshot | null {
		if (!raw) return null;
		try {
			const parsed: unknown = JSON.parse(raw);
			if (!parsed || typeof parsed !== "object") return null;
			const snap = parsed as Record<string, unknown>;
			return {
				leftSidebarCollapsed: snap.leftSidebarCollapsed === true,
				rightSidebarCollapsed: snap.rightSidebarCollapsed === true,
				filesColumnHidden: snap.filesColumnHidden === true,
				mainPanelWidth: this.parseWidth(
					String(snap.mainPanelWidth ?? ""),
					this.mainPanelWidth,
					MAIN_PANEL_MIN_WIDTH,
					Number.MAX_SAFE_INTEGER,
				),
				mainPanelHidden: snap.mainPanelHidden === true,
			};
		} catch {
			return null;
		}
	}

	loadLayoutPrefs(spaceId?: string | null) {
		if (typeof window === "undefined") return;

		const nextScope = layoutScopeKey(spaceId);
		if (this.layoutScope === nextScope) return;
		this.layoutScope = nextScope;

		const rawLeftWidth = this.readLayoutPref("leftSidebarWidth");
		const rawRightWidth = this.readLayoutPref("rightSidebarWidth");
		const rawMainPanelWidth = this.readLayoutPref("mainPanelWidth");
		const rawLeftCollapsed = this.readLayoutPref("leftSidebarCollapsed");
		const rawRightCollapsed = this.readLayoutPref("rightSidebarCollapsed");
		const rawFilesColumnHidden = this.readLayoutPref("filesColumnHidden");
		const rawPresentation = this.readLayoutPref("workspacePresentation");
		const rawMainPanelHidden = this.readLayoutPref("mainPanelHidden");
		const rawLayoutSnapshot = this.readLayoutPref("workspaceLayoutSnapshot");

		this.leftSidebarWidth = this.parseWidth(
			rawLeftWidth,
			LEFT_SIDEBAR_DEFAULT,
			LEFT_SIDEBAR_MIN,
			LEFT_SIDEBAR_MAX,
		);
		this.rightSidebarWidth = this.parseWidth(
			rawRightWidth,
			RIGHT_SIDEBAR_DEFAULT,
			RIGHT_SIDEBAR_MIN,
			RIGHT_SIDEBAR_MAX,
		);
		this.mainPanelWidth = this.parseWidth(
			rawMainPanelWidth,
			MAIN_PANEL_DEFAULT_WIDTH,
			MAIN_PANEL_MIN_WIDTH,
			Number.MAX_SAFE_INTEGER,
		);
		this.leftSidebarCollapsed = this.parseCollapsed(rawLeftCollapsed, false);
		this.rightSidebarCollapsed = this.parseCollapsed(rawRightCollapsed, false);
		this.filesColumnHidden = this.parseCollapsed(rawFilesColumnHidden, false);
		this.mainPanelHidden = this.parseCollapsed(rawMainPanelHidden, false);

		const snapshot = this.parseLayoutSnapshot(rawLayoutSnapshot);
		let presentation = this.parsePresentation(rawPresentation);
		if (presentation !== "default" && !snapshot) presentation = "default";
		this.workspaceLayoutSnapshot = presentation === "default" ? null : snapshot;
		this.workspacePresentation = presentation;
		// Intentionally not persisting here: writing on load would settle the scope
		// with built-in defaults and block a space default layout from ever applying
		// (e.g. first mobile visit poisoning a later desktop entry). Legacy prefs
		// migrate lazily on the next real setter write.
	}

	setLeftSidebarWidth(width: number, persist = true) {
		const next = clamp(width, LEFT_SIDEBAR_MIN, LEFT_SIDEBAR_MAX);
		this.leftSidebarWidth = next;
		if (persist) this.writeLayoutPref("leftSidebarWidth", String(next));
	}

	setRightSidebarWidth(width: number, persist = true) {
		const next = clamp(width, RIGHT_SIDEBAR_MIN, RIGHT_SIDEBAR_MAX);
		this.rightSidebarWidth = next;
		if (persist) this.writeLayoutPref("rightSidebarWidth", String(next));
	}

	setMainPanelWidth(width: number) {
		const next = Math.round(Math.max(MAIN_PANEL_MIN_WIDTH, width));
		if (!Number.isFinite(next)) return;
		this.mainPanelWidth = next;
		this.writeLayoutPref("mainPanelWidth", String(next));
	}

	setLeftSidebarCollapsed(collapsed: boolean) {
		this.leftSidebarCollapsed = collapsed;
		this.writeLayoutPref("leftSidebarCollapsed", String(collapsed));
	}

	setRightSidebarCollapsed(collapsed: boolean) {
		this.rightSidebarCollapsed = collapsed;
		this.writeLayoutPref("rightSidebarCollapsed", String(collapsed));
	}

	setFilesColumnHidden(hidden: boolean) {
		this.filesColumnHidden = hidden;
		this.writeLayoutPref("filesColumnHidden", String(hidden));
	}

	setWorkspacePresentation(presentation: WorkspacePresentation) {
		this.workspacePresentation = presentation;
		this.writeLayoutPref("workspacePresentation", presentation);
	}

	setMainPanelHidden(hidden: boolean) {
		this.mainPanelHidden = hidden;
		this.writeLayoutPref("mainPanelHidden", String(hidden));
	}

	setWorkspaceLayoutSnapshot(snapshot: WorkspaceLayoutSnapshot | null) {
		this.workspaceLayoutSnapshot = snapshot;
		this.writeLayoutPref(
			"workspaceLayoutSnapshot",
			snapshot ? JSON.stringify(snapshot) : "",
		);
	}

	enterFocus(mainHidden = this.mainPanelHidden) {
		if (this.workspacePresentation !== "focus") {
			this.setWorkspaceLayoutSnapshot({
				leftSidebarCollapsed: this.leftSidebarCollapsed,
				rightSidebarCollapsed: this.rightSidebarCollapsed,
				filesColumnHidden: this.filesColumnHidden,
				mainPanelWidth: this.mainPanelWidth,
				mainPanelHidden: this.mainPanelHidden,
			});
			this.setWorkspacePresentation("focus");
		}
		this.setLeftSidebarCollapsed(true);
		this.setRightSidebarCollapsed(true);
		this.setFilesColumnHidden(false);
		this.setMainPanelWidth(MAIN_PANEL_MIN_WIDTH);
		this.setMainPanelHidden(mainHidden);
	}

	exitFocus() {
		const snapshot = this.workspaceLayoutSnapshot;
		this.setWorkspacePresentation("default");
		this.setWorkspaceLayoutSnapshot(null);
		if (!snapshot) return;
		this.setLeftSidebarCollapsed(snapshot.leftSidebarCollapsed);
		this.setRightSidebarCollapsed(snapshot.rightSidebarCollapsed);
		this.setFilesColumnHidden(snapshot.filesColumnHidden);
		this.setMainPanelWidth(snapshot.mainPanelWidth);
		this.setMainPanelHidden(snapshot.mainPanelHidden);
	}

	toggleLeftSidebarCollapsed() {
		this.setLeftSidebarCollapsed(!this.leftSidebarCollapsed);
	}

	toggleRightSidebarCollapsed() {
		this.setRightSidebarCollapsed(!this.rightSidebarCollapsed);
	}

	/**
	 * Apply a space's default layout as a fallback on a fresh entry (no stored
	 * layout prefs for this scope yet). Idempotent per scope per session.
	 *
	 * On mobile: skips desktop geometry but still signals whether the configured
	 * preview should be opened so the caller can push the `?preview=` query.
	 *
	 * Freshness is re-evaluated at call time (not cached at load time) so async
	 * config arriving after the user already touched the layout won't clobber it.
	 *
	 * Returns true when the configured preview should be opened.
	 */
	applySpaceDefaultLayoutIfFresh(
		spaceId: string,
		layout: WorkspaceDefaultLayout,
		options: { hasRoutePreview: boolean; isMobile: boolean },
	): boolean {
		if (typeof window === "undefined") return false;
		this.loadLayoutPrefs(spaceId);
		const scope = layoutScopeKey(spaceId);
		if (this.defaultLayoutAppliedScope === scope) return false;
		this.defaultLayoutAppliedScope = scope;

		// Re-check at apply time: a user action after page load (e.g. collapsing
		// sidebar while config was still loading) writes a scoped key, which means
		// we should no longer override their layout.
		if (this.hasStoredLayoutPrefs(scope)) return false;

		const { presentation, mainHidden, ...geo } = resolveDefaultLayoutGeometry(
			layout,
			options.hasRoutePreview,
		);

		// On mobile skip desktop geometry entirely; the caller may still open the
		// configured preview as a full-screen surface.
		if (options.isMobile) return geo.openWindow;

		this.setLeftSidebarCollapsed(geo.leftSidebarCollapsed);
		this.setRightSidebarCollapsed(geo.rightSidebarCollapsed);
		this.setFilesColumnHidden(geo.filesColumnHidden);
		this.setWorkspacePresentation("default");
		this.setWorkspaceLayoutSnapshot(null);
		if (presentation === "focus") this.enterFocus(mainHidden);
		return geo.openWindow;
	}
}

export const uiState = new UIState();
export { LEFT_SIDEBAR_RAIL };
