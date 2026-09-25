<script lang="ts">
import "../../app.css";
import { onMount } from "svelte";
import { onNavigate } from "$app/navigation";
import { page } from "$app/state";
import { scheduleCacheCleanup } from "$lib/cache/cleanup";
import BillingConversionCenter from "$lib/components/BillingConversionCenter.svelte";
import CenteredLoading from "$lib/components/CenteredLoading.svelte";
import CommandPalette from "$lib/components/CommandPalette.svelte";
import DragGhostLayer from "$lib/components/DragGhostLayer.svelte";
import HelpPanel from "$lib/components/HelpPanel.svelte";
import MediaLightbox from "$lib/components/MediaLightbox.svelte";
import MobileSidebarDrawer from "$lib/components/MobileSidebarDrawer.svelte";
import { mediaLightbox } from "$lib/components/media-lightbox";
import Sidebar from "$lib/components/Sidebar.svelte";
import TurnNotificationStack from "$lib/components/TurnNotificationStack.svelte";
import { createDeferredMount } from "$lib/deferred-mount.svelte";
import { pointerDrag } from "$lib/drag/pointer-drag.svelte";
import CheckoutReturnHandler from "$lib/features/billing/CheckoutReturnHandler.svelte";
import { startDesktopCommandListener } from "$lib/features/desktop-command/bus";
import GlobalMarkCapture from "$lib/features/preview-mark/ui/GlobalMarkCapture.svelte";
import {
	type DrawerGestureDirection,
	type DrawerGesturePhase,
	getDrawerOffsetFromDrag,
	getRightDrawerOffsetFromDrag,
	MOBILE_DRAWER_WIDTH_PX,
	resolveDrawerGestureDirection,
	shouldKeepDrawerOpen,
	shouldKeepRightDrawerOpen,
	shouldOpenDrawer,
	shouldOpenRightDrawer,
	shouldStartDrawerGesture,
	shouldStartRightDrawerGesture,
} from "$lib/gestures/drawer-swipe";
import { getLocale } from "$lib/i18n/locale.svelte";
import { isComposingKeyboardEvent } from "$lib/keyboard";
import { DESKTOP_SHELL_MIN_WIDTH_PX } from "$lib/layout/breakpoints";
import { DURATION_DRAWER_OUT, DURATION_PANEL } from "$lib/motion.svelte";
import {
	beginMobileSessionViewTransition,
	resolveMobileSessionNavTransition,
} from "$lib/navigation-transition";
import { m } from "$lib/paraglide/messages.js";
import { activateSpaceStyle, deactivateSpaceStyle } from "$lib/space-style";
import { authStore } from "$lib/stores/auth.svelte";
import { initSpacePinRealtime } from "$lib/stores/space-pins.svelte";
import { turnNotifications } from "$lib/stores/turn-notifications.svelte";
import {
	LEFT_SIDEBAR_MAX,
	LEFT_SIDEBAR_MIN,
	LEFT_SIDEBAR_RAIL,
	uiState,
} from "$lib/stores/ui.svelte";
import { installViewportOffsetGuard } from "$lib/viewport-offset-guard";
import { resolveWorkspaceSpaceId } from "$lib/workspace-route";

const VCONSOLE_DISABLED_STORAGE_KEY = "cohub:vconsole-disabled";

const { children } = $props();
const locale = $derived(getLocale());

// Mobile IM-style push: Chats list ↔ session detail.
onNavigate((navigation) => {
	const fromPath = navigation.from?.url.pathname ?? "";
	const toPath = navigation.to?.url.pathname ?? "";
	const kind = resolveMobileSessionNavTransition(fromPath, toPath);
	if (!kind) return;
	return beginMobileSessionViewTransition(kind, navigation);
});

const currentPath = $derived(page.url.pathname);
const sidebarMode = $derived(
	currentPath.startsWith("/settings") ? "settings" : "space",
);
// Per-space layout prefs (sidebar width/collapsed). Workspace space only —
// never sessions-inbox draft targets (those use newChatSpaceId, not spaceId).
const currentLayoutSpaceId = $derived(
	resolveWorkspaceSpaceId({
		pathname: currentPath,
		pageData: page.data as { spaceId?: unknown },
		params: { id: page.params.id },
	}),
);
let showHelpPanel = $state(false);
let authReady = $state(false);

