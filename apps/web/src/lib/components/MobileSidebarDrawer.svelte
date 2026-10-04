<script lang="ts">
import Sidebar from "$lib/components/Sidebar.svelte";
import {
	getDrawerOpenRatio,
	MOBILE_DRAWER_MAX_WIDTH_VW,
	MOBILE_DRAWER_WIDTH_PX,
} from "$lib/gestures/drawer-swipe";
import {
	DURATION_DRAWER_IN,
	DURATION_DRAWER_OUT,
	EASE_IN,
	EASE_OUT,
} from "$lib/motion.svelte";
import { uiState } from "$lib/stores/ui.svelte";

const {
	dragOffsetPx = 0,
	isDragging = false,
	isDrawerVisible = false,
}: {
	dragOffsetPx?: number;
	isDragging?: boolean;
	isDrawerVisible?: boolean;
} = $props();

const TRANSITION_CSS = `transform ${DURATION_DRAWER_IN}ms ${EASE_OUT}`;
const CLOSE_TRANSITION_CSS = `transform ${DURATION_DRAWER_OUT}ms ${EASE_IN}`;
const BACKDROP_TRANSITION_CSS = `opacity ${DURATION_DRAWER_IN}ms ${EASE_OUT}`;
const CLOSE_BACKDROP_TRANSITION_CSS = `opacity ${DURATION_DRAWER_OUT}ms ${EASE_IN}`;
const TRANSITION_DURATION_MS = DURATION_DRAWER_OUT;

const openRatio = $derived(getDrawerOpenRatio(dragOffsetPx));
const interactive = $derived(isDragging || uiState.mobileDrawerOpen);

const panelStyle = $derived.by(() => {
	if (isDragging) {
		const offset = MOBILE_DRAWER_WIDTH_PX - dragOffsetPx;
		return `transform: translateX(-${offset}px); transition: none; pointer-events: auto;`;
	}
	if (uiState.mobileDrawerOpen) {
		return `transform: translateX(0); transition: ${TRANSITION_CSS}; pointer-events: auto;`;
	}
	return `transform: translateX(-${MOBILE_DRAWER_WIDTH_PX}px); transition: ${CLOSE_TRANSITION_CSS}; pointer-events: none;`;
});

const backdropStyle = $derived.by(() => {
	if (isDragging) {
		return `opacity: ${openRatio * 0.5}; transition: none; pointer-events: auto;`;
	}
	if (uiState.mobileDrawerOpen) {
		return `opacity: 0.5; transition: ${BACKDROP_TRANSITION_CSS}; pointer-events: auto;`;
	}
	return `opacity: 0; transition: ${CLOSE_BACKDROP_TRANSITION_CSS}; pointer-events: none;`;
});

function closeDrawer() {
	uiState.mobileDrawerOpen = false;
}

let renderContent = $state(false);

$effect(() => {
	if (isDrawerVisible) {
		renderContent = true;
		return;
	}

	const timer = window.setTimeout(() => {
		renderContent = false;
	}, TRANSITION_DURATION_MS);
	return () => window.clearTimeout(timer);
});
</script>

<!-- Mobile sidebar drawer — always mounted, visibility controlled via CSS -->
<div
  class="lg:hidden fixed inset-0 z-50"
  style="pointer-events: none;"
  aria-hidden={!isDrawerVisible}
>
  <!-- Backdrop -->
  <div
    class="absolute inset-0 bg-overlay-scrim"
    style={backdropStyle}
    aria-hidden="true"
    onclick={closeDrawer}
  ></div>

  <!-- Drawer panel -->
  <div
    class="absolute inset-y-0 left-0 mobile-drawer-gesture-surface"
    style="width: {MOBILE_DRAWER_WIDTH_PX}px; max-width: {MOBILE_DRAWER_MAX_WIDTH_VW}vw; {panelStyle}"
  >
    {#if renderContent}
      <div class="h-full border-r border-border-subtle bg-bg-primary" class:pointer-events-auto={interactive}>
        <Sidebar isMobile area="spaces" onClose={closeDrawer} />
      </div>
    {/if}
  </div>
</div>
