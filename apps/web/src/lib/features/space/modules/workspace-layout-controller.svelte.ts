import { DESKTOP_SHELL_MIN_WIDTH_PX } from "#lib/layout/breakpoints.ts";
import type { ResizeStart } from "#lib/layout/pointer-resize.ts";
import { uiState, type WorkspacePresentation } from "#lib/stores/ui.svelte.ts";
import {
	filesChromeEffectivelyHidden,
	MAIN_PANEL_MIN_WIDTH,
	mainCollapseArmed,
	maxMainPanelWidth,
	resolveFilesChromeToggle,
} from "./layout-geometry.ts";

export type { WorkspacePresentation };
export type MobileSurface = "main" | "files" | "preview";

const MAIN_PANEL_WIDTH_VAR = "--main-panel-width";

export function createWorkspaceLayoutController(options: {
	getIsCompact: () => boolean;
	getWorkspaceBodyEl: () => HTMLDivElement | null;
	getFilesAvailable: () => boolean;
	getHasPreview: () => boolean;
}) {
	let mobileSurface = $state<MobileSurface>("main");
	let mainCollapsePending = $state(false);

	const presentation = $derived(uiState.workspacePresentation);
	const mainHidden = $derived(
		uiState.mainPanelHidden &&
			options.getHasPreview() &&
			!uiState.filesColumnHidden &&
			!options.getIsCompact(),
	);

	const treeVisible = $derived(
		options.getFilesAvailable() && !uiState.rightSidebarCollapsed,
	);

	function toggleFocus() {
		if (options.getIsCompact()) return;
		if (presentation === "focus") uiState.exitFocus();
		else uiState.enterFocus();
	}

	function exitFocus() {
		mainCollapsePending = false;
		if (presentation === "focus") uiState.exitFocus();
	}

	function setMainHidden(hidden: boolean) {
		if (options.getIsCompact() || uiState.mainPanelHidden === hidden) return;
		uiState.setMainPanelHidden(hidden);
	}

	function toggleMain() {
		setMainHidden(!mainHidden);
	}

	/**
	 * Drag the main/preview divider. Frames paint the CSS variable directly (no
	 * Svelte churn, so preview iframes never remount) and commit once on
	 * release. Pulling well below the main panel minimum arms hiding it.
	 */
	const mainResize: ResizeStart = () => {
		const body = options.getWorkspaceBodyEl();
		if (options.getIsCompact() || mainHidden || !body) return null;
		const startWidth =
			body.querySelector<HTMLElement>(".workspace-main")?.offsetWidth ??
			uiState.mainPanelWidth;
		const maxWidth = maxMainPanelWidth(
			body.clientWidth,
			treeVisible ? uiState.rightSidebarWidth : 0,
		);
		let liveWidth = startWidth;
		return {
			move: (dx) => {
				const desired = startWidth + dx;
				mainCollapsePending = mainCollapseArmed(desired, startWidth);
				liveWidth = Math.min(Math.max(MAIN_PANEL_MIN_WIDTH, desired), maxWidth);
				body.style.setProperty(MAIN_PANEL_WIDTH_VAR, `${liveWidth}px`);
			},
			end: (completed) => {
				const collapse = completed && mainCollapsePending;
				mainCollapsePending = false;
				if (completed && !collapse) {
					uiState.setMainPanelWidth(liveWidth);
					return;
				}
				body.style.setProperty(
					MAIN_PANEL_WIDTH_VAR,
					`${uiState.mainPanelWidth}px`,
				);
				if (collapse) setMainHidden(true);
			},
		};
	};

	function setMobileSurface(next: MobileSurface) {
		mobileSurface = next;
		if (next === "files" && options.getFilesAvailable()) {
			uiState.mobileRightDrawerOpen = true;
		} else if (next !== "files") {
			uiState.mobileRightDrawerOpen = false;
		}
	}

	function showFilesMobile() {
		if (!options.getFilesAvailable()) return;
		setMobileSurface("files");
	}

	function showPreviewMobile() {
		setMobileSurface("preview");
	}

	function showMainMobile() {
		setMobileSurface("main");
	}

	function handleCompactChange(isCompact: boolean) {
		if (isCompact) {
			if (options.getHasPreview()) mobileSurface = "preview";
			else if (uiState.mobileRightDrawerOpen) mobileSurface = "files";
			else mobileSurface = "main";
			return;
		}
		if (mobileSurface === "files") {
			uiState.mobileRightDrawerOpen = false;
		}
		mobileSurface = "main";
	}

	function isCompactViewport() {
		// Prefer the page's reactive compact signal so header/toggle stay in
		// lockstep with layout; fall back to width when called outside the page.
		if (typeof options.getIsCompact === "function")
			return options.getIsCompact();
		if (typeof window === "undefined") return false;
		return window.innerWidth < DESKTOP_SHELL_MIN_WIDTH_PX;
	}

	/**
	 * Whether the Files chrome is effectively visible to the user.
	 * A collapsed tree with no preview paints as empty (0 width) even when
	 * `filesColumnHidden` is still false — treat that as hidden for header UI.
	 */
	function getFilesChromeVisibility() {
		return {
			isCompact: isCompactViewport(),
			mobileDrawerOpen: uiState.mobileRightDrawerOpen,
			filesColumnHidden: uiState.filesColumnHidden,
			treeCollapsed: uiState.rightSidebarCollapsed,
			hasPreview: options.getHasPreview(),
		};
	}

	function isFilesChromeEffectivelyHidden() {
		return filesChromeEffectivelyHidden(getFilesChromeVisibility());
	}

	function toggleMobileDrawer() {
		const nextOpen = !uiState.mobileRightDrawerOpen;
		uiState.mobileRightDrawerOpen = nextOpen;
		mobileSurface = nextOpen
			? "files"
			: options.getHasPreview()
				? "preview"
				: "main";
	}

	/**
	 * Main-header control: show/hide the entire Files column
	 * (preview stage + file tree). Does not discard open tabs.
	 *
	 * Intentionally does not gate on `getFilesAvailable()` — the header button
	 * is only rendered when files are available, and blocking on that signal
	 * caused first-click no-ops while space was still bootstrapping.
	 */
	function toggleFilesColumn() {
		if (isCompactViewport()) {
			// Mobile: drawer for tree; preview is full-screen overlay.
			toggleMobileDrawer();
			return;
		}
		uiState.setFilesColumnHidden(!uiState.filesColumnHidden);
	}

	/**
	 * Main-header control with consistent show/hide semantics.
	 * If chrome is already effectively hidden (empty rail / drawer closed),
	 * the first click always reveals something visible (column + tree).
	 */
	function toggleFilesChrome() {
		const action = resolveFilesChromeToggle(getFilesChromeVisibility());
		if (action === "toggle-mobile" || action === "hide") {
			toggleFilesColumn();
			return;
		}
		if (uiState.filesColumnHidden) uiState.setFilesColumnHidden(false);
		// Empty rail or fully hidden: always open the tree so the click paints.
		if (uiState.rightSidebarCollapsed) toggleTree();
	}

	function toggleTree() {
		if (isCompactViewport()) {
			toggleMobileDrawer();
			return;
		}
		const nextCollapsed = !uiState.rightSidebarCollapsed;
		uiState.setRightSidebarCollapsed(nextCollapsed);
		// Collapsing the tree with no preview leaves a 0-width empty rail —
		// fold the whole Files column so header state stays consistent.
		if (nextCollapsed && !options.getHasPreview()) {
			uiState.setFilesColumnHidden(true);
			return;
		}
		// Expanding tree while column was folded: reveal it.
		if (!nextCollapsed && uiState.filesColumnHidden) {
			uiState.setFilesColumnHidden(false);
		}
	}

	return {
		get presentation() {
			return presentation;
		},
		get mobileSurface() {
			return mobileSurface;
		},
		get focusMode() {
			return presentation === "focus";
		},
		get mainHidden() {
			return mainHidden;
		},
		get mainCollapsePending() {
			return mainCollapsePending;
		},
		get treeVisible() {
			return treeVisible;
		},
		get filesColumnHidden() {
			return uiState.filesColumnHidden;
		},
		get filesChromeEffectivelyHidden() {
			return isFilesChromeEffectivelyHidden();
		},
		toggleFocus,
		exitFocus,
		toggleMain,
		setMainHidden,
		handleCompactChange,
		mainResize,
		toggleTree,
		toggleFilesColumn,
		toggleFilesChrome,
		setFilesColumnHidden: (hidden: boolean) => {
			uiState.setFilesColumnHidden(hidden);
		},
		setMobileSurface,
		showFilesMobile,
		showPreviewMobile,
		showMainMobile,
	};
}