$effect(() => {
	if (!authReady) return;
	const spaceId = currentLayoutSpaceId;
	if (!spaceId) {
		deactivateSpaceStyle();
		return;
	}
	activateSpaceStyle(spaceId);
});

let gesturePhase = $state<DrawerGesturePhase>("idle");
let gestureDirection = $state<DrawerGestureDirection>(null);
let activeTouchId = $state<number | null>(null);
let activeGestureType = $state<"left" | "right" | null>(null);
let pointerStartX = $state(0);
let pointerStartY = $state(0);
let lastPointerX = $state(0);
let lastPointerTime = $state(0);
let dragOffsetPx = $state(0);
let velocityX = $state(0);
let isDragging = $state(false);
let leftSidebarResizeCleanup: (() => void) | null = null;
let vConsole: InstanceType<typeof import("vconsole").default> | null = null;
let vConsoleRequestId = 0;
/**
 * Sidebar content mode lags collapse so the expanded tree can clip away
 * with the width tween instead of hard-swapping to the icon rail first.
 * Expand swaps content immediately so the reveal has real chrome to show.
 */
const leftSidebarExpandedMount = createDeferredMount(
	() => !uiState.leftSidebarCollapsed,
	() => DURATION_PANEL,
);
const leftSidebarContentCollapsed = $derived(!leftSidebarExpandedMount.mounted);
/** True while shell is collapsing and still showing expanded content under clip. */
const leftSidebarCollapsing = $derived(
	uiState.leftSidebarCollapsed && !leftSidebarContentCollapsed,
);
const leftSidebarShellWidth = $derived(
	uiState.leftSidebarCollapsed ? LEFT_SIDEBAR_RAIL : uiState.leftSidebarWidth,
);
const leftSidebarInnerWidth = $derived(
	leftSidebarContentCollapsed ? LEFT_SIDEBAR_RAIL : uiState.leftSidebarWidth,
);

function isEditableShortcutTarget(target: EventTarget | null) {
	if (!(target instanceof HTMLElement)) return false;
	return Boolean(
		target.closest(
			'input, textarea, select, [contenteditable="true"], [contenteditable=""]',
		),
	);
}

function shouldEnableVConsole() {
	if (localStorage.getItem(VCONSOLE_DISABLED_STORAGE_KEY) === "true") {
		return false;
	}

	if (import.meta.env.DEV) return true;

	const hostname = window.location.hostname;
	return (
		hostname === "localhost" ||
		hostname === "127.0.0.1" ||
		hostname.startsWith("dev.") ||
		hostname.startsWith("dev-") ||
		hostname.includes("-dev.")
	);
}

async function enableVConsole() {
	localStorage.removeItem(VCONSOLE_DISABLED_STORAGE_KEY);
	if (vConsole) return;

	const requestId = ++vConsoleRequestId;
	const { default: VConsole } = await import("vconsole");
	const instance = new VConsole({ theme: "dark" });
	if (requestId !== vConsoleRequestId) {
		instance.destroy();
		return;
	}
	vConsole = instance;
}

function disableVConsole() {
	localStorage.setItem(VCONSOLE_DISABLED_STORAGE_KEY, "true");
	vConsoleRequestId += 1;
	vConsole?.destroy();
	vConsole = null;
}

const isDrawerVisible = $derived(
	isDragging || gesturePhase === "settling" || uiState.mobileDrawerOpen,
);
const isRightDrawerVisible = $derived(
	uiState.rightIsDragging ||
		gesturePhase === "settling" ||
		uiState.mobileRightDrawerOpen,
);

function resetGestureState() {
	gesturePhase = "idle";
	gestureDirection = null;
	activeTouchId = null;
	activeGestureType = null;
	pointerStartX = 0;
	pointerStartY = 0;
	lastPointerX = 0;
	lastPointerTime = 0;
	dragOffsetPx = 0;
	uiState.rightDragOffsetPx = 0;
	uiState.rightIsDragging = false;
	velocityX = 0;
	isDragging = false;
}

