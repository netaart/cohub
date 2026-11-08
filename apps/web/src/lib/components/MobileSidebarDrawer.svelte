<script lang="ts">
import { dismissOnBack } from "$lib/back-layers.svelte";
import Sidebar from "$lib/components/Sidebar.svelte";
import {
	getDrawerOpenRatio,
	MOBILE_DRAWER_MAX_WIDTH_VW,
	MOBILE_DRAWER_WIDTH_PX,
} from "$lib/gestures/drawer-swipe";
import { DURATION_DRAWER_OUT, drawerTransition } from "$lib/motion";
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

const openRatio = $derived(getDrawerOpenRatio(dragOffsetPx));
const interactive = $derived(isDragging || uiState.mobileDrawerOpen);

const transition = $derived(drawerTransition(uiState.mobileDrawerOpen));

const panelStyle = $derived.by(() => {
	if (isDragging) {
		const offset = MOBILE_DRAWER_WIDTH_PX - dragOffsetPx;
		return `transform: translateX(-${offset}px); transition: none; pointer-events: auto;`;
	}
	if (uiState.mobileDrawerOpen) {
		return `transform: translateX(0); transition: ${transition.panel}; pointer-events: auto;`;
	}
	return `transform: translateX(-${MOBILE_DRAWER_WIDTH_PX}px); transition: ${transition.panel}; pointer-events: none;`;
});

const backdropStyle = $derived.by(() => {
	if (isDragging) {
		return `opacity: ${openRatio * 0.5}; transition: none; pointer-events: auto;`;
	}
	if (uiState.mobileDrawerOpen) {
		return `opacity: 0.5; transition: ${transition.backdrop}; pointer-events: auto;`;
	}
	return `opacity: 0; transition: ${transition.backdrop}; pointer-events: none;`;
});

function closeDrawer() {
	uiState.mobileDrawerOpen = false;
}

dismissOnBack(() => uiState.mobileDrawerOpen, closeDrawer);

let renderContent = $state(false);

$effect(() => {
	if (isDrawerVisible) {
		renderContent = true;
		return;
	}

	const timer = window.setTimeout(() => {
		renderContent = false;
	}, DURATION_DRAWER_OUT);
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
      <div class="safe-area-top h-full border-r border-border-subtle bg-bg-primary" class:pointer-events-auto={interactive}>
        <Sidebar isMobile area="spaces" onClose={closeDrawer} />
      </div>
    {/if}
  </div>
</div>