function beginSettling(open: boolean) {
	gesturePhase = "settling";
	if (activeGestureType === "right") {
		uiState.mobileRightDrawerOpen = open;
	} else {
		uiState.mobileDrawerOpen = open;
	}
	isDragging = false;
	uiState.rightIsDragging = false;
	activeTouchId = null;
	activeGestureType = null;
	gestureDirection = null;
	velocityX = 0;
	lastPointerTime = 0;
	lastPointerX = 0;
	pointerStartX = 0;
	pointerStartY = 0;
}

function findTrackedTouch(touches: TouchList) {
	if (activeTouchId === null) return null;
	for (const touch of Array.from(touches)) {
		if (touch.identifier === activeTouchId) return touch;
	}
	return null;
}

function handleTouchStart(e: TouchEvent) {
	if (window.innerWidth >= DESKTOP_SHELL_MIN_WIDTH_PX || activeTouchId !== null)
		return;
	// A resource drag or the lightbox owns the pointer; drawers must not swipe.
	if (pointerDrag.active || mediaLightbox.open) return;
	const touch = e.changedTouches[0];
	if (!touch) return;

	// Try right drawer first (right edge), then left drawer
	if (
		shouldStartRightDrawerGesture({
			isOpen: uiState.mobileRightDrawerOpen,
			target: e.target,
			viewportWidth: window.innerWidth,
			touchStartX: touch.clientX,
			otherDrawerOpen: uiState.mobileDrawerOpen,
		})
	) {
		activeTouchId = touch.identifier;
		activeGestureType = "right";
		gesturePhase = "tracking";
		gestureDirection = null;
		pointerStartX = touch.clientX;
		pointerStartY = touch.clientY;
		lastPointerX = touch.clientX;
		lastPointerTime = e.timeStamp;
		uiState.rightDragOffsetPx = uiState.mobileRightDrawerOpen
			? MOBILE_DRAWER_WIDTH_PX
			: 0;
		uiState.rightIsDragging = false;
		velocityX = 0;
		isDragging = false;
		return;
	}

	if (
		!shouldStartDrawerGesture({
			isOpen: uiState.mobileDrawerOpen,
			target: e.target,
			viewportWidth: window.innerWidth,
			touchStartX: touch.clientX,
			otherDrawerOpen: uiState.mobileRightDrawerOpen,
		})
	) {
		return;
	}

	activeTouchId = touch.identifier;
	activeGestureType = "left";
	gesturePhase = "tracking";
	gestureDirection = null;
	pointerStartX = touch.clientX;
	pointerStartY = touch.clientY;
	lastPointerX = touch.clientX;
	lastPointerTime = e.timeStamp;
	dragOffsetPx = uiState.mobileDrawerOpen ? MOBILE_DRAWER_WIDTH_PX : 0;
	velocityX = 0;
	isDragging = false;
}

function handleTouchMove(e: TouchEvent) {
	const touch = findTrackedTouch(e.touches);
	if (!touch) return;

	const dx = touch.clientX - pointerStartX;
	const dy = touch.clientY - pointerStartY;
	const absDx = Math.abs(dx);
	const absDy = Math.abs(dy);

	if (gestureDirection === null) {
		const resolvedDirection = resolveDrawerGestureDirection({ absDx, absDy });
		if (resolvedDirection === null) {
			return;
		}
		if (resolvedDirection === "vertical") {
			resetGestureState();
			return;
		}
		gestureDirection = resolvedDirection;
	}

	const deltaTime = Math.max(e.timeStamp - lastPointerTime, 1);
	velocityX = (touch.clientX - lastPointerX) / deltaTime;
	lastPointerX = touch.clientX;
	lastPointerTime = e.timeStamp;

	if (activeGestureType === "right") {
		const nextOffsetPx = getRightDrawerOffsetFromDrag({
			isOpen: uiState.mobileRightDrawerOpen,
			deltaX: dx,
		});

		if (!uiState.mobileRightDrawerOpen && nextOffsetPx <= 0) return;
		if (
			uiState.mobileRightDrawerOpen &&
			nextOffsetPx >= MOBILE_DRAWER_WIDTH_PX &&
			dx <= 0
		)
			return;

		isDragging = true;
		uiState.rightIsDragging = true;
		uiState.rightDragOffsetPx = nextOffsetPx;
		gesturePhase = uiState.mobileRightDrawerOpen
			? "dragging-close"
			: "dragging-open";
	} else {
		const nextOffsetPx = getDrawerOffsetFromDrag({
			isOpen: uiState.mobileDrawerOpen,
			deltaX: dx,
		});

		if (!uiState.mobileDrawerOpen && nextOffsetPx <= 0) return;
		if (
			uiState.mobileDrawerOpen &&
			nextOffsetPx >= MOBILE_DRAWER_WIDTH_PX &&
			dx >= 0
		)
			return;

		isDragging = true;
		dragOffsetPx = nextOffsetPx;
		gesturePhase = uiState.mobileDrawerOpen
			? "dragging-close"
			: "dragging-open";
	}

	if (e.cancelable) {
		e.preventDefault();
	}
}

function finalizeGesture() {
	if (!isDragging) {
		resetGestureState();
		return;
	}

	let shouldOpen: boolean;
	if (activeGestureType === "right") {
		shouldOpen = uiState.mobileRightDrawerOpen
			? shouldKeepRightDrawerOpen({
					offsetPx: uiState.rightDragOffsetPx,
					velocityX,
				})
			: shouldOpenRightDrawer({
					offsetPx: uiState.rightDragOffsetPx,
					velocityX,
				});
	} else {
		shouldOpen = uiState.mobileDrawerOpen
			? shouldKeepDrawerOpen({ offsetPx: dragOffsetPx, velocityX })
			: shouldOpenDrawer({ offsetPx: dragOffsetPx, velocityX });
	}

	beginSettling(shouldOpen);
}

function handleTouchEnd(e: TouchEvent) {
	const touch = findTrackedTouch(e.changedTouches);
	if (!touch) return;
	finalizeGesture();
}

function handleTouchCancel(e: TouchEvent) {
	const touch = findTrackedTouch(e.changedTouches);
	if (!touch) return;
	finalizeGesture();
}

function beginLeftSidebarResize(event: PointerEvent) {
	if (window.innerWidth < DESKTOP_SHELL_MIN_WIDTH_PX) return;
	event.preventDefault();

	const target = event.currentTarget as HTMLElement | null;
	target?.setPointerCapture?.(event.pointerId);
	leftSidebarResizeCleanup?.();

	const startX = event.clientX;
	const startWidth = uiState.leftSidebarWidth;
	const minMainWidth = 640;

	const onPointerMove = (moveEvent: PointerEvent) => {
		const delta = moveEvent.clientX - startX;
		const viewportLimit = window.innerWidth - minMainWidth;
		const nextWidth = Math.min(
			LEFT_SIDEBAR_MAX,
			Math.max(LEFT_SIDEBAR_MIN, Math.min(startWidth + delta, viewportLimit)),
		);
		uiState.setLeftSidebarWidth(nextWidth);
	};

	const stop = () => {
		if (target?.hasPointerCapture?.(event.pointerId)) {
			target.releasePointerCapture(event.pointerId);
		}
		document.body.classList.remove("sidebar-resizing");
		window.removeEventListener("pointermove", onPointerMove);
		window.removeEventListener("pointerup", stop);
		window.removeEventListener("pointercancel", stop);
		if (leftSidebarResizeCleanup === stop) {
			leftSidebarResizeCleanup = null;
		}
	};

	leftSidebarResizeCleanup = stop;
	document.body.classList.add("sidebar-resizing");
	window.addEventListener("pointermove", onPointerMove);
	window.addEventListener("pointerup", stop);
	window.addEventListener("pointercancel", stop);
}

$effect(() => {
	function openHelpPanel() {
		showHelpPanel = true;
	}
	function handleKeydown(e: KeyboardEvent) {
		if (e.defaultPrevented || isComposingKeyboardEvent(e)) return;
		if (e.key === "Escape" && showHelpPanel) {
			e.preventDefault();
			showHelpPanel = false;
			return;
		}
		if (e.key === "?" && !e.altKey && !e.metaKey && !e.ctrlKey) {
			if (isEditableShortcutTarget(e.target)) return;
			e.preventDefault();
			showHelpPanel = true;
			return;
		}
		if (e.ctrlKey && e.altKey && !e.metaKey && !e.shiftKey) {
			if (e.key === "ArrowLeft") {
				e.preventDefault();
				uiState.toggleLeftSidebarCollapsed();
				return;
			}
			if (e.key === "ArrowRight") {
				e.preventDefault();
				uiState.toggleRightSidebarCollapsed();
				return;
			}
		}
	}
	window.addEventListener("cohub:open-help-panel", openHelpPanel);
	window.addEventListener("keydown", handleKeydown, { capture: true });
	return () => {
		window.removeEventListener("cohub:open-help-panel", openHelpPanel);
		window.removeEventListener("keydown", handleKeydown, { capture: true });
	};
});

// Close drawer on Escape
$effect(() => {
	function handleKeydown(e: KeyboardEvent) {
		if (e.key === "Escape") {
			if (uiState.mobileDrawerOpen) uiState.mobileDrawerOpen = false;
			if (uiState.mobileRightDrawerOpen) uiState.mobileRightDrawerOpen = false;
		}
	}
	window.addEventListener("keydown", handleKeydown);
	return () => window.removeEventListener("keydown", handleKeydown);
});

$effect(() => {
	function onTouchStart(e: TouchEvent) {
		handleTouchStart(e);
	}
	function onTouchMove(e: TouchEvent) {
		handleTouchMove(e);
	}
	function onTouchEnd(e: TouchEvent) {
		handleTouchEnd(e);
	}
	function onTouchCancel(e: TouchEvent) {
		handleTouchCancel(e);
	}

	document.addEventListener("touchstart", onTouchStart, { passive: true });
	document.addEventListener("touchmove", onTouchMove, { passive: false });
	document.addEventListener("touchend", onTouchEnd, { passive: true });
	document.addEventListener("touchcancel", onTouchCancel, { passive: true });

	return () => {
		document.removeEventListener("touchstart", onTouchStart);
		document.removeEventListener("touchmove", onTouchMove);
		document.removeEventListener("touchend", onTouchEnd);
		document.removeEventListener("touchcancel", onTouchCancel);
	};
});

// A long-press drag can activate after a drawer gesture already started
// tracking the same finger. The drag wins: drop the tracking so the drawer
// stops following the pointer and only the ghost moves.
$effect(() => {
	if (pointerDrag.active && activeTouchId !== null) resetGestureState();
});

$effect(() => {
	if (gesturePhase !== "settling") return;

	const timer = window.setTimeout(() => {
		if (gesturePhase === "settling") {
			gesturePhase = "idle";
			if (!uiState.mobileRightDrawerOpen) uiState.rightDragOffsetPx = 0;
			if (!uiState.mobileDrawerOpen) dragOffsetPx = 0;
		}
	}, DURATION_DRAWER_OUT);

	return () => window.clearTimeout(timer);
});

$effect(() => {
	uiState.loadLayoutPrefs(currentLayoutSpaceId);
	turnNotifications.syncActiveSessionPresence();
});

// Lock body scroll when drawer is open
$effect(() => {
	if (
		uiState.mobileDrawerOpen ||
		uiState.mobileRightDrawerOpen ||
		isDragging ||
		uiState.rightIsDragging
	) {
		document.body.classList.add("drawer-open");
	} else {
		document.body.classList.remove("drawer-open");
	}
});

onMount(() => {
	window.cohubDisableVConsole = disableVConsole;
	window.cohubEnableVConsole = enableVConsole;

	if (shouldEnableVConsole()) {
		void enableVConsole();
	}

	let stopDesktopCommands: (() => void) | null = null;
	const stopViewportOffsetGuard = installViewportOffsetGuard();

	void authStore.ensureLoaded().finally(() => {
		authReady = true;
		scheduleCacheCleanup();
		if (authStore.isAuthenticated) {
			turnNotifications.start();
			// Listen in the shell, not a page, so delivery never depends on route.
			stopDesktopCommands = startDesktopCommandListener();
		}
		initSpacePinRealtime();
	});

	// Register PWA Service Worker (conservative update: closes all tabs to activate)
	if ("serviceWorker" in navigator) {
		window.addEventListener("load", () => {
			void navigator.serviceWorker.register("/sw.js");
		});
	}

	return () => {
		delete window.cohubDisableVConsole;
		delete window.cohubEnableVConsole;
		stopDesktopCommands?.();
		stopViewportOffsetGuard();
		turnNotifications.stop();
		vConsoleRequestId += 1;
		vConsole?.destroy();
		vConsole = null;
		leftSidebarResizeCleanup?.();
		document.body.classList.remove("sidebar-resizing");
	};
});

// Mobile session action sheet was intentionally removed; current item actions live
// on hover for desktop sidebars and in the session/file headers for mobile.
</script>

<svelte:head>
	<link rel="icon" href="/favicon.svg" type="image/svg+xml" />
	<link rel="apple-touch-icon" href="/pwa/icon-192x192.png" />
</svelte:head>

{#if !authReady}
  <main class="app-shell h-full text-text-primary">
    <CenteredLoading label={m.shell_loading({}, { locale })} size="page" />
  </main>
{:else}
  <div class="app-shell h-full min-h-0 overflow-hidden flex flex-col lg:flex-row text-text-primary font-sans text-[13px] leading-[1.6]">
    <!-- Desktop sidebar — hidden on mobile -->
    <!-- z-30 keeps collapsed rail flyouts above main workspace stacking contexts.
         Width-only panel-shell: the icon rail stays interactive (no --collapsed). -->
    <div
      class="panel-shell hidden lg:flex relative z-30 {leftSidebarContentCollapsed ? 'panel-shell--overflow-visible' : ''} {leftSidebarCollapsing ? 'panel-shell--inert' : ''}"
      style={`width: ${leftSidebarShellWidth}px`}
      inert={leftSidebarCollapsing ? true : undefined}
    >
      <div
        class="panel-shell-inner relative {leftSidebarContentCollapsed ? 'overflow-visible' : 'overflow-hidden'} {!leftSidebarContentCollapsed ? 'border-r border-[color:var(--sidebar-border)]' : ''}"
        style={`width: ${leftSidebarInnerWidth}px`}
      >
        <Sidebar mode={sidebarMode} collapsed={leftSidebarContentCollapsed} />
        {#if !leftSidebarContentCollapsed}
          <button
            type="button"
            class="sidebar-resize-handle"
            aria-label={m.nav_resize_sidebar({}, { locale })}
            title={m.nav_resize_sidebar({}, { locale })}
            onpointerdown={beginLeftSidebarResize}
          ></button>
        {/if}
      </div>
    </div>

    <!-- Main content area — named VT surface only while session nav is active -->
    <main class="flex-1 min-h-0 flex flex-col min-w-0 overflow-hidden mobile-drawer-gesture-surface mobile-session-vt-surface">

      <!-- Page content -->
      <div class="flex-1 min-h-0 flex flex-col min-w-0 overflow-hidden">
        {@render children?.()}
      </div>
    </main>
  </div>

  <!-- Mobile left drawer — outside flex container to avoid stacking context issues -->
  <MobileSidebarDrawer
    dragOffsetPx={dragOffsetPx}
    {isDragging}
    {isDrawerVisible}
    mode={sidebarMode}
  />

  <!-- Global media lightbox -->
  <MediaLightbox />
  <CommandPalette />
  <DragGhostLayer />
  <HelpPanel open={showHelpPanel} onClose={() => { showHelpPanel = false; }} />
  <BillingConversionCenter />
  <CheckoutReturnHandler />
  <TurnNotificationStack />
  <GlobalMarkCapture />

{/if}

<style>
  .sidebar-resize-handle {
    position: absolute;
    top: 0;
    right: -4px;
    bottom: 0;
    width: 8px;
    border: none;
    padding: 0;
    cursor: col-resize;
    background: transparent;
    touch-action: none;
    z-index: 10;
  }

  .sidebar-resize-handle::after {
    content: "";
    position: absolute;
    top: 0;
    right: 3px;
    width: 2px;
    height: 100%;
    background: transparent;
    transition: background-color 120ms ease;
  }

  .sidebar-resize-handle:hover::after,
  :global(body.sidebar-resizing) .sidebar-resize-handle::after {
    background: var(--border-subtle);
  }
</style>
